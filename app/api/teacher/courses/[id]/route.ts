import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { getCourseAsset } from '@/lib/server/courseware/asset-repo';
import {
  deleteCourse,
  documentStoreFor,
  getCourseForTeacher,
  setCourseCover,
} from '@/lib/server/courseware/course-repo';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';
import { sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';
import { createLogger } from '@/lib/logger';
import type { AppScene } from '@/lib/types/stage';

const log = createLogger('TeacherCourse');

function courseIdFrom(value: string): string | null {
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : null;
}

/**
 * Resolve a cover pointer supplied by the client. Only an image asset that is
 * unfiled or already filed under THIS course is accepted, so a course can never
 * wear another course's picture. `null` clears the cover.
 */
async function resolveCoverAssetId(
  courseId: string,
  value: unknown,
): Promise<{ ok: true; assetId: string | null } | { ok: false; reason: string }> {
  if (value === null || value === '') return { ok: true, assetId: null };
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) {
    return { ok: false, reason: 'Invalid cover asset id' };
  }
  const asset = await getCourseAsset(value);
  if (!asset) return { ok: false, reason: 'Cover asset not found' };
  if (asset.kind !== 'image') return { ok: false, reason: 'Cover must be an image asset' };
  if (asset.courseId !== null && asset.courseId !== courseId) {
    return { ok: false, reason: 'Cover asset belongs to another course' };
  }
  return { ok: true, assetId: asset.id };
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
    const body = (await request.json().catch(() => null)) as {
      title?: unknown;
      description?: unknown;
      coverAssetId?: unknown;
    } | null;
    if (!body) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid JSON body');
    }

    // Cover first: it is pure ops metadata (no document write), so a rejected
    // cover never leaves a half-applied title edit behind.
    if (body.coverAssetId !== undefined) {
      const cover = await resolveCoverAssetId(courseId, body.coverAssetId);
      if (!cover.ok) {
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, cover.reason);
      }
      const updated = await setCourseCover(session.tid, courseId, cover.assetId);
      if (!updated) {
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Course not found');
      }
      if (body.title === undefined && body.description === undefined) {
        return apiSuccess({ course: updated });
      }
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
