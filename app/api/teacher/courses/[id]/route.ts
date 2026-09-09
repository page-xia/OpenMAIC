import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import {
  deleteCourse,
  documentStoreFor,
  getCourseForTeacher,
} from '@/lib/server/courseware/course-repo';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';
import { sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';
import { createLogger } from '@/lib/logger';
import type { AppScene } from '@/lib/types/stage';

const log = createLogger('TeacherCourse');

function courseIdFrom(value: string): string | null {
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireTeacher(request);
    const { id } = await params;
    const courseId = courseIdFrom(id);
    if (!courseId) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid course id');
    }
    const course = await getCourseForTeacher(session.tid, courseId);
    if (!course) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Course not found');
    }
    const document = await documentStoreFor(session.tid).loadDocument(courseId);
    if (!document) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Course document not found');
    }
    return apiSuccess({
      course,
      document: {
        stage: sanitizeSceneContent(document.stage),
        scenes: sanitizeSceneContent(document.scenes) as AppScene[],
      },
    });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Get course failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to load course');
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireTeacher(request);
    const { id } = await params;
    const courseId = courseIdFrom(id);
    if (!courseId) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid course id');
    }
    const body = (await request.json().catch(() => null)) as
      | { title?: unknown; description?: unknown }
      | null;
    if (!body) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid JSON body');
    }

    const store = documentStoreFor(session.tid);
    const document = await store.loadDocument(courseId);
    if (!document) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Course not found');
    }
    const nextStage = { ...document.stage };
    if (typeof body.title === 'string' && body.title.trim() !== '') {
      nextStage.name = body.title.trim().slice(0, 200);
    }
    if (typeof body.description === 'string') {
      nextStage.description = body.description.trim().slice(0, 2000) || undefined;
    }
    await store.putStage(courseId, nextStage);
    const course = await getCourseForTeacher(session.tid, courseId);
    return apiSuccess({ course });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Update course failed:', error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to update course',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireTeacher(request);
    const { id } = await params;
    const courseId = courseIdFrom(id);
    if (!courseId) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid course id');
    }
    const deleted = await deleteCourse(session.tid, courseId);
    if (!deleted) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Course not found');
    }
    return apiSuccess({ deleted: true });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Delete course failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to delete course');
  }
}
