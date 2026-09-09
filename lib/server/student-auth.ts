/**
 * Student authentication for the student-side account system.
 *
 * Mirrors `teacher-auth.ts` in every structural detail — stateless HMAC-signed
 * cookie, server-side verification against the database — with a distinct
 * cookie (`openmaic_student`) so a browser can hold a teacher console session
 * and a student session at once without one shadowing the other. Registration
 * is gated by one-time invite codes minted in the teacher console; the code is
 * consumed atomically by the register transaction.
 *
 * The signing secret is `STUDENT_SESSION_SECRET` when set; development falls
 * back to a value derived from `DATABASE_URL`, exactly as the teacher session
 * does.
 */
import { createHmac, timingSafeEqual } from 'crypto';

import { verifyPassword } from './db/password';
import { query } from './db/pg';

export const STUDENT_COOKIE = 'openmaic_student';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface StudentAccount {
  id: string;
  username: string;
  displayName: string;
}

export interface StudentSession {
  sid: string;
  username: string;
  displayName: string;
  iat: number;
  exp: number;
}

function sessionSecret(): string {
  const configured = process.env.STUDENT_SESSION_SECRET?.trim();
  if (configured) return configured;
  return `openmaic-student-session:${process.env.DATABASE_URL?.trim() ?? ''}`;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

export function createStudentSessionToken(student: StudentAccount): {
  token: string;
  maxAge: number;
} {
  const now = Date.now();
  const session: StudentSession = {
    sid: student.id,
    username: student.username,
    displayName: student.displayName,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const payload = base64UrlEncode(JSON.stringify(session));
  return { token: `${payload}.${sign(payload)}`, maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}

export function verifyStudentSessionToken(token: string | undefined | null): StudentSession | null {
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
    ) as StudentSession;
    if (
      typeof session?.sid !== 'string' ||
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

/** Extract and verify the student session from a request's cookie header. */
export function getStudentSession(request: Request): StudentSession | null {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== STUDENT_COOKIE) continue;
    return verifyStudentSessionToken(decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return null;
}

export function studentCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}

// --- Credential checks ---------------------------------------------------------

interface StudentRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
}

export async function findStudentByUsername(username: string): Promise<StudentRow | null> {
  const rows = await query<StudentRow>(
    'SELECT id, username, password_hash, display_name FROM students WHERE username = $1',
    [username],
  );
  return rows[0] ?? null;
}

export async function verifyStudentCredentials(
  username: string,
  password: string,
): Promise<StudentAccount | null> {
  const row = await findStudentByUsername(username);
  if (!row) return null;
  const passwordOk = await verifyPassword(password, row.password_hash);
  if (!passwordOk) return null;
  return { id: row.id, username: row.username, displayName: row.display_name ?? row.username };
}
