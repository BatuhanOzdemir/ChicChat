import { randomBytes } from "node:crypto";
import { tokenHash, verifyPassword } from "@/server/auth/credentials";
import type { Database, Queryable } from "./database";

export interface Principal {
  id: string;
  username: string;
  merchantIds: string[];
}

export async function sessionPrincipal(
  db: Queryable,
  token?: string,
): Promise<Principal | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows } = await db.query(
    `select u.id, u.username,
    coalesce(array_agg(m.merchant_id) filter (where m.merchant_id is not null), '{}') as "merchantIds"
    from console_sessions s join console_users u on u.id=s.user_id
    left join console_memberships m on m.user_id=u.id
    where s.token_hash=$1 and s.expires_at>now() and u.enabled group by u.id`,
    [tokenHash(token)],
  );
  return (rows[0] as Principal | undefined) ?? null;
}

/** Per-account throttle is transactional across instances, including nonexistent accounts. */
export async function login(
  db: Database,
  username: string,
  password: string,
): Promise<string | null> {
  username = username.trim().toLowerCase();
  if (!/^[a-z0-9_.@-]{1,100}$/.test(username) || password.length > 1024)
    return null;
  const allowed = await db.transaction(async (tx) => {
    const { rows } = await tx.query(
      `insert into console_login_attempts (username, attempts) values ($1,1)
      on conflict (username) do update set
      attempts=case when console_login_attempts.window_started_at < now()-interval '15 minutes' then 1 else console_login_attempts.attempts+1 end,
      window_started_at=case when console_login_attempts.window_started_at < now()-interval '15 minutes' then now() else console_login_attempts.window_started_at end
      returning attempts`,
      [username],
    );
    return (rows[0] as { attempts: number }).attempts <= 10;
  });
  if (!allowed) return null;
  const { rows } = await db.query(
    "select id, password_hash from console_users where username=$1 and enabled",
    [username],
  );
  const user = rows[0] as { id: string; password_hash: string } | undefined;
  const hash =
    user?.password_hash ?? `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`;
  if (!(await verifyPassword(password, hash)) || !user) return null;
  const token = randomBytes(32).toString("hex");
  await db.query(
    "insert into console_sessions (token_hash,user_id,expires_at) values ($1,$2,now()+interval '12 hours')",
    [tokenHash(token), user.id],
  );
  return token;
}
