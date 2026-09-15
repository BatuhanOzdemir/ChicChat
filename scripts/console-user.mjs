// Provision explicitly named accounts. No .env file is implicitly loaded.
import { randomBytes, scryptSync } from "node:crypto";
import { Client } from "pg";
const [username, ...merchantIds] = process.argv.slice(2);
const password = process.env.CHICCHAT_USER_PASSWORD;
if (
  !process.env.DATABASE_URL ||
  !username ||
  !/^[a-z0-9_.@-]{1,100}$/.test(username) ||
  !password ||
  password.length < 12 ||
  password.length > 1024 ||
  !merchantIds.length
) {
  throw new Error(
    "Usage: set DATABASE_URL and CHICCHAT_USER_PASSWORD (12+ chars); node scripts/console-user.mjs username merchant-uuid [...]",
  );
}
const salt = randomBytes(16).toString("hex");
const hash = `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query("begin");
  const { rows } = await db.query(
    `insert into console_users(username,password_hash) values ($1,$2)
    on conflict (username) do update set password_hash=excluded.password_hash, enabled=true returning id`,
    [username, hash],
  );
  const id = rows[0].id;
  await db.query("delete from console_memberships where user_id=$1", [id]);
  for (const merchantId of new Set(merchantIds))
    await db.query("insert into console_memberships values ($1,$2)", [
      id,
      merchantId,
    ]);
  await db.query("delete from console_sessions where user_id=$1", [id]);
  await db.query("delete from console_login_attempts where username=$1", [
    username,
  ]);
  await db.query("commit");
  console.log("Account provisioned; previous sessions revoked.");
} catch (err) {
  await db.query("rollback");
  throw err;
} finally {
  await db.end();
}
