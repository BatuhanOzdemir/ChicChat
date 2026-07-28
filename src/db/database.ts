/**
 * Database access contracts (Handbook §2/§6).
 *
 * `Queryable` is the minimal query surface every data function takes, so the
 * code under test never depends on a driver. `Database` adds real transactions
 * — required because multi-record writes must be atomic (Handbook §6) and a
 * connection pool cannot express BEGIN/COMMIT through `pool.query`.
 */

/** Minimal query surface — pg's Client/Pool satisfy this structurally. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface Database extends Queryable {
  /**
   * Run `work` inside a transaction on a single connection. Commits on success,
   * rolls back on any thrown error, and always releases the connection.
   */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

/** A pool-like object: `pg.Pool` satisfies this. */
interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release: (destroy?: boolean) => void }>;
}

export function poolDatabase(pool: PoolLike): Database {
  return {
    query: (text, values) => pool.query(text, values),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await work(client);
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => {
          // The connection is already broken; releasing it is all we can do.
        });
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

let savepointCounter = 0;

/**
 * Single-connection variant used by integration tests, which already wrap each
 * test in a transaction. Nested BEGIN is a no-op in Postgres, so this uses a
 * savepoint to get real rollback semantics inside the outer transaction.
 */
export function clientDatabase(client: Queryable): Database {
  return {
    query: (text, values) => client.query(text, values),
    async transaction(work) {
      const name = `sp_${++savepointCounter}`;
      await client.query(`savepoint ${name}`);
      try {
        const result = await work(client);
        await client.query(`release savepoint ${name}`);
        return result;
      } catch (err) {
        await client.query(`rollback to savepoint ${name}`);
        throw err;
      }
    },
  };
}
