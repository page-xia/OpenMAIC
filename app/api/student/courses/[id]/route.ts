import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { getPublishedSnapshot } from '@/lib/server/courseware/course-repo';
import { getTeacherSession } from '@/lib/server/teacher-auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('StudentCourse');

/**
 * Student-facing published-course read: the full snapshot for classroom
 * playback plus the version students should cache against. A signed-in
 * teacher gets `teacherPreview: true` so the classroom can keep the edit
 * affordances; students read the frozen snapshot only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid course id');
    }
    const snapshot = await getPublishedSnapshot(id);
    if (!snapshot) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Course not found');
    }
    const teacherSession = getTeacherSession(request);
    return apiSuccess({
      course: {
        id: snapshot.courseId,
        title: snapshot.stage.name,
        version: snapshot.version,
      },
      version: snapshot.version,
      teacherPreview: teacherSession !== null,
    });
  } catch (error) {
    log.error('Student course read failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to load course');
  }
}
