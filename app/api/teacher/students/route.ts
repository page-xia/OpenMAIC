import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { listStudentsForTeacher } from '@/lib/server/courseware/student-progress';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';

const log = createLogger('TeacherStudents');

/** Student roster with activity aggregates (courses opened, last study, questions). */
export async function GET(request: NextRequest) {
  try {
    const session = await requireTeacher(request);
    const students = await listStudentsForTeacher(session.tid, session.role === 'admin');
    return apiSuccess({ students });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('List students failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to list students');
  }
}
