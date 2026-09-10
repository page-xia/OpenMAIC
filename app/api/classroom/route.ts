import { type NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { validateScene } from '@openmaic/dsl';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  buildRequestOrigin,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
} from '@/lib/server/classroom-storage';
import { sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';
import { documentStoreFor, getPublishedSnapshot } from '@/lib/server/courseware/course-repo';
import { getStudentSession } from '@/lib/server/student-auth';
import { getTeacherSession } from '@/lib/server/teacher-auth';
import { createLogger } from '@/lib/logger';
import { startRequestLog } from '@/lib/server/request-log';

const log = createLogger('Classroom API');

function describeSceneIssue(issue: { path: string; message: string }): string {
  const at = issue.path && issue.path !== '' ? issue.path : '/';
  return `${at}: ${issue.message}`;
}

export async function POST(request: NextRequest) {
  let stageId: string | undefined;
  let sceneCount: number | undefined;
  try {
    const body = await request.json();
    const { stage, scenes } = body;
    stageId = stage?.id;
    sceneCount = scenes?.length;

    if (!stage || !scenes) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required fields: stage, scenes',
      );
    }

    if (typeof stage !== 'object' || Array.isArray(stage)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom stage');
    }
    if (!Array.isArray(scenes)) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        'Invalid classroom scenes: must be an array',
      );
    }

    // The scenes must already have the shape the slide DSL declares (id,
    // stageId, title, order, type and a content payload bound to that type).
    // Rejecting malformed scenes here keeps garbage out of storage instead of
    // letting viewers choke on it later.
    for (const [index, scene] of scenes.entries()) {
      const result = validateScene(scene);
      if (!result.valid) {
        const first = result.errors[0];
        return apiError(
          API_ERROR_CODES.INVALID_REQUEST,
          400,
          `Invalid classroom scene at index ${index}`,
          first ? describeSceneIssue(first) : undefined,
        );
      }
    }

    const id = stage.id || randomUUID();

    // An id that fails the allowlist never reaches the filesystem: the storage
    // layer joins the id into CLASSROOMS_DIR, so a traversal-style id must be
    // rejected here with the same contract the read side already enforces.
    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const baseUrl = buildRequestOrigin(request);

    // Sanitize every HTML-bearing string in the payload before it reaches
    // storage: stored slide HTML is restricted to the formatting vocabulary
    // the renderer produces (see sanitize-scene-content.ts).
    const safeStage = sanitizeSceneContent(stage);
    const safeScenes = sanitizeSceneContent(scenes);

    const persisted = await persistClassroom(
      { id, stage: { ...safeStage, id }, scenes: safeScenes },
      baseUrl,
    );

    return apiSuccess({ id: persisted.id, url: persisted.url }, 201);
  } catch (error) {
    log.error(
      `Classroom storage failed [stageId=${stageId ?? 'unknown'}, scenes=${sceneCount ?? 0}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to store classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function GET(request: NextRequest) {
  const reqLog = startRequestLog(log, request);
  try {
    const id = request.nextUrl.searchParams.get('id');
    reqLog.set({ classroomId: id });

    if (!id) {
      reqLog.done(400, { reason: 'missing_id' });
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: id',
      );
    }

    if (!isValidClassroomId(id)) {
      reqLog.done(400, { reason: 'invalid_id' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    // Courseware-backend courses are the authority when present: students (and
    // teacher previews) read the latest published snapshot from PostgreSQL.
    // Published content is the gated surface: a signed-in student or teacher
    // reads it; everyone else gets 401 (the login page is the client-side
    // redirect). Workbench classrooms stay on the filesystem branch below,
    // which keeps the agent workspace's own pane flow untouched.
    const snapshot = await getPublishedSnapshot(id).catch((error: unknown) => {
      log.warn(`Published snapshot lookup failed [id=${id}]:`, error);
      return null;
    });
    if (snapshot) {
      const studentSession = getStudentSession(request);
      const teacherSession = getTeacherSession(request);
      if (!studentSession && !teacherSession) {
        // The single most common "学生进不去课堂" report: a missing/expired
        // session cookie. Logged with the cookie's absence made explicit.
        reqLog.done(401, { source: 'published', reason: 'no_session' }, 'warn');
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 401, '请先登录后进入课堂');
      }
      reqLog.done(200, {
        source: 'published',
        viewer: teacherSession ? 'teacher' : 'student',
        studentId: studentSession?.sid,
        sceneCount: snapshot.scenes.length,
        version: snapshot.version,
      });
      return apiSuccess({
        classroom: sanitizeSceneContent({
          id: snapshot.courseId,
          stage: snapshot.stage,
          scenes: snapshot.scenes,
        }),
      });
    }

    // Not published — a draft has no snapshot, so the published branch above
    // cannot serve it. The owner teacher previews the LIVE draft document:
    // without this, "预览课堂" on a course the teacher has not published yet
    // 404s and the classroom shell sits empty, so the author cannot see the
    // course before deciding whether to publish it.
    //
    // The read is owner-scoped (`documentStoreFor(tid).loadDocument` filters on
    // owner_id), so this branch doubles as the authorization check: a teacher
    // asking for a course they do not own gets null and falls through to the
    // filesystem/404 path. Students and anonymous visitors never reach it — a
    // draft is not theirs to see.
    const teacherSession = getTeacherSession(request);
    if (teacherSession) {
      const document = await documentStoreFor(teacherSession.tid)
        .loadDocument(id)
        .catch((error: unknown) => {
          log.warn(`Draft document lookup failed [id=${id}, teacher=${teacherSession.tid}]:`, error);
          return null;
        });
      if (document) {
        reqLog.done(200, {
          source: 'draft',
          viewer: 'teacher',
          sceneCount: document.scenes.length,
        });
        return apiSuccess({
          classroom: sanitizeSceneContent({
            id,
            stage: document.stage,
            scenes: document.scenes,
          }),
        });
      }
    }

    const classroom = await readClassroom(id);
    if (!classroom) {
      reqLog.done(404, { source: 'filesystem', reason: 'not_found' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    // Classroom files written before this change were stored unsanitized and
    // cannot be migrated on deployments we do not control. Run the same
    // sanitizer over the payload on the way out so already-stored content is
    // cleaned at the single serve choke point too.
    reqLog.done(200, { source: 'filesystem', sceneCount: classroom.scenes.length });
    return apiSuccess({ classroom: sanitizeSceneContent(classroom) });
  } catch (error) {
    reqLog.fail(error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to retrieve classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}
