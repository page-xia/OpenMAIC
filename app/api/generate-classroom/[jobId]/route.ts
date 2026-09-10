import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isValidClassroomJobId,
  readClassroomGenerationJob,
} from '@/lib/server/classroom-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';
import { startRequestLog } from '@/lib/server/request-log';

const log = createLogger('ClassroomJob API');

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const reqLog = startRequestLog(log, req);
  try {
    const { jobId } = await context.params;
    reqLog.set({ jobId });

    if (!isValidClassroomJobId(jobId)) {
      reqLog.done(400, { reason: 'invalid_id' });
      return apiError('INVALID_REQUEST', 400, 'Invalid classroom generation job id');
    }

    const job = await readClassroomGenerationJob(jobId);
    if (!job) {
      reqLog.done(404, { reason: 'not_found' });
      return apiError('INVALID_REQUEST', 404, 'Classroom generation job not found');
    }

    const pollUrl = `${buildRequestOrigin(req)}/api/generate-classroom/${jobId}`;

    // A poll every 5s per viewer is the highest-volume generation-path call, so
    // success is debug; the runner logs the terminal success/failure itself.
    reqLog.done(200, { status: job.status, step: job.step, progress: job.progress }, 'debug');

    return apiSuccess({
      jobId: job.id,
      status: job.status,
      step: job.step,
      progress: job.progress,
      message: job.message,
      pollUrl,
      pollIntervalMs: 5000,
      scenesGenerated: job.scenesGenerated,
      totalScenes: job.totalScenes,
      result: job.result,
      error: job.error,
      done: job.status === 'succeeded' || job.status === 'failed',
      // A failed job with saved progress can be resumed from where it stopped
      // instead of regenerating the pages already produced.
      resumable: job.status === 'failed' && !!job.checkpoint,
      ...(job.checkpoint ? { checkpoint: job.checkpoint } : {}),
    });
  } catch (error) {
    reqLog.fail(error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to retrieve classroom generation job',
      error instanceof Error ? error.message : String(error),
    );
  }
}
