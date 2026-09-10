import { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { startRequestLog } from '@/lib/server/request-log';
import { getStudentSession } from '@/lib/server/student-auth';
import { reportProgress } from '@/lib/server/courseware/student-progress';

const log = createLogger('StudentProgress');

const reportSchema = z.object({
  courseId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  sceneId: z.string().min(1).max(128),
  sceneOrder: z.number().int().min(1).max(10000),
});

/**
 * Learning-progress beacon from the classroom player: one call per scene the
 * student lands on. Student session required; the server keeps the max order
 * seen so navigating back never regresses the recorded progress.
 *
 * Successful writes log at `debug` — one line per scene switch is the highest
 * volume path in the product and would drown the operational log at info.
 * Failures are the diagnostic signal, so they are logged at `warn`.
 */
export async function POST(request: NextRequest) {
  const reqLog = startRequestLog(log, request);
  const session = getStudentSession(request);
  if (!session) {
    reqLog.done(401, { reason: 'no_session' }, 'warn');
    return apiError(API_ERROR_CODES.UNAUTHENTICATED, 401, 'student session required');
  }
  const parsed = reportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    reqLog.done(400, { studentId: session.sid, reason: 'invalid_payload' }, 'warn');
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid progress payload');
  }
  const { courseId, sceneId, sceneOrder } = parsed.data;
  try {
    await reportProgress({ studentId: session.sid, courseId, sceneId, sceneOrder });
    reqLog.done(200, { studentId: session.sid, courseId, sceneId, sceneOrder }, 'debug');
    return apiSuccess({ ok: true });
  } catch (error) {
    // Progress reporting must never break playback; failures are dropped from
    // the response but logged, since a silent progress loss is invisible.
    reqLog.done(200, { studentId: session.sid, courseId, sceneId, sceneOrder, ok: false }, 'warn');
    log.warn('Progress write failed (dropped):', error);
    return apiSuccess({ ok: false });
  }
}
