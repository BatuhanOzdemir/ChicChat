// Never read .env.local: this utility may only prepare an explicitly isolated local test DB.
import { readFile, readdir } from "node:fs/promises";
import { Client } from "pg";
const uri = process.env.DATABASE_URL;
if (!uri)
  throw new Error("Set DATABASE_URL explicitly to a local *_test database");
const url = new URL(uri);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !url.pathname.endsWith("_test")
) {
  throw new Error("Refusing to prepare a non-local or non-test database");
}
const db = new Client({ connectionString: uri });
await db.connect();
try {
  await db.query(
    "create table if not exists _test_migrations (name text primary key)",
  );
  for (const name of (await readdir("supabase/migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    if (
      (await db.query("select 1 from _test_migrations where name=$1", [name]))
        .rowCount
    )
      continue;
    await db.query("begin");
    try {
      await db.query(await readFile(`supabase/migrations/${name}`, "utf8"));
      await db.query("insert into _test_migrations values ($1)", [name]);
      await db.query("commit");
      console.log(`Applied ${name}`);
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  }
} finally {
  await db.end();
}
