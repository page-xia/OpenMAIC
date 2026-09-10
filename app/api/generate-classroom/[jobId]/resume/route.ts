import { after, type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { isResumableGenerationState } from '@/lib/server/classroom-generation';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import {
  isValidClassroomJobId,
  readClassroomGenerationCheckpoint,
  readClassroomGenerationJob,
  readClassroomGenerationJobInput,
} from '@/lib/server/classroom-job-store';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { createLogger } from '@/lib/logger';
import { startRequestLog } from '@/lib/server/request-log';

const log = createLogger('GenerateClassroom Resume API');

export const maxDuration = 30;

/**
 * Resume a classroom generation job that stopped partway.
 *
 * The durable checkpoint lets the run pick up at the first unfinished page:
 * outlines, agents, and the already-generated pages are reused verbatim, so a
 * failure at page 9 of 11 does not re-spend the tokens for pages 1-8. The job
 * keeps its id, so the caller resumes polling the same `jobId`.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
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
    if (job.status === 'running') {
      reqLog.done(409, { reason: 'already_running' });
      return apiError('INVALID_REQUEST', 409, 'Generation is already running');
    }
    if (job.status === 'succeeded') {
      reqLog.done(409, { reason: 'already_succeeded' });
      return apiError('INVALID_REQUEST', 409, 'Generation already completed');
    }

    const [input, resume] = await Promise.all([
      readClassroomGenerationJobInput(jobId),
      readClassroomGenerationCheckpoint(jobId),
    ]);
    if (!input) {
      reqLog.done(409, { reason: 'no_input' });
      return apiError(
        'INVALID_REQUEST',
        409,
        'This job has no stored input to resume from; start a new generation',
      );
    }
    if (!resume || !isResumableGenerationState(resume)) {
      reqLog.done(409, { reason: 'no_checkpoint' });
      return apiError(
        'INVALID_REQUEST',
        409,
        'This job has no saved progress to resume from; start a new generation',
      );
    }

    const baseUrl = buildRequestOrigin(req);
    const pollUrl = `${baseUrl}/api/generate-classroom/${jobId}`;
    reqLog.done(202, {
      resumedScenes: resume.scenes.length,
      totalScenes: resume.outlines.length,
    });

    after(() =>
      runClassroomGenerationJob(jobId, input, baseUrl, {
        requestId: reqLog.id,
        actor: 'resume',
      }, resume),
    );

    return apiSuccess(
      {
        jobId,
        status: 'running',
        step: job.step,
        message: `Resuming generation from page ${resume.scenes.length + 1}`,
        pollUrl,
        pollIntervalMs: 5000,
        scenesGenerated: resume.scenes.length,
        totalScenes: resume.outlines.length,
      },
      202,
    );
  } catch (error) {
    reqLog.fail(error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to resume classroom generation job',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
