import { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { createCourse, listCoursesForTeacher, type CourseSource, type CourseStatus } from '@/lib/server/courseware/course-repo';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('TeacherCourses');

const STATUSES = ['draft', 'published', 'archived'] as const;
const SOURCES = ['pptx', 'ai_generation', 'maic_zip', 'blank'] as const;

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  source: z.enum(SOURCES).default('blank'),
});

export async function GET(request: NextRequest) {
  try {
    const session = await requireTeacher(request);
    const statusParam = request.nextUrl.searchParams.get('status');
    const q = request.nextUrl.searchParams.get('q') ?? undefined;
    const status = STATUSES.includes(statusParam as CourseStatus)
      ? (statusParam as CourseStatus)
      : undefined;
    const courses = await listCoursesForTeacher(session.tid, { status, q });
    return apiSuccess({ courses });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('List courses failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to list courses');
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireTeacher(request);
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid course payload');
    }
    const course = await createCourse(session.tid, {
      title: parsed.data.title,
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      source: parsed.data.source as CourseSource,
    });
    return apiSuccess({ course }, 201);
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Create course failed:', error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to create course',
      error instanceof Error ? error.message : String(error),
    );
  }
}
