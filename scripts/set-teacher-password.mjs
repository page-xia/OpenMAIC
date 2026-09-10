#!/usr/bin/env node
/**
 * Set (or reset) a teacher/admin password directly in the courseware database.
 *
 * Why this exists: the app seeds the `admin` account only while the `teachers`
 * table is empty (`lib/server/db/pg.ts` -> `seedDefaultAdmin`) and exposes no
 * in-app password change, so an admin locked out of a deployed instance has no
 * route back in through the UI. This script writes the row out of band.
 *
 * The hash format must stay byte-compatible with `lib/server/db/password.ts`:
 * `scrypt$N$r$p$saltHex$hashHex`, derived over the NFKC-normalized password.
 *
 * Usage (DATABASE_URL from the environment, --url, or --env-file):
 *   node scripts/set-teacher-password.mjs --username admin --password 'NewPass!'
 *   node scripts/set-teacher-password.mjs --env-file .env.local --username admin
 *   node scripts/set-teacher-password.mjs --print-sql            # no DB, no `pg`
 *
 * Omit --password to have a strong one generated and printed. Prefer the
 * TEACHER_PASSWORD env var over --password: a literal flag lands in the shell
 * history and in the process list.
 *
 * `--print-sql` emits the statement to paste into a hosted SQL console (Neon,
 * Supabase, Vercel Postgres) instead of connecting, so the script works even
 * where the `pg` dependency is unavailable.
 */
import { readFileSync } from 'node:fs';
import { randomBytes, scrypt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';

const scryptAsync = promisify(scrypt);

// Must mirror lib/server/db/password.ts — a mismatch produces a hash the app
// can never verify.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

// Mirrors the teachers DDL in lib/server/db/schema.ts, so this works against a
// database the app has not bootstrapped yet. Idempotent either way.
const TEACHERS_DDL = `
CREATE TABLE IF NOT EXISTS teachers (
  id VARCHAR(64) NOT NULL,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'teacher',
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS teachers_username_unique ON teachers (username);
`;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function parseArgs(argv) {
  const options = { username: 'admin', role: 'admin' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--print-sql') {
      options.printSql = true;
      continue;
    }
    const [flag, inlineValue] = arg.split('=');
    const takesValue = [
      '--username',
      '--password',
      '--role',
      '--display-name',
      '--url',
      '--env-file',
    ];
    if (!takesValue.includes(flag)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = inlineValue ?? argv[(i += 1)];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    options[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return options;
}

/** Minimal KEY=VALUE reader for .env-style files; no export or interpolation. */
function readEnvFile(path) {
  const env = {};
  // Strip a UTF-8 BOM — on Windows an editor-saved .env can start with one, and
  // it would otherwise fuse onto the first key name.
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function generatedPassword() {
  // 24 chars from an unambiguous alphabet: enough entropy, easy to copy by hand.
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(24), (byte) => alphabet[byte % alphabet.length]).join('');
}

const USAGE = `Usage: node scripts/set-teacher-password.mjs [options]

  --username <name>       account to set (default: admin)
  --password <value>      new password; omit to auto-generate and print
  --role <admin|teacher>  role to enforce (default: admin)
  --display-name <name>   display name (default: Administrator / the username)
  --url <connection>      PostgreSQL URL (default: DATABASE_URL)
  --env-file <path>       read DATABASE_URL from a .env-style file (e.g. .env.local)
  --print-sql             print the SQL to run manually instead of connecting
  --help                  show this message
`;

const UPSERT_COLUMNS = '(id, username, password_hash, display_name, role, created_at, updated_at)';
// On conflict only the credential fields change, so an existing account keeps
// its id, display name, and created_at.
const UPSERT_TAIL = [
  'ON CONFLICT (username) DO UPDATE',
  '  SET password_hash = EXCLUDED.password_hash,',
  '      role = EXCLUDED.role,',
  '      updated_at = EXCLUDED.updated_at;',
].join('\n');

/** Parameterized form for the `pg` path — no value is ever interpolated. */
function upsertSqlParameterized() {
  return [
    `INSERT INTO teachers ${UPSERT_COLUMNS}`,
    'VALUES ($1, $2, $3, $4, $5, $6, $7)',
    UPSERT_TAIL,
  ].join('\n');
}

function upsertParameters(id, username, passwordHash, role, displayName, now) {
  return [id, username, passwordHash, displayName, role, now, now];
}

/** Literal form for `--print-sql`, escaped for paste into a SQL console. */
function upsertSqlLiteral(id, username, passwordHash, role, displayName, now) {
  const quote = (value) =>
    typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
  const values = [id, username, passwordHash, displayName, role, now, now].map(quote).join(', ');
  return [`INSERT INTO teachers ${UPSERT_COLUMNS}`, `VALUES (${values})`, UPSERT_TAIL].join('\n');
}

function newTeacherId() {
  return `tch_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const password =
    options.password ?? process.env.TEACHER_PASSWORD ?? generatedPassword();
  const generated = options.password === undefined && !process.env.TEACHER_PASSWORD;
  const role = options.role === 'teacher' ? 'teacher' : 'admin';
  const displayName =
    options.displayName ?? (role === 'admin' ? 'Administrator' : options.username);
  const passwordHash = await hashPassword(password);
  const now = Date.now();
  const id = newTeacherId();

  if (options.printSql) {
    const statement = upsertSqlLiteral(id, options.username, passwordHash, role, displayName, now);
    process.stdout.write(
      '\n-- Run this against the courseware database, then log in at /teacher/login.\n' +
        `-- Account: ${options.username} (role: ${role})\n` +
        (generated ? `-- Generated password: ${password}\n` : '') +
        `\n${TEACHERS_DDL.trim()}\n\n${statement}\n\n`,
    );
    return;
  }

  const fileEnv = options.envFile ? readEnvFile(options.envFile) : {};
  const connectionString =
    options.url ?? process.env.DATABASE_URL?.trim() ?? fileEnv.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      'No database URL. Pass --url, set DATABASE_URL, or point --env-file at a file that has it. ' +
        'Use --print-sql to emit the statement instead.',
    );
  }

  // Imported lazily so --help/--print-sql still work when dependencies are not
  // installed (or the SQL console is the only access path).
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(TEACHERS_DDL);
    const existing = await client.query('SELECT id FROM teachers WHERE username = $1', [
      options.username,
    ]);
    await client.query(
      upsertSqlParameterized(),
      upsertParameters(id, options.username, passwordHash, role, displayName, now),
    );

    const total = await client.query('SELECT count(*)::int AS count FROM teachers');
    const verb = existing.rowCount > 0 ? 'Updated' : 'Created';
    process.stdout.write(
      `\n${verb} account "${options.username}" (role: ${role}).\n` +
        (generated ? `Generated password: ${password}\n` : '') +
        `Teachers in this database: ${total.rows[0].count}. Log in at /teacher/login.\n\n`,
    );
  } finally {
    await client.end();
  }
}

// Only run when invoked as a CLI, so the hashing helper stays importable (and
// therefore testable) from other scripts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`\nFailed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
