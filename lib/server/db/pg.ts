/**
 * PostgreSQL access layer for the courseware backend — the ONE database.
 *
 * The teacher backend shares the agent runtime's `DATABASE_URL` pool (through
 * `getServerPersistenceProvider`, which memoizes one `pg` Pool per connection
 * string), so a deployment needs exactly one database. `ensureCoursewareDatabase`
 * is the single bootstrap entry: it applies the idempotent schema and seeds the
 * first admin account. Every repo/route calls it (a memoized promise, so the
 * cost is paid once) before touching the pool — this mirrors the storage
 * package's lazy-initialization posture and keeps `instrumentation.register()`
 * non-blocking.
 */
import type { Pool, PoolClient } from 'pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { COURSEWARE_SCHEMA_SQL } from './schema';
import { hashPassword } from './password';

let readyPool: Pool | undefined;
let readyPromise: Promise<Pool> | undefined;

const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.TEACHER_BOOTSTRAP_PASSWORD || 'Admin@123456';

/**
 * The shared connection string. `DATABASE_URL` wins; the development fallback
 * matches docker-compose's postgres service so a fresh checkout works with
 * `docker compose up postgres` and no env file. Production (e.g. Vercel +
 * Neon) must set `DATABASE_URL`.
 */
function coursewareConnectionString(): string {
  return (
    process.env.DATABASE_URL?.trim() || 'postgres://openmaic:openmaic-dev@127.0.0.1:5432/openmaic'
  );
}

/**
 * One thin client shape for the whole courseware layer: `query` resolves rows
 * directly (no driver result object), `execute` resolves the affected row
 * count. Transactions hand the same shape to their callback so repo code is
 * identical inside and outside a transaction.
 */
export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Statement returning rows affects — resolves the affected row count. */
  execute(sql: string, params?: unknown[]): Promise<number>;
}

function wrapClient(client: PoolClient | Pool): DbClient {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await client.query(sql, params as never[]);
      return result.rows as T[];
    },
    async execute(sql: string, params: unknown[] = []): Promise<number> {
      const result = await client.query(sql, params as never[]);
      return result.rowCount ?? 0;
    },
  };
}

async function seedDefaultAdmin(db: DbClient): Promise<void> {
  const rows = await db.query<{ id: string }>(
    'SELECT id FROM teachers ORDER BY created_at ASC LIMIT 1',
  );
  if (rows.length > 0) return;
  const id = `tch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  // ON CONFLICT keeps parallel cold starts (multiple workers racing the same
  // empty table) from failing on the username unique index — exactly one
  // insert wins, the losers no-op.
  const inserted = await db.execute(
    'INSERT INTO teachers (id, username, password_hash, display_name, role, created_at, updated_at) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (username) DO NOTHING',
    [
      id,
      DEFAULT_ADMIN_USERNAME,
      await hashPassword(DEFAULT_ADMIN_PASSWORD),
      'Administrator',
      'admin',
      now,
      now,
    ],
  );
  if (inserted > 0) {
    console.log(
      `[courseware] Seeded default teacher account "${DEFAULT_ADMIN_USERNAME}" ` +
        '(password from TEACHER_BOOTSTRAP_PASSWORD, default "Admin@123456" — change it after first login)',
    );
  }
}

/**
 * Apply the schema and seed the first admin. Safe to call concurrently; the
 * memoized promise collapses repeated calls. A failure resets the memo so the
 * next call retries, and the first attempt retries once: parallel cold starts
 * (multiple workers, several test files) can race on catalog locks or the
 * seed row while the idempotent DDL runs; a replay always succeeds.
 */
export function ensureCoursewareDatabase(): Promise<Pool> {
  readyPromise ??= (async () => {
    const bootstrap = async (): Promise<Pool> => {
      const { pool } = await getServerPersistenceProvider(coursewareConnectionString());
      // The DDL is a plain multi-statement string with no parameters, so it
      // rides pg's simple-query protocol in one round-trip and replays safely.
      await pool.query(COURSEWARE_SCHEMA_SQL);
      await seedDefaultAdmin(wrapClient(pool));
      return pool;
    };
    let pool: Pool;
    try {
      pool = await bootstrap();
    } catch (error) {
      console.warn('[courseware] Bootstrap raced another bootstrapper, retrying once:', error);
      pool = await bootstrap();
    }
    readyPool = pool;
    return pool;
  })().catch((error: unknown) => {
    readyPromise = undefined;
    throw error;
  });
  return readyPromise;
}

/** Run a unit of work in a transaction; rolls back on any throw. */
export async function withTransaction<T>(work: (connection: DbClient) => Promise<T>): Promise<T> {
  const pool = await ensureCoursewareDatabase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(wrapClient(client));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[courseware] Transaction rollback failed:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Pool-level query after ensuring the schema exists. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const pool = await ensureCoursewareDatabase();
  return wrapClient(pool).query<T>(sql, params);
}

/** Pool-level write returning the affected-row count. */
export async function execute(sql: string, params: unknown[] = []): Promise<number> {
  const pool = await ensureCoursewareDatabase();
  return wrapClient(pool).execute(sql, params);
}

/** Close the shared pool (graceful-shutdown path only; no-op if never used). */
export async function closeCoursewarePool(): Promise<void> {
  if (!readyPool) return;
  const pool = readyPool;
  readyPool = undefined;
  readyPromise = undefined;
  await pool.end();
}
