import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { publishCourse, unpublishCourse } from '@/lib/server/courseware/course-repo';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';
import { createLogger } from '@/lib/logger';
import { startRequestLog } from '@/lib/server/request-log';

const log = createLogger('TeacherPublish');

function courseIdFrom(value: string): string | null {
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : null;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const reqLog = startRequestLog(log, request);
  let courseId: string | null = null;
  try {
    const session = await requireTeacher(request);
    const { id } = await params;
    courseId = courseIdFrom(id);
    if (!courseId) {
      reqLog.done(400, { teacherId: session.tid, reason: 'invalid_id' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid course id');
    }
    const result = await publishCourse(session.tid, courseId);
    if (!result) {
      reqLog.done(404, { teacherId: session.tid, courseId, reason: 'not_found' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Course not found');
    }
    reqLog.done(200, { teacherId: session.tid, courseId, version: result.version });
    return apiSuccess({ published: true, version: result.version, publishedAt: result.publishedAt });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      reqLog.done(error.status, { reason: 'auth_error' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    reqLog.fail(error, { courseId });
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to publish course',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const reqLog = startRequestLog(log, request);
  try {
    const session = await requireTeacher(request);
    const { id } = await params;
    const courseId = courseIdFrom(id);
    if (!courseId) {
      reqLog.done(400, { teacherId: session.tid, reason: 'invalid_id' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid course id');
    }
    const course = await unpublishCourse(session.tid, courseId);
    if (!course) {
      reqLog.done(404, { teacherId: session.tid, courseId, reason: 'not_found' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Course not found');
    }
    reqLog.done(200, { teacherId: session.tid, courseId });
    return apiSuccess({ published: false, course });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      reqLog.done(error.status, { reason: 'auth_error' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    reqLog.fail(error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to unpublish course');
  }
}
