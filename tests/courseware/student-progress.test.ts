/**
 * Student learning records: progress reporting (max-order regression guard),
 * question persistence, and the teacher console aggregates. Requires a
 * reachable PostgreSQL (DATABASE_URL); skips otherwise.
 */
import { nanoid } from 'nanoid';
import { afterAll, describe, expect, test } from 'vitest';

import { closeCoursewarePool, ensureCoursewareDatabase, query } from '@/lib/server/db/pg';
import {
  deleteStudent,
  getStudentDetail,
  listStudentsForTeacher,
  recordQuestion,
  reportProgress,
  resetStudentPassword,
  saveQuestionAnswer,
} from '@/lib/server/courseware/student-progress';
import { createStudentSessionToken, verifyStudentCredentials } from '@/lib/server/student-auth';
import {
  createInviteBatch,
  registerStudentWithInvite,
} from '@/lib/server/courseware/student-invites';

async function coursewareReachable(): Promise<boolean> {
  try {
    await ensureCoursewareDatabase();
    return true;
  } catch {
    return false;
  }
}

const reachable = await coursewareReachable();

describe.skipIf(!reachable)('student learning records (PostgreSQL)', () => {
  const teacherId = `tch_test_${nanoid(8)}`;
  const suffix = nanoid(6);
  let studentId = '';

  afterAll(async () => {
    try {
      await query('DELETE FROM students WHERE username LIKE $1', [`stu_test_${suffix}%`]);
      await query('DELETE FROM student_invites WHERE created_by = $1', [teacherId]);
      await query('DELETE FROM teachers WHERE id = $1', [teacherId]);
    } catch {
      // Best-effort cleanup.
    }
    await closeCoursewarePool();
  });

  async function seedStudent(): Promise<string> {
    const { codes } = await createInviteBatch({ teacherId, count: 1 });
    const result = await registerStudentWithInvite({
      username: `stu_test_${suffix}_${studentId ? 'z' : 'a'}`,
      password: 'Secret@123',
      displayName: '进度测试学生',
      inviteCode: codes[0]!,
    });
    expect(result.ok).toBe(true);
    return result.student!.id;
  }

  test('progress keeps the max order seen and never regresses', async () => {
    studentId = await seedStudent();
    // A teacher row to own the course shell (courses.teacher_id has an FK).
    await query(
      'INSERT INTO teachers (id, username, password_hash, display_name, role, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING',
      [teacherId, `t_${teacherId}`, 'x', '进度测试教师', 'teacher', Date.now(), Date.now()],
    );
    // A published course shell: courses rows require a document_stages row.
    const courseId = `crs_prog_${nanoid(8)}`;
    await query(
      'INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data) VALUES ($1, $2, $3, $4, $5, $6)',
      [courseId, '进度测试课', Date.now(), Date.now(), teacherId, JSON.stringify({ id: courseId })],
    );
    await query(
      'INSERT INTO courses (id, teacher_id, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)',
      [courseId, teacherId, 'published', Date.now(), Date.now()],
    );
    for (let order = 1; order <= 4; order += 1) {
      await query(
        'INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1, $2, $3, $4)',
        [
          courseId,
          `sc_${order}`,
          order,
          JSON.stringify({ id: `sc_${order}`, stageId: courseId, order }),
        ],
      );
    }

    await reportProgress({ studentId, courseId, sceneId: 'sc_1', sceneOrder: 1 });
    await reportProgress({ studentId, courseId, sceneId: 'sc_3', sceneOrder: 3 });
    // Flipping back must not regress the max.
    await reportProgress({ studentId, courseId, sceneId: 'sc_2', sceneOrder: 2 });

    const detail = await getStudentDetail(studentId, teacherId, true);
    expect(detail).not.toBeNull();
    expect(detail!.progress).toHaveLength(1);
    const progress = detail!.progress[0]!;
    expect(progress.courseId).toBe(courseId);
    expect(progress.courseTitle).toBe('进度测试课');
    expect(progress.maxSceneOrder).toBe(3);
    expect(progress.lastSceneOrder).toBe(2);
    expect(progress.lastSceneId).toBe('sc_2');
    expect(progress.sceneCount).toBe(4);
    expect(progress.openCount).toBe(3);

    // Roster aggregate sees the course + activity.
    const roster = await listStudentsForTeacher(teacherId, false);
    const row = roster.find((item) => item.id === studentId);
    expect(row?.coursesOpened).toBe(1);
    expect(row?.lastStudyAt).not.toBeNull();

    // Cleanup the course shell (cascades progress + scenes).
    await query('DELETE FROM document_stages WHERE id = $1', [courseId]);
  });

  test('questions persist at ask time and gain answers on stream end', async () => {
    const questionId = await recordQuestion({ studentId, question: '什么是勾股定理？' });
    let detail = await getStudentDetail(studentId, teacherId, true);
    expect(detail!.questions).toHaveLength(1);
    expect(detail!.questions[0]!.answer).toBeNull();

    await saveQuestionAnswer(questionId, '直角三角形两直角边的平方和等于斜边的平方。');
    detail = await getStudentDetail(studentId, teacherId, true);
    expect(detail!.questions[0]!.answer).toContain('斜边的平方');
    expect(detail!.questions[0]!.createdAt).toBeGreaterThan(0);
  });

  test('teacher scope hides foreign students from non-admin, admin sees all', async () => {
    const otherTeacher = `tch_other_${nanoid(8)}`;
    const roster = await listStudentsForTeacher(otherTeacher, false);
    expect(roster.some((item) => item.id === studentId)).toBe(false);
    const adminRoster = await listStudentsForTeacher(otherTeacher, true);
    expect(adminRoster.some((item) => item.id === studentId)).toBe(true);
  });

  test('password reset mints a working temp password; delete cascades records', async () => {
    const tempPassword = await resetStudentPassword(studentId);
    expect(tempPassword).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    const login = await verifyStudentCredentials(`stu_test_${suffix}_a`, tempPassword as string);
    expect(login?.id).toBe(studentId);

    await recordQuestion({ studentId, question: '删除前最后的提问' });
    let detail = await getStudentDetail(studentId, teacherId, true);
    const questionsBefore = detail!.questions.length;
    expect(questionsBefore).toBeGreaterThan(0);

    expect(await deleteStudent(studentId)).toBe(true);
    detail = await getStudentDetail(studentId, teacherId, true);
    expect(detail).toBeNull();

    // Progress and questions cascaded away with the student.
    const remaining = await query(
      'SELECT COUNT(*) AS n FROM student_questions WHERE student_id = $1',
      [studentId],
    );
    expect(Number((remaining as { n: number }[])[0]!.n)).toBe(0);
    void createStudentSessionToken;
  });
});
