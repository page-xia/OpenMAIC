import { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { readClassroom } from '@/lib/server/classroom-storage';
import { createCourse } from '@/lib/server/courseware/course-repo';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';
import { sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';
import { createLogger } from '@/lib/logger';
import type { AppScene } from '@/lib/types/stage';

const log = createLogger('TeacherClaim');

const claimSchema = z.object({
  classroomId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  titleOverride: z.string().trim().min(1).max(200).optional(),
});

/**
 * Claim a server-generated classroom (the `/api/generate-classroom` job output)
 * into the teacher workspace. Generated media keep their existing
 * concrete URLs (served by `/api/classroom-media`), so the claim is metadata +
 * document only.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireTeacher(request);
    const parsed = claimSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid claim request');
    }

    const classroom = await readClassroom(parsed.data.classroomId);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    const stage = sanitizeSceneContent(classroom.stage);
    const scenes = sanitizeSceneContent(classroom.scenes) as AppScene[];
    const course = await createCourse(session.tid, {
      title: parsed.data.titleOverride?.trim() || stage.name || 'AI 生成的课件',
      ...(stage.description ? { description: stage.description } : {}),
      source: 'ai_generation',
      stage,
      scenes,
    });
    return apiSuccess({ course }, 201);
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Claim classroom failed:', error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to claim classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}
