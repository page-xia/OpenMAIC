import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { startRequestLog } from '@/lib/server/request-log';
import {
  getStudentDetail,
  deleteStudent,
  resetStudentPassword,
} from '@/lib/server/courseware/student-progress';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';

const log = createLogger('TeacherStudent');

type Params = { params: Promise<{ id: string }> };

/** One student's full record: profile + per-course progress + questions. */
export async function GET(request: NextRequest, { params }: Params) {
  const reqLog = startRequestLog(log, request);
  try {
    const session = await requireTeacher(request);
    const { id } = await params;
    const detail = await getStudentDetail(id, session.tid, session.role === 'admin');
    if (!detail) {
      reqLog.done(404, { teacherId: session.tid, studentId: id, reason: 'not_found' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, '学生不存在或不在你的管理范围内');
    }
    reqLog.done(200, { teacherId: session.tid, studentId: id, courses: detail.progress.length }, 'debug');
    return apiSuccess({ ...detail });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      reqLog.done(error.status, { reason: 'auth_error' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    reqLog.fail(error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to load student');
  }
}

/** Remove a student account. Progress and questions cascade. */
export async function DELETE(request: NextRequest, { params }: Params) {
  const reqLog = startRequestLog(log, request);
  try {
    const session = await requireTeacher(request);
    const { id } = await params;
    const deleted = await deleteStudent(id);
    if (!deleted) {
      reqLog.done(404, { teacherId: session.tid, studentId: id, reason: 'not_found' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, '学生不存在');
    }
    // Destructive and irreversible: always logged at info with the actor.
    reqLog.done(200, { teacherId: session.tid, studentId: id });
    return apiSuccess({ deleted: true });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      reqLog.done(error.status, { reason: 'auth_error' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    reqLog.fail(error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to delete student');
  }
}

/** Reset the student's password; the temp password is returned exactly once. */
export async function POST(request: NextRequest, { params }: Params) {
  const reqLog = startRequestLog(log, request);
  try {
    const session = await requireTeacher(request);
    const { id } = await params;
    const tempPassword = await resetStudentPassword(id);
    if (!tempPassword) {
      reqLog.done(404, { teacherId: session.tid, studentId: id, reason: 'not_found' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, '学生不存在');
    }
    // The temp password itself is never logged, only that a reset happened.
    reqLog.done(200, { teacherId: session.tid, studentId: id });
    return apiSuccess({ tempPassword });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      reqLog.done(error.status, { reason: 'auth_error' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    reqLog.fail(error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to reset password');
  }
}
