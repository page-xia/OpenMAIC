import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { documentStoreFor } from '@/lib/server/courseware/course-repo';
import { synthesizeSceneNarration } from '@/lib/server/agent-runtime/scene-tts';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('TeacherTts');

export const maxDuration = 300;

/**
 * Batch-generate narration audio for a course's speech actions using the
 * server-configured TTS provider (roster voice when bound). Audio lands under
 * the classroom-media path and each action's `audioUrl` points at it, so the
 * student player fetches and plays it with zero configuration. Publish after
 * generating to include the audio in the student-facing snapshot.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireTeacher(request);
    const { id } = await params;
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid course id');
    }
    const body = (await request.json().catch(() => ({}))) as { force?: boolean };
    const force = body.force === true;

    const store = documentStoreFor(session.tid);
    const document = await store.loadDocument(id);
    if (!document) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Course not found');
    }

    const roster = document.stage.generatedAgentConfigs ?? null;
    let generated = 0;
    let skipped = 0;
    const failed: string[] = [];
    let available = true;

    for (const scene of document.scenes) {
      const summary = await synthesizeSceneNarration({ scene, force, roster });
      if (!summary.available) {
        available = false;
        break;
      }
      generated += summary.generated;
      skipped += summary.skipped;
      failed.push(...summary.failed);
    }

    if (!available) {
      return apiError(
        API_ERROR_CODES.MISSING_API_KEY,
        503,
        '尚未配置可用的服务端 TTS 服务：请在「系统设置 → 语音合成」中配置后重试',
      );
    }

    // The scenes were mutated in place; one aggregate write persists the
    // stamped audio refs (validation unchanged — the document store owns it).
    await store.saveDocument(document);

    return apiSuccess({ generated, skipped, failed });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Course TTS generation failed:', error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      '语音生成失败',
      error instanceof Error ? error.message : String(error),
    );
  }
}
