import { randomUUID } from "node:crypto";
import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  expect,
  it,
} from "vitest";
import { Pool } from "pg";
import { poolDatabase, type Database } from "./database";
import { handleInbound } from "@/server/whatsapp/handler";
import { runSessionMaintenance } from "@/server/maintenance/sessions";
import { acceptMessages, processInbox } from "@/server/whatsapp/inbox";
import { eraseCustomer, enforceRetention } from "./privacy";
import { listCases, getCaseDetail, caseCounters } from "./case-queries";
import { buildHandoff } from "./cases";
import { listQueue } from "./console";
import { parseCaseFilters } from "@/lib/cases/filters";
import { sessionPrincipal, login } from "./auth";
import { hashPassword, tokenHash } from "@/server/auth/credentials";
import { savePhoto, casePhoto } from "./media";
import { runSimulatorAction } from "@/server/simulator/service";
import { retryReplies } from "@/server/whatsapp/outbox";
import type { InboundMessage, OutboundMessage } from "@/lib/whatsapp";

// These concurrency tests commit real transactions, so only a disposable local DB is allowed.
const uri = process.env.DATABASE_URL ?? "";
const safe =
  /^postgres(?:ql)?:\/\/[^@]+@(?:127\.0\.0\.1|localhost):\d+\/\w+_test$/.test(
    uri,
  );
