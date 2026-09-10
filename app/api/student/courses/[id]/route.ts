import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { getDraftDocumentInfo, getPublishedSnapshot } from '@/lib/server/courseware/course-repo';
import { getTeacherSession } from '@/lib/server/teacher-auth';
import { getStudentSession } from '@/lib/server/student-auth';
import { createLogger } from '@/lib/logger';
import { startRequestLog } from '@/lib/server/request-log';

const log = createLogger('StudentCourse');

/**
 * Student-facing published-course read: the full snapshot for classroom
 * playback plus the version students should cache against. A signed-in
 * teacher gets `teacherPreview: true` so the classroom can keep the edit
 * affordances; students read the frozen snapshot only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const reqLog = startRequestLog(log, request);
  try {
    const { id } = await params;
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      reqLog.done(400, { courseId: id, reason: 'invalid_id' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid course id');
    }
    const snapshot = await getPublishedSnapshot(id);
    const teacherSession = getTeacherSession(request);

    if (!snapshot) {
      // Unpublished. The owner teacher previewing their own draft gets a
      // metadata answer (no version; a `draftUpdatedAt` freshness marker
      // instead) so the classroom can (a) load the draft from `/api/classroom`
      // and (b) drop a locally cached copy that predates the latest edit —
      // preview of a draft must reflect the edits, or there is no way to judge
      // whether it is ready to publish. `getDraftDocumentInfo` is owner-scoped,
      // so anyone else still gets the same 404 as a course that never existed.
      const draft = teacherSession
        ? await getDraftDocumentInfo(teacherSession.tid, id).catch((error: unknown) => {
            reqLog.fail(error, { courseId: id });
            return null;
          })
        : null;
      if (draft) {
        reqLog.done(200, { courseId: id, source: 'draft', teacherPreview: true });
        return apiSuccess({
          course: { id, title: draft.name, version: 0 },
          version: 0,
          teacherPreview: true,
          draftUpdatedAt: draft.updatedAt,
        });
      }
      reqLog.done(404, { courseId: id, reason: 'not_found' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Course not found');
    }
    reqLog.done(200, {
      courseId: id,
      studentId: getStudentSession(request)?.sid,
      teacherPreview: teacherSession !== null,
      version: snapshot.version,
    });
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
    reqLog.fail(error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to load course');
  }
}
