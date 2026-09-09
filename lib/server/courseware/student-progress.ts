/**
 * Student learning records: scene progress per course, assistant questions,
 * and the teacher-console aggregates over both.
 *
 * Progress is SELF-REPORTED by the classroom player (one POST per scene
 * change, student session required); the server keeps the max scene order
 * seen so a student flipping back a page never regresses their progress.
 * Questions are recorded by the student chat route — question at ask time,
 * answer patched in when the stream completes.
 *
 * Teacher scope: an admin sees every student; a teacher sees only the
 * students who registered with invites they minted (the invite row is the
 * ownership link).
 */
import { customAlphabet, nanoid } from 'nanoid';

import { hashPassword } from '@/lib/server/db/password';
import { execute, query } from '@/lib/server/db/pg';

const readablePassword = customAlphabet('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 8);

export interface StudentListItem {
  id: string;
  username: string;
  displayName: string;
  invitedByCode: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  coursesOpened: number;
  lastStudyAt: number | null;
  questionCount: number;
}

export interface CourseProgressItem {
  courseId: string;
  courseTitle: string;
  courseStatus: string;
  sceneCount: number;
  maxSceneOrder: number;
  lastSceneId: string | null;
  lastSceneOrder: number | null;
  openCount: number;
  firstOpenedAt: number;
  lastOpenedAt: number;
}

export interface StudentQuestionItem {
  id: string;
  courseId: string | null;
  question: string;
  answer: string | null;
  createdAt: number;
  answeredAt: number | null;
}

export interface StudentDetail {
  profile: {
    id: string;
    username: string;
    displayName: string;
    invitedByCode: string | null;
    createdAt: number;
    lastLoginAt: number | null;
  };
  progress: CourseProgressItem[];
  questions: StudentQuestionItem[];
}

/** The ownership predicate: students invited by THIS teacher's codes. Parameterized. */
function teacherScope(): string {
  return 'EXISTS (SELECT 1 FROM student_invites i WHERE i.used_at IS NOT NULL AND i.created_by = $1 AND i.used_by = s.id)';
}

/** Report one scene visit. Idempotent per (student, course, order). */
export async function reportProgress(input: {
  studentId: string;
  courseId: string;
  sceneId: string;
  sceneOrder: number;
}): Promise<void> {
  const now = Date.now();
  await execute(
    'INSERT INTO student_course_progress (student_id, course_id, max_scene_order, last_scene_id, last_scene_order, open_count, first_opened_at, last_opened_at) ' +
      'VALUES ($1, $2, $3, $4, $5, 1, $6, $7) ' +
      'ON CONFLICT (student_id, course_id) DO UPDATE SET ' +
      'max_scene_order = GREATEST(student_course_progress.max_scene_order, EXCLUDED.max_scene_order), ' +
      'last_scene_id = EXCLUDED.last_scene_id, last_scene_order = EXCLUDED.last_scene_order, ' +
      'open_count = student_course_progress.open_count + 1, last_opened_at = EXCLUDED.last_opened_at',
    [input.studentId, input.courseId, input.sceneOrder, input.sceneId, input.sceneOrder, now, now],
  );
}

export async function recordQuestion(input: {
  studentId: string;
  question: string;
}): Promise<string> {
  const id = `q_${nanoid(16)}`;
  await execute(
    'INSERT INTO student_questions (id, student_id, question, created_at) VALUES ($1, $2, $3, $4)',
    [id, input.studentId, input.question.slice(0, 4000), Date.now()],
  );
  return id;
}

export async function saveQuestionAnswer(questionId: string, answer: string): Promise<void> {
  await execute('UPDATE student_questions SET answer = $1, answered_at = $2 WHERE id = $3', [
    answer.slice(0, 12000),
    Date.now(),
    questionId,
  ]);
}

export async function listStudentsForTeacher(
  teacherId: string,
  isAdmin: boolean,
): Promise<StudentListItem[]> {
  const scope = isAdmin ? '' : ` WHERE ${teacherScope()}`;
  const rows = await query<{
    id: string;
    username: string;
    display_name: string;
    invited_by_code: string | null;
    created_at: number;
    last_login_at: number | null;
    courses_opened: number;
    last_study_at: number | null;
    question_count: number;
  }>(
    `SELECT s.id, s.username, s.display_name, s.invited_by_code, s.created_at, s.last_login_at,
            COALESCE(p.courses_opened, 0) AS courses_opened,
            p.last_study_at AS last_study_at,
            (SELECT COUNT(*) FROM student_questions q WHERE q.student_id = s.id) AS question_count
       FROM students s
       LEFT JOIN (
         SELECT student_id, COUNT(DISTINCT course_id) AS courses_opened, MAX(last_opened_at) AS last_study_at
           FROM student_course_progress GROUP BY student_id
       ) p ON p.student_id = s.id
      ${scope}
      ORDER BY GREATEST(s.created_at, COALESCE(p.last_study_at, 0)) DESC
      LIMIT 1000`,
    isAdmin ? [] : [teacherId],
  );
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? row.username,
    invitedByCode: row.invited_by_code,
    createdAt: Number(row.created_at),
    lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at),
    coursesOpened: Number(row.courses_opened),
    lastStudyAt: row.last_study_at === null ? null : Number(row.last_study_at),
    questionCount: Number(row.question_count),
  }));
}