describe.skipIf(!safe)(
  "September repair gates (independent PostgreSQL connections)",
  () => {
    const pool = new Pool({ connectionString: uri, max: 8 });
    const db = poolDatabase(pool);
    let merchant: string;
    let category: string;
    let other: string;
    const phone = "905550009876";
    const quiet = { info() {}, warn() {}, error() {} };
    const noSend = async () => {};
    const input = (
      reply: string,
      id: string = randomUUID(),
    ): InboundMessage => ({
      from: phone,
      phoneNumberId: "test",
      messageId: id,
      kind: "text",
      reply,
    });
    const say = (
      reply: string,
      send: (m: OutboundMessage) => Promise<void> = noSend,
      id?: string,
    ) => handleInbound({ db, send, logger: quiet }, merchant, input(reply, id));
    const filters = () => {
      const parsed = parseCaseFilters({});
      if (!parsed.ok) throw new Error("bad filters");
      return parsed.value;
    };
    async function start() {
      await say("hello");
      await say("repair");
    }
    async function finish() {
      await start();
      await say("alpha");
      return (await say("beta")).persistedCaseId!;
    }
    beforeAll(async () => {
      await pool.query("select 1");
    });
    beforeEach(async () => {
      merchant = randomUUID();
      other = randomUUID();
      category = randomUUID();
      await pool.query(
        "insert into merchants(id,name) values ($1,'Repair gate'),($2,'Isolation gate')",
        [merchant, other],
      );
      await pool.query(
        "insert into merchant_config(merchant_id) values ($1),($2)",
        [merchant, other],
      );
      await pool.query(
        "insert into categories(id,merchant_id,key,label) values ($1,$2,'repair','Repair category')",
        [category, merchant],
      );
      await pool.query(
        `insert into field_defs(category_id,key,type,required,sort_order,normalize_rule)
      values ($1,'first','string',true,1,'order_number'),($1,'second','string',true,2,null)`,
        [category],
      );
    });
    afterEach(async () => {
      await pool.query("delete from console_users where username=$1", [
        merchant,
      ]);
      await pool.query("delete from console_login_attempts where username=$1", [
        merchant,
      ]);
      await pool.query("delete from merchants where id=any($1)", [
        [merchant, other],
      ]);
    });
    afterAll(async () => {
      await pool.end();
    });

    it("serializes different simultaneous answers without losing progress or creating two cases", async () => {
      await start();
      await Promise.all([say("alpha"), say("beta")]);
      const { rows } = await pool.query(
        "select id from cases where merchant_id=$1",
        [merchant],
      );
      expect(rows).toHaveLength(1);
      const handoff = await buildHandoff(db, rows[0].id);
      expect(
        new Set(Object.values(handoff.fields).map((x) => x?.toLowerCase())),
      ).toEqual(new Set(["alpha", "beta"]));
      expect(
        (
          await pool.query(
            "select 1 from intake_sessions where merchant_id=$1",
            [merchant],
          )
        ).rowCount,
      ).toBe(0);
    });

    it("retries a failed reply on duplicate delivery without advancing twice", async () => {
      const id = randomUUID();
      expect(
        (
          await say(
            "hello",
            async () => {
              throw new Error("temporary transport failure");
            },
            id,
          )
        ).failed,
      ).toBe(true);
      const sent: OutboundMessage[] = [];
      expect(
        (
          await say(
            "hello",
            async (m) => {
              sent.push(m);
            },
            id,
          )
        ).duplicate,
      ).toBe(true);
      expect(sent).toHaveLength(1);
      expect(
        (
          await pool.query(
            "select 1 from processed_messages where merchant_id=$1",
            [merchant],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await pool.query(
            "select 1 from message_outbox where merchant_id=$1 and delivered_at is null",
            [merchant],
          )
        ).rowCount,
      ).toBe(0);
    });

    it("refuses simulator reset when a number has real accepted WhatsApp work", async () => {
      await acceptMessages(db, [
        { merchantId: merchant, inbound: input("hello") },
      ]);
      const result = await runSimulatorAction(db, {
        action: "reset",
        merchantId: merchant,
        phone,
      });
      expect(result.error).toContain("real WhatsApp activity");
      expect(
        (
          await pool.query("select 1 from message_inbox where merchant_id=$1", [
            merchant,
          ])
        ).rowCount,
      ).toBe(1);
    });

    it("does not let deferred conversations starve later due inbox and outbox work", async () => {
      await pool.query(
        `insert into message_inbox(merchant_id,customer_wa_id,message_id,payload,next_attempt_at)
        select $1, '9055511'||n, 'deferred-in-'||n, '{}',now()+interval '1 hour' from generate_series(1,100) n`,
        [merchant],
      );
      await acceptMessages(db, [
        { merchantId: merchant, inbound: input("hello") },
      ]);
      const result = await processInbox(db, noSend);
      expect(result.processed).toBe(1);
      await pool.query(
        `insert into message_outbox(merchant_id,customer_wa_id,delivery_key,delivery_channel,payload,next_attempt_at)
        select $1, '9055522'||n, 'deferred-out-'||n, 'whatsapp', '{}',now()+interval '1 hour' from generate_series(1,100) n`,
        [merchant],
      );
      await handleInbound(
        {
          db,
          send: noSend,
          logger: quiet,
          channel: "whatsapp",
          deferDelivery: true,
        },
        merchant,
        { ...input("hello"), from: "905553339999" },
      );
      expect((await retryReplies(db, noSend)).sent).toBe(1);
    });

    it("accepts durable work once and processes it in order across concurrent workers", async () => {
      const items = ["hello", "repair", "alpha", "beta"].map((reply) => ({
        merchantId: merchant,
        inbound: input(reply),
      }));
      await acceptMessages(db, items);
      await acceptMessages(db, items);
      expect(
        (
          await pool.query("select 1 from message_inbox where merchant_id=$1", [
            merchant,
          ])
        ).rowCount,
      ).toBe(4);
      await Promise.all([processInbox(db, noSend), processInbox(db, noSend)]);
      const { rows } = await pool.query(
        "select id from cases where merchant_id=$1",
        [merchant],
      );
      expect(rows).toHaveLength(1);
      expect((await buildHandoff(db, rows[0].id)).fields).toEqual({
        first: "ALPHA",
        second: "beta",
      });
      expect(
        (
          await pool.query(
            "select 1 from message_inbox where merchant_id=$1 and processed_at is null",
            [merchant],
          )
        ).rowCount,
      ).toBe(0);
    });

    it("nudges once even after resumption and a second idle period", async () => {
      await start();
      const sent: OutboundMessage[] = [];
      const deps = {
        db,
        logger: quiet,
        send: async (_: string, m: OutboundMessage) => {
          sent.push(m);
        },
      };
      await pool.query(
        "update intake_sessions set updated_at=now()-interval '6 minutes' where merchant_id=$1",
        [merchant],
      );
      await Promise.all([
        runSessionMaintenance(deps, new Date(), merchant),
        runSessionMaintenance(deps, new Date(), merchant),
      ]);
      expect(sent).toHaveLength(1);
      await say("alpha");
      await pool.query(
        "update intake_sessions set updated_at=now()-interval '6 minutes' where merchant_id=$1",
        [merchant],
      );
      await runSessionMaintenance(deps, new Date(), merchant);
      expect(sent).toHaveLength(1);
    });

    it("rolls abandonment back on a delete failure and prevents duplicate abandoned cases", async () => {
      await start();
      await say("alpha");
      await pool.query(
        "update intake_sessions set updated_at=now()-interval '25 hours' where merchant_id=$1",
        [merchant],
      );
      const broken: Database = {
        ...db,
        transaction: (work) =>
          db.transaction((tx) =>
            work({
              query: (sql, values) => {
                if (sql.includes("delete from intake_sessions"))
                  throw new Error("injected deletion failure");
                return tx.query(sql, values);
              },
            }),
          ),
      };
      await runSessionMaintenance(
        { db: broken, send: noSend, logger: quiet },
        new Date(),
        merchant,
      );
      expect(
        (
          await pool.query("select 1 from cases where merchant_id=$1", [
            merchant,
          ])
        ).rowCount,
      ).toBe(0);
      await Promise.all(
        [1, 2].map(() =>
          runSessionMaintenance(
            { db, send: noSend, logger: quiet },
            new Date(),
            merchant,
          ),
        ),
      );
      expect(
        (
          await pool.query(
            "select 1 from cases where merchant_id=$1 and status='abandoned'",
            [merchant],
          )
        ).rowCount,
      ).toBe(1);
    });

    it("keeps case history, filters, counters, queue and media after category deletion", async () => {
      const id = await finish();
      await pool.query(
        "update field_defs set type='media' where category_id=$1 and key='second'",
        [category],
      );
      await pool.query("delete from categories where id=$1", [category]);
      expect((await getCaseDetail(db, merchant, id))?.category_label).toBe(
        "Repair category",
      );
      expect((await buildHandoff(db, id)).fields).toEqual({
        first: "ALPHA",
        second: "beta",
      });
      expect(
        (
          await listCases(db, merchant, {
            ...filters(),
            categoryKey: "repair",
            orderNumber: "ALPHA",
          })
        ).total,
      ).toBe(1);
      expect(
        await listQueue(db, merchant, {
          queue: null,
          categoryKey: "repair",
          status: null,
        }),
      ).toHaveLength(1);
      expect(
        (await caseCounters(db, merchant)).byCategory[0].category_key,
      ).toBe("repair");
    });

    it("erases all customer data and pending work without touching another tenant", async () => {
      await finish();
      await say("hello", async () => {
        throw new Error("offline");
      });
      await acceptMessages(db, [
        { merchantId: merchant, inbound: input("pending") },
      ]);
      await savePhoto(db, merchant, phone, "media", {
        content: Buffer.from("photo"),
        mimeType: "image/png",
      });
      await pool.query(
        "insert into conversation_messages(merchant_id,customer_wa_id,direction,kind,body) values ($1,$2,'inbound','text','keep')",
        [other, phone],
      );
      await eraseCustomer(db, merchant, phone);
      for (const table of [
        "cases",
        "intake_sessions",
        "processed_messages",
        "conversation_messages",
        "conversation_media",
        "message_inbox",
        "message_outbox",
      ]) {
        expect(
          (
            await pool.query(
              `select 1 from ${table} where merchant_id=$1 and customer_wa_id=$2`,
              [merchant, phone],
            )
          ).rowCount,
          table,
        ).toBe(0);
      }
      await processInbox(db, noSend);
      expect(
        (
          await pool.query(
            "select 1 from conversation_messages where merchant_id=$1",
            [other],
          )
        ).rowCount,
      ).toBe(1);
    });

    it("retains newer cases for a phone while deleting expired records and orphan transcripts", async () => {
      const old = await finish();
      const fresh = await finish();
      await pool.query(
        "update cases set created_at=now()-interval '13 months' where id=$1",
        [old],
      );
      await pool.query(
        "insert into conversation_messages(merchant_id,customer_wa_id,direction,kind,body,created_at) values ($1,$2,'inbound','text','old orphan',now()-interval '13 months')",
        [merchant, phone],
      );
      await enforceRetention(db);
      expect(await getCaseDetail(db, merchant, old)).toBeNull();
      expect(await getCaseDetail(db, merchant, fresh)).not.toBeNull();
      expect(
        (
          await pool.query(
            "select 1 from conversation_messages where merchant_id=$1 and (case_id=$2 or body='old orphan')",
            [merchant, old],
          )
        ).rowCount,
      ).toBe(0);
    });

    it("uses opaque sessions, scopes memberships, rejects tampering and respects revocation", async () => {
      const user = randomUUID();
      await pool.query(
        "insert into console_users(id,username,password_hash) values ($1,$2,$3)",
        [user, merchant, await hashPassword("correct-test-password")],
      );
      await pool.query("insert into console_memberships values ($1,$2)", [
        user,
        merchant,
      ]);
      expect(await login(db, merchant, "wrong-password")).toBeNull();
      const token = (await login(db, merchant, "correct-test-password"))!;
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect((await sessionPrincipal(db, token))?.merchantIds).toEqual([
        merchant,
      ]);
      expect(await sessionPrincipal(db, token.slice(0, 63) + "z")).toBeNull();
      await pool.query(
        "update console_sessions set expires_at=now()-interval '1 second' where token_hash=$1",
        [tokenHash(token)],
      );
      expect(await sessionPrincipal(db, token)).toBeNull();
      const next = (await login(db, merchant, "correct-test-password"))!;
      await pool.query("update console_users set enabled=false where id=$1", [
        user,
      ]);
      expect(await sessionPrincipal(db, next)).toBeNull();
    });

    it("makes stored evidence accessible only to its owning merchant and erases it with the case", async () => {
      await start();
      await savePhoto(db, merchant, phone, "photo-1", {
        content: Buffer.from("test image"),
        mimeType: "image/png",
      });
      await say("alpha");
      const id = (await say("beta")).persistedCaseId!;
      expect(
        (await casePhoto(db, merchant, id, "photo-1"))?.content.toString(),
      ).toBe("test image");
      expect(await casePhoto(db, other, id, "photo-1")).toBeNull();
      await eraseCustomer(db, merchant, phone);
      expect(await casePhoto(db, merchant, id, "photo-1")).toBeNull();
    });
  },
);
