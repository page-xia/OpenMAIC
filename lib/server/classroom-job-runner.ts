import { createLogger } from '@/lib/logger';
import {
  generateClassroom,
  type ClassroomGenerationState,
  type GenerateClassroomInput,
} from '@/lib/server/classroom-generation';
import {
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  markClassroomJobActive,
  markClassroomJobInactive,
  saveClassroomGenerationCheckpoint,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';

const log = createLogger('ClassroomJob');
const runningJobs = new Map<string, Promise<void>>();

/** Where a job came from, so a failure can be traced back to a request/actor. */
export interface ClassroomJobContext {
  /** `x-request-id` (or generated id) of the POST that created the job. */
  requestId?: string;
  /** Who asked — a teacher/student id or 'anonymous'; never a secret. */
  actor?: string;
}

function summarizeInput(input: GenerateClassroomInput): Record<string, unknown> {
  return {
    requirementChars: input.requirement.length,
    hasPdf: !!input.pdfContent,
    pdfTextChars: input.pdfContent?.text.length ?? 0,
    pdfImages: input.pdfContent?.images.length ?? 0,
    webSearch: input.enableWebSearch ?? false,
    imageGen: input.enableImageGeneration ?? false,
    videoGen: input.enableVideoGeneration ?? false,
    tts: input.enableTTS ?? false,
    agentMode: input.agentMode ?? 'default',
  };
}

export function runClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  baseUrl: string,
  context: ClassroomJobContext = {},
  resume?: ClassroomGenerationState,
): Promise<void> {
  const existing = runningJobs.get(jobId);
  if (existing) {
    log.warn(`Job ${jobId} is already running in this process; reusing the existing run.`);
    return existing;
  }

  const startedAt = Date.now();
  const jobPromise = (async () => {
    log.info(resume ? `Job ${jobId} resumed` : `Job ${jobId} started`, {
      ...summarizeInput(input),
      ...(resume ? { resumedScenes: resume.scenes.length, totalScenes: resume.outlines.length } : {}),
      ...(context.requestId ? { req: context.requestId } : {}),
      ...(context.actor ? { actor: context.actor } : {}),
    });
    markClassroomJobActive(jobId);
    try {
      await markClassroomGenerationJobRunning(jobId);

      const result = await generateClassroom(input, {
        baseUrl,
        onProgress: async (progress) => {
          await updateClassroomGenerationJobProgress(jobId, progress);
        },
        // Persist the resumable snapshot after the plan and after every page.
        // A checkpoint write must never fail generation: the classroom is the
        // product, the snapshot is an optimization.
        onCheckpoint: async (state) => {
          try {
            await saveClassroomGenerationCheckpoint(jobId, state);
          } catch (err) {
            log.warn(`Failed to persist checkpoint for job ${jobId} (continuing):`, err);
          }
        },
        ...(resume ? { resume } : {}),
      });

      await markClassroomGenerationJobSucceeded(jobId, result);
      log.info(`Job ${jobId} succeeded in ${Date.now() - startedAt}ms`, {
        classroomId: result.id,
        scenes: result.scenesCount,
        url: result.url,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Job ${jobId} failed after ${Date.now() - startedAt}ms:`, error);
      try {
        await markClassroomGenerationJobFailed(jobId, message);
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for job ${jobId}:`, markFailedError);
      }
    } finally {
      markClassroomJobInactive(jobId);
      runningJobs.delete(jobId);
    }
  })();

  runningJobs.set(jobId, jobPromise);
  return jobPromise;
}
