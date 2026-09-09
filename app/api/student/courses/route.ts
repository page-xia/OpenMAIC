import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { listPublishedCourses } from '@/lib/server/courseware/course-repo';
import { createLogger } from '@/lib/logger';

const log = createLogger('StudentCourses');

export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams.get('q') ?? undefined;
    const courses = await listPublishedCourses({ q });
    return apiSuccess({ courses });
  } catch (error) {
    log.error('List published courses failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to list courses');
  }
}
