import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
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
  try {
    const session = await requireTeacher(request);
    const { id } = await params;
    const detail = await getStudentDetail(id, session.tid, session.role === 'admin');
    if (!detail) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, '学生不存在或不在你的管理范围内');
    }
    return apiSuccess({ ...detail });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Student detail failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to load student');
  }
}

/** Remove a student account. Progress and questions cascade. */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    await requireTeacher(request);
    const { id } = await params;
    const deleted = await deleteStudent(id);
    if (!deleted) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, '学生不存在');
    }
    return apiSuccess({ deleted: true });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Student delete failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to delete student');
  }
}

/** Reset the student's password; the temp password is returned exactly once. */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    await requireTeacher(request);
    const { id } = await params;
    const tempPassword = await resetStudentPassword(id);
    if (!tempPassword) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, '学生不存在');
    }
    return apiSuccess({ tempPassword });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Student password reset failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to reset password');
  }
}
