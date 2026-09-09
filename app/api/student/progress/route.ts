import { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { getStudentSession } from '@/lib/server/student-auth';
import { reportProgress } from '@/lib/server/courseware/student-progress';

const reportSchema = z.object({
  courseId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  sceneId: z.string().min(1).max(128),
  sceneOrder: z.number().int().min(1).max(10000),
});

/**
 * Learning-progress beacon from the classroom player: one call per scene the
 * student lands on. Student session required; the server keeps the max order
 * seen so navigating back never regresses the recorded progress.
 */
export async function POST(request: NextRequest) {
  const session = getStudentSession(request);
  if (!session) {
    return apiError(API_ERROR_CODES.UNAUTHENTICATED, 401, 'student session required');
  }
  const parsed = reportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid progress payload');
  }
  try {
    await reportProgress({
      studentId: session.sid,
      courseId: parsed.data.courseId,
      sceneId: parsed.data.sceneId,
      sceneOrder: parsed.data.sceneOrder,
    });
    return apiSuccess({ ok: true });
  } catch {
    // Progress reporting must never break playback; failures are dropped.
    return apiSuccess({ ok: false });
  }
}
