/**
 * Student invite codes: batch minting, listing, and single-code deletion for
 * the teacher console, plus the shared code alphabet. A code is ONE-TIME: it
 * is consumed by the register transaction's guarded UPDATE
 * (`WHERE ... AND used_at IS NULL`), so a code that verified successfully can
 * never seat a second student.
 *
 * Codes use an unambiguous 8-character alphabet (no 0/O/1/I/L) so they can be
 * read aloud or copied from paper.
 */
import { customAlphabet, nanoid } from 'nanoid';

import { execute, query, withTransaction } from '@/lib/server/db/pg';
import { hashPassword } from '@/lib/server/db/password';

/** Unambiguous uppercase alphanumerics only. */
export const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export const INVITE_CODE_LENGTH = 8;
export const INVITE_BATCH_MAX = 200;

export const generateInviteCode = customAlphabet(INVITE_ALPHABET, INVITE_CODE_LENGTH);

/** The code shape the register route accepts (mirrors the alphabet). */
export const INVITE_CODE_RE = new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`);

export interface StudentInvite {
  code: string;
  batchId: string | null;
  note: string | null;
  createdBy: string;
  createdAt: number;
  usedBy: string | null;
  usedByUsername: string | null;
  usedAt: number | null;
}

interface InviteJoinRow {
  code: string;
  batch_id: string | null;
  note: string | null;
  created_by: string;
  created_at: number;
  used_by: string | null;
  used_at: number | null;
  used_by_username: string | null;
}

const INVITE_SELECT = `
  SELECT i.code, i.batch_id, i.note, i.created_by, i.created_at, i.used_by, i.used_at,
         s.username AS used_by_username
    FROM student_invites i
    LEFT JOIN students s ON s.id = i.used_by
`;

function toInvite(row: InviteJoinRow): StudentInvite {
  return {
    code: row.code,
    batchId: row.batch_id,
    note: row.note,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    usedBy: row.used_by,
    usedByUsername: row.used_by_username,
    usedAt: row.used_at === null ? null : Number(row.used_at),
  };
}

export async function createInviteBatch(input: {
  teacherId: string;
  count: number;
  note?: string;
}): Promise<{ batchId: string; codes: string[] }> {
  const batchId = `inv_${nanoid(12)}`;
  const now = Date.now();
  const codes = new Set<string>();
  while (codes.size < input.count) codes.add(generateInviteCode());
  // Codes are the primary key; a collision simply shrinks the set above until
  // it is unique, and the multi-row insert writes them in one round-trip.
  // Positional placeholders increment per row: ($1..$5), ($6..$10), ...
  const rows = [...codes].map((_, index) => {
    const base = index * 5;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
  });
  await execute(
    'INSERT INTO student_invites (code, batch_id, note, created_by, created_at) VALUES ' +
      rows.join(', '),
    [...codes].flatMap((code) => [code, batchId, input.note ?? null, input.teacherId, now]),
  );
  return { batchId, codes: [...codes] };
}

export async function listInvites(
  filter: { status?: 'unused' | 'used'; teacherId?: string } = {},
): Promise<StudentInvite[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.status === 'unused') conditions.push('i.used_at IS NULL');
  if (filter.status === 'used') conditions.push('i.used_by IS NOT NULL');
  if (filter.teacherId) {
    conditions.push('i.created_by = $1');
    params.push(filter.teacherId);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const rows = await query<InviteJoinRow>(
    `${INVITE_SELECT}${where} ORDER BY i.created_at DESC, i.code ASC LIMIT 1000`,
    params,
  );
  return rows.map(toInvite);
}

export async function deleteUnusedInvite(code: string, teacherId: string): Promise<boolean> {
  const affected = await execute(
    'DELETE FROM student_invites WHERE code = $1 AND created_by = $2 AND used_at IS NULL',
    [code, teacherId],
  );
  return affected > 0;
}

export interface RegisterStudentResult {
  readonly ok: boolean;
  /** 'code' — the invite was invalid or already spent; 'username' — taken. */
  readonly reason?: 'code' | 'username';
  readonly student?: { id: string; username: string; displayName: string };
}

/**
 * Register one student against one invite code. The code consumption and the
 * student INSERT are ONE transaction, and the code is consumed by a guarded
 * UPDATE (`WHERE ... AND used_at IS NULL`) — under concurrency exactly one
 * caller sees an affected-row count of 1, so a verified code is a spent code.
 */
export async function registerStudentWithInvite(input: {
  username: string;
  password: string;
  displayName: string;
  inviteCode: string;
}): Promise<RegisterStudentResult> {
  const studentId = `stu_${nanoid(16)}`;
  const passwordHash = await hashPassword(input.password);
  const now = Date.now();
  try {
    const accepted = await withTransaction(async (connection) => {
      // Student first — the invite's FK points at this row. A lost race on
      // the code (0 rows updated) rolls the whole transaction back, so the
      // student insert is undone and nothing is seated.
      await connection.execute(
        'INSERT INTO students (id, username, password_hash, display_name, invited_by_code, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [studentId, input.username, passwordHash, input.displayName, input.inviteCode, now],
      );
      const affected = await connection.execute(
        'UPDATE student_invites SET used_by = $1, used_at = $2 WHERE code = $3 AND used_at IS NULL',
        [studentId, now, input.inviteCode],
      );
      return affected === 1;
    });
    if (!accepted) return { ok: false, reason: 'code' };
    return {
      ok: true,
      student: { id: studentId, username: input.username, displayName: input.displayName },
    };
  } catch (error) {
    // PostgreSQL surfaces uniqueness violations as error code 23505
    // (unique_violation) — here always the students.username unique index.
    if ((error as { code?: string }).code === '23505') {
      return { ok: false, reason: 'username' };
    }
    throw error;
  }
}
