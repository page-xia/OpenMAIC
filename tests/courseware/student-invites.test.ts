/**
 * Student invite + registration flow: batch minting, one-time consumption
 * (register succeeds once, then the same code refuses), duplicate usernames,
 * credential login, and unused-code deletion. Requires a reachable PostgreSQL
 * (DATABASE_URL); skips otherwise.
 */
import { afterAll, describe, expect, test } from 'vitest';

import { closeCoursewarePool, ensureCoursewareDatabase } from '@/lib/server/db/pg';
import {
  createInviteBatch,
  deleteUnusedInvite,
  listInvites,
  registerStudentWithInvite,
} from '@/lib/server/courseware/student-invites';
import { verifyStudentCredentials } from '@/lib/server/student-auth';
import { nanoid } from 'nanoid';

async function coursewareReachable(): Promise<boolean> {
  try {
    await ensureCoursewareDatabase();
    return true;
  } catch {
    return false;
  }
}

const reachable = await coursewareReachable();

describe.skipIf(!reachable)('student invites + registration (PostgreSQL)', () => {
  const teacherId = `tch_test_${nanoid(8)}`;
  const suffix = nanoid(6);

  afterAll(async () => {
    // Clean the students this test created so repeat runs never collide.
    try {
      const { query } = await import('@/lib/server/db/pg');
      await query('DELETE FROM students WHERE username LIKE $1 AND created_at > $2', [
        'stu\\_test\\_%',
        Date.now() - 3600 * 1000,
      ]);
    } catch {
      // Best-effort cleanup.
    }
    await closeCoursewarePool();
  });

  test('batch minting creates unique unused codes', async () => {
    const { batchId, codes } = await createInviteBatch({ teacherId, count: 5 });
    expect(codes).toHaveLength(5);
    expect(new Set(codes).size).toBe(5);
    expect(batchId).toMatch(/^inv_/);
    for (const code of codes) {
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    }
    const invites = await listInvites({ teacherId });
    const minted = invites.filter((invite) => invite.batchId === batchId);
    expect(minted).toHaveLength(5);
    for (const invite of minted) {
      expect(invite.usedBy).toBeNull();
      expect(invite.usedByUsername).toBeNull();
    }
  });

  test('register consumes the code exactly once', async () => {
    const { codes } = await createInviteBatch({ teacherId, count: 1 });
    const code = codes[0]!;

    const first = await registerStudentWithInvite({
      username: `stu_test_${suffix}_a`,
      password: 'Secret@123',
      displayName: '测试学生',
      inviteCode: code,
    });
    expect(first.ok).toBe(true);
    expect(first.student?.username).toBe(`stu_test_${suffix}_a`);

    // The same code is now spent: a second register is refused.
    const second = await registerStudentWithInvite({
      username: `stu_test_${suffix}_b`,
      password: 'Secret@123',
      displayName: '第二个学生',
      inviteCode: code,
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('code');

    // The invite row records who used it.
    const invites = await listInvites({ teacherId });
    const spent = invites.find((invite) => invite.code === code);
    expect(spent?.usedByUsername).toBe(`stu_test_${suffix}_a`);
    expect(spent?.usedAt).not.toBeNull();

    // Credentials verify; a wrong password does not.
    const ok = await verifyStudentCredentials(`stu_test_${suffix}_a`, 'Secret@123');
    expect(ok?.username).toBe(`stu_test_${suffix}_a`);
    const bad = await verifyStudentCredentials(`stu_test_${suffix}_a`, 'wrong-password');
    expect(bad).toBeNull();
  });

  test('duplicate usernames are refused without burning the code', async () => {
    const { codes } = await createInviteBatch({ teacherId, count: 2 });
    const [first, second] = codes as [string, string];
    const created = await registerStudentWithInvite({
      username: `stu_test_${suffix}_c`,
      password: 'Secret@123',
      displayName: '学生C',
      inviteCode: first!,
    });
    expect(created.ok).toBe(true);

    // Same username, fresh code → username refused; the fresh code stays unused.
    const clash = await registerStudentWithInvite({
      username: `stu_test_${suffix}_c`,
      password: 'Secret@123',
      displayName: '学生C二号',
      inviteCode: second!,
    });
    expect(clash.ok).toBe(false);
    expect(clash.reason).toBe('username');

    const invites = await listInvites({ teacherId, status: 'unused' });
    expect(invites.some((invite) => invite.code === second)).toBe(true);

    // The still-unused code can be deleted; the used one cannot.
    await expect(deleteUnusedInvite(second!, teacherId)).resolves.toBe(true);
    const spentCode = invites.find((invite) => invite.code === first!);
    void spentCode;
  });

  test('a spent code cannot be deleted', async () => {
    const { codes } = await createInviteBatch({ teacherId, count: 1 });
    const code = codes[0]!;
    await registerStudentWithInvite({
      username: `stu_test_${suffix}_d`,
      password: 'Secret@123',
      displayName: '学生D',
      inviteCode: code,
    });
    await expect(deleteUnusedInvite(code, teacherId)).resolves.toBe(false);
  });
});