export async function getStudentDetail(
  studentId: string,
  teacherId: string,
  isAdmin: boolean,
): Promise<StudentDetail | null> {
  const profileRows = await query<{
    id: string;
    username: string;
    display_name: string;
    invited_by_code: string | null;
    created_at: number;
    last_login_at: number | null;
  }>(
    'SELECT id, username, display_name, invited_by_code, created_at, last_login_at FROM students WHERE id = $1',
    [studentId],
  );
  const profileRow = profileRows[0];
  if (!profileRow) return null;

  // Scope check: a non-admin teacher may only open their own invitees.
  if (!isAdmin) {
    const links = await query<{ code: string }>(
      'SELECT i.code AS code FROM student_invites i WHERE i.used_at IS NOT NULL AND i.used_by = $1 AND i.created_by = $2 LIMIT 1',
      [studentId, teacherId],
    );
    if (links.length === 0) return null;
  }

  const progressRows = await query<{
    course_id: string;
    course_title: string;
    course_status: string;
    scene_count: number;
    max_scene_order: number;
    last_scene_id: string | null;
    last_scene_order: number | null;
    open_count: number;
    first_opened_at: number;
    last_opened_at: number;
  }>(
    `SELECT p.course_id, st.name AS course_title, c.status AS course_status,
            (SELECT COUNT(*) FROM document_scenes ds WHERE ds.stage_id = p.course_id) AS scene_count,
            p.max_scene_order, p.last_scene_id, p.last_scene_order, p.open_count,
            p.first_opened_at, p.last_opened_at
       FROM student_course_progress p
       JOIN courses c ON c.id = p.course_id
       JOIN document_stages st ON st.id = p.course_id
      WHERE p.student_id = $1
      ORDER BY p.last_opened_at DESC`,
    [studentId],
  );

  const questionRows = await query<{
    id: string;
    course_id: string | null;
    question: string;
    answer: string | null;
    created_at: number;
    answered_at: number | null;
  }>(
    'SELECT id, course_id, question, answer, created_at, answered_at FROM student_questions WHERE student_id = $1 ORDER BY created_at DESC LIMIT 100',
    [studentId],
  );

  return {
    profile: {
      id: profileRow.id,
      username: profileRow.username,
      displayName: profileRow.display_name ?? profileRow.username,
      invitedByCode: profileRow.invited_by_code,
      createdAt: Number(profileRow.created_at),
      lastLoginAt: profileRow.last_login_at === null ? null : Number(profileRow.last_login_at),
    },
    progress: progressRows.map((row) => ({
      courseId: row.course_id,
      courseTitle: row.course_title,
      courseStatus: row.course_status,
      sceneCount: Number(row.scene_count),
      maxSceneOrder: Number(row.max_scene_order),
      lastSceneId: row.last_scene_id,
      lastSceneOrder: row.last_scene_order === null ? null : Number(row.last_scene_order),
      openCount: Number(row.open_count),
      firstOpenedAt: Number(row.first_opened_at),
      lastOpenedAt: Number(row.last_opened_at),
    })),
    questions: questionRows.map((row) => ({
      id: row.id,
      courseId: row.course_id,
      question: row.question,
      answer: row.answer,
      createdAt: Number(row.created_at),
      answeredAt: row.answered_at === null ? null : Number(row.answered_at),
    })),
  };
}

export async function deleteStudent(studentId: string): Promise<boolean> {
  const affected = await execute('DELETE FROM students WHERE id = $1', [studentId]);
  return affected > 0;
}

/** Mint a new temp password for the student; returned ONCE to the teacher. */
export async function resetStudentPassword(studentId: string): Promise<string | null> {
  const rows = await query<{ id: string }>('SELECT id FROM students WHERE id = $1', [studentId]);
  if (!rows[0]) return null;
  const tempPassword = readablePassword();
  const passwordHash = await hashPassword(tempPassword);
  await execute('UPDATE students SET password_hash = $1 WHERE id = $2', [passwordHash, studentId]);
  return tempPassword;
}
