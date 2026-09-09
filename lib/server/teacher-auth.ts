/**
 * Teacher authentication for the operations backend.
 *
 * Sessions are stateless HMAC-signed cookies (`openmaic_teacher`), minted and
 * verified in the Node runtime against the teachers table. Every
 * `/api/teacher/*` route funnels through `requireTeacher`/`getTeacherSession`;
 * page routes additionally render a client guard that redirects to the login
 * page, so no teacher data is reachable without a valid session.
 *
 * The signing secret is `TEACHER_SESSION_SECRET` when set; development falls
 * back to a value derived from `DATABASE_URL` so a fresh checkout works
 * without extra setup. Production deployments must set the env var.
 */
import { createHmac, timingSafeEqual } from 'crypto';

import { verifyPassword } from './db/password';
import { query } from './db/pg';

export const TEACHER_COOKIE = 'openmaic_teacher';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type TeacherRole = 'admin' | 'teacher';

export interface TeacherAccount {
  id: string;
  username: string;
  displayName: string;
  role: TeacherRole;
}

export interface TeacherSession {
  tid: string;
  username: string;
  displayName: string;
  role: TeacherRole;
  iat: number;
  exp: number;
}

function sessionSecret(): string {
  const configured = process.env.TEACHER_SESSION_SECRET?.trim();
  if (configured) return configured;
  return `openmaic-teacher-session:${process.env.DATABASE_URL?.trim() ?? ''}`;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

export function createTeacherSessionToken(teacher: TeacherAccount): {
  token: string;
  maxAge: number;
} {
  const now = Date.now();
  const session: TeacherSession = {
    tid: teacher.id,
    username: teacher.username,
    displayName: teacher.displayName,
    role: teacher.role,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const payload = base64UrlEncode(JSON.stringify(session));
  return { token: `${payload}.${sign(payload)}`, maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}

export function verifyTeacherSessionToken(token: string | undefined | null): TeacherSession | null {
  if (!token) return null;
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return null;
  const payload = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);
  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return null;
  }
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const session = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as TeacherSession;
    if (
      typeof session?.tid !== 'string' ||
      typeof session?.exp !== 'number' ||
      session.exp < Date.now()
    ) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

/** Extract and verify the teacher session from a request's cookie header. */
export function getTeacherSession(request: Request): TeacherSession | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== TEACHER_COOKIE) continue;
    return verifyTeacherSessionToken(decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return null;
}

// --- Login with a small in-memory throttle ------------------------------------
//
// Process-local by design: it blunts credential stuffing on a single instance
// without adding shared state. A multi-instance deployment should front this
// with a real rate limiter at the proxy.

interface AttemptRecord {
  count: number;
  lockedUntil: number;
}

const attempts = new Map<string, AttemptRecord>();
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

function throttleKey(username: string): string {
  return username.toLowerCase();
}

function isLocked(key: string): boolean {
  const record = attempts.get(key);
  return !!record && record.lockedUntil > Date.now();
}

function recordFailure(key: string): void {
  const record = attempts.get(key) ?? { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCK_MS;
    record.count = 0;
  }
  attempts.set(key, record);
}

function clearFailures(key: string): void {
  attempts.delete(key);
}

interface TeacherRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: string;
}

export async function authenticateTeacher(
  username: string,
  password: string,
): Promise<{ teacher: TeacherAccount } | { error: 'locked' | 'invalid' }> {
  const key = throttleKey(username);
  if (isLocked(key)) return { error: 'locked' };

  const rows = await query<TeacherRow & { [k: string]: unknown }>(
    'SELECT id, username, password_hash, display_name, role FROM teachers WHERE username = $1',
    [username],
  );
  const row = rows[0];
  const passwordOk =
    row !== undefined && typeof row.password_hash === 'string'
      ? await verifyPassword(password, row.password_hash)
      : false;

  if (!row || !passwordOk) {
    recordFailure(key);
    return { error: 'invalid' };
  }
  clearFailures(key);
  const role: TeacherRole = row.role === 'admin' ? 'admin' : 'teacher';
  return {
    teacher: {
      id: row.id,
      username: row.username,
      displayName: row.display_name ?? row.username,
      role,
    },
  };
}

export function sessionCookieOptions(maxAge: number): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}

export class TeacherAuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TeacherAuthError';
  }
}

/**
 * Require an authenticated teacher for an API route. Throws `TeacherAuthError`
 * (status 401) when the session is missing or expired — callers translate that
 * into a JSON response.
 */
export async function requireTeacher(request: Request): Promise<TeacherSession> {
  const session = getTeacherSession(request);
  if (!session) {
    throw new TeacherAuthError(401, 'teacher session required');
  }
  return session;
}
