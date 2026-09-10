import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { listPublishedCourses } from '@/lib/server/courseware/course-repo';
import { getStudentSession } from '@/lib/server/student-auth';
import { createLogger } from '@/lib/logger';
import { startRequestLog } from '@/lib/server/request-log';

const log = createLogger('StudentCourses');

export async function GET(request: NextRequest) {
  const reqLog = startRequestLog(log, request);
  try {
    const q = request.nextUrl.searchParams.get('q') ?? undefined;
    const courses = await listPublishedCourses({ q });
    reqLog.done(200, {
      studentId: getStudentSession(request)?.sid,
      q: q ?? null,
      count: courses.length,
    });
    return apiSuccess({ courses });
  } catch (error) {
    reqLog.fail(error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to list courses');
  }
}
