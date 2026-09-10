import { promises as fs } from 'fs';
import path from 'path';
import type {
  ClassroomGenerationProgress,
  ClassroomGenerationState,
  ClassroomGenerationStep,
  GenerateClassroomInput,
  GenerateClassroomResult,
} from '@/lib/server/classroom-generation';
import { createLogger } from '@/lib/logger';
import {
  CLASSROOM_JOBS_DIR,
  ensureClassroomJobsDir,
  writeJsonFileAtomic,
} from '@/lib/server/classroom-storage';

const log = createLogger('ClassroomJobStore');

export type ClassroomGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ClassroomGenerationJob {
  id: string;
  status: ClassroomGenerationJobStatus;
  step: ClassroomGenerationStep | 'queued' | 'failed';
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  inputSummary: {
    requirementPreview: string;
    hasPdf: boolean;
    pdfTextLength: number;
    pdfImageCount: number;
  };
  scenesGenerated: number;
  totalScenes?: number;
  result?: {
    classroomId: string;
    url: string;
    scenesCount: number;
  };
  error?: string;
  /**
   * Summary of the last durable resumable snapshot (see the checkpoint file
   * beside the job file). Present while pages have been checkpointed and the
   * state has not been discarded; the UI uses it to offer "resume" after a
   * failure and the resume route requires it.
   */
  checkpoint?: {
    scenesGenerated: number;
    totalScenes: number;
    savedAt: string;
  };
}

function jobFilePath(jobId: string) {
  return path.join(CLASSROOM_JOBS_DIR, `${jobId}.json`);
}

/**
 * The resumable checkpoint lives in its own file, not in the job record: it
 * carries the full outlines/agents/scenes (potentially hundreds of KB), and the
 * job record is returned to a client on every 5s poll. Splitting them keeps the
 * poll payload small.
 */
function checkpointFilePath(jobId: string) {
  return path.join(CLASSROOM_JOBS_DIR, `${jobId}.checkpoint.json`);
}

/**
 * The exact input a job was created with (including any PDF text), kept beside
 * the job so a resume can rebuild the run. The job record itself only carries a
 * truncated preview, which is not enough to regenerate the same course.
 */
function inputFilePath(jobId: string) {
  return path.join(CLASSROOM_JOBS_DIR, `${jobId}.input.json`);
}

function buildInputSummary(input: GenerateClassroomInput): ClassroomGenerationJob['inputSummary'] {
  return {
    requirementPreview:
      input.requirement.length > 200 ? `${input.requirement.slice(0, 197)}...` : input.requirement,
    hasPdf: !!input.pdfContent,
    pdfTextLength: input.pdfContent?.text.length || 0,
    pdfImageCount: input.pdfContent?.images.length || 0,
  };
}

/** Simple per-job mutex to serialize read-modify-write on the same job file. */
const jobLocks = new Map<string, Promise<void>>();

async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = jobLocks.get(jobId) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  jobLocks.set(jobId, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve!();
    if (jobLocks.get(jobId) === next) jobLocks.delete(jobId);
  }
}

/** Max age (ms) before a "running" job without an active runner is considered stale. */
const STALE_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Job ids whose runner is live in *this* process.
 *
 * A job file can be left in `running` when the server exits mid-generation (a
 * container restart, a kill): the runner's `catch` never gets to write a
 * failure, so the status is a lie forever after. The in-process set lets a poll
 * detect that immediately instead of waiting out the 30-minute stale sweep —
 * which is what made a generation look like it "stopped halfway, neither
 * succeeded nor failed". A per-process set is enough because one container runs
 * a single Next server process; a fresh process starts with an empty set and so
 * correctly identifies every inherited `running` job as interrupted.
 */
const activeJobIds = new Set<string>();

/** Mark a job as having a live runner in this process. */
export function markClassroomJobActive(jobId: string): void {
  activeJobIds.add(jobId);
}

/** Drop a job from the live-runner registry (runner finished or crashed). */
export function markClassroomJobInactive(jobId: string): void {
  activeJobIds.delete(jobId);
}

/**
 * Jobs already reported as interrupted/stale. `markStaleIfNeeded` is derived on
 * every poll (it returns a failed-shaped view without persisting), so without
 * this set a stuck job would log the same warning every `pollIntervalMs`.
 * Bounded because interrupted jobs are incidents, not the steady state: if the
 * set ever grew past the cap we drop the oldest, which at worst re-logs one
 * ancient job's warning.
 */
const staleReported = new Set<string>();
const STALE_REPORTED_MAX = 500;

function rememberStale(jobId: string): void {
  if (staleReported.has(jobId)) return;
  if (staleReported.size >= STALE_REPORTED_MAX) {
    const oldest = staleReported.values().next().value;
    if (oldest !== undefined) staleReported.delete(oldest);
  }
  staleReported.add(jobId);
}

function markStaleIfNeeded(job: ClassroomGenerationJob): ClassroomGenerationJob {
  if (job.status !== 'running') return job;

  const reportOnce = (reason: string) => {
    if (staleReported.has(job.id)) return;
    rememberStale(job.id);
    log.warn(`Job ${job.id} reported as failed (${reason})`, {
      step: job.step,
      progress: job.progress,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
    });
  };

  if (!activeJobIds.has(job.id)) {
    reportOnce('runner not active in this process');
    return {
      ...job,
      status: 'failed',
      step: 'failed',
      message: 'Job was interrupted',
      error:
        'Generation was interrupted before it finished (the server restarted or the process exited). Please start it again.',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const updatedAt = new Date(job.updatedAt).getTime();
  if (Date.now() - updatedAt > STALE_JOB_TIMEOUT_MS) {
    reportOnce('no progress for 30 minutes');
    return {
      ...job,
      status: 'failed',
      step: 'failed',
      message: 'Job appears stale (no progress update for 30 minutes)',
      error: 'Stale job: no progress update for 30 minutes',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return job;
}

export function isValidClassroomJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(jobId);
}

export async function createClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
): Promise<ClassroomGenerationJob> {
  const now = new Date().toISOString();
  const job: ClassroomGenerationJob = {
    id: jobId,
    status: 'queued',
    step: 'queued',
    progress: 0,
    message: 'Classroom generation job queued',
    createdAt: now,
    updatedAt: now,
    inputSummary: buildInputSummary(input),
    scenesGenerated: 0,
  };

  await ensureClassroomJobsDir();
  await writeJsonFileAtomic(jobFilePath(jobId), job);
  await writeJsonFileAtomic(inputFilePath(jobId), input);
  return job;
}

/** Read the exact input a job was created with, or null when none is stored. */
export async function readClassroomGenerationJobInput(
  jobId: string,
): Promise<GenerateClassroomInput | null> {
  try {
    const content = await fs.readFile(inputFilePath(jobId), 'utf-8');
    return JSON.parse(content) as GenerateClassroomInput;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readClassroomGenerationJob(
  jobId: string,
): Promise<ClassroomGenerationJob | null> {
  try {
    const content = await fs.readFile(jobFilePath(jobId), 'utf-8');
    const job = JSON.parse(content) as ClassroomGenerationJob;
    return markStaleIfNeeded(job);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function updateClassroomGenerationJob(
  jobId: string,
  patch: Partial<ClassroomGenerationJob>,
): Promise<ClassroomGenerationJob> {
  return withJobLock(jobId, async () => {
    const existing = await readClassroomGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Classroom generation job not found: ${jobId}`);
    }

    const updated: ClassroomGenerationJob = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    return updated;
  });
}

export async function markClassroomGenerationJobRunning(
  jobId: string,
): Promise<ClassroomGenerationJob> {
  return withJobLock(jobId, async () => {
    const existing = await readClassroomGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Classroom generation job not found: ${jobId}`);
    }

    const updated: ClassroomGenerationJob = {
      ...existing,
      status: 'running',
      startedAt: existing.startedAt || new Date().toISOString(),
      message: 'Classroom generation started',
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    return updated;
  });
}

export async function updateClassroomGenerationJobProgress(
  jobId: string,
  progress: ClassroomGenerationProgress,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'running',
    step: progress.step,
    progress: progress.progress,
    message: progress.message,
    scenesGenerated: progress.scenesGenerated,
    totalScenes: progress.totalScenes,
  });
}

export async function markClassroomGenerationJobSucceeded(
  jobId: string,
  result: GenerateClassroomResult,
): Promise<ClassroomGenerationJob> {
  // The classroom is persisted and claimable, so a resumable snapshot would
  // only be stale work: drop it so `resumeClassroomGenerationJob` can't re-run
  // a finished job. (Best-effort — a failed unlink must not fail the success.)
  await deleteClassroomGenerationCheckpoint(jobId).catch(() => undefined);
  return updateClassroomGenerationJob(jobId, {
    status: 'succeeded',
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    completedAt: new Date().toISOString(),
    scenesGenerated: result.scenesCount,
    checkpoint: undefined,
    result: {
      classroomId: result.id,
      url: result.url,
      scenesCount: result.scenesCount,
    },
  });
}

export async function markClassroomGenerationJobFailed(
  jobId: string,
  error: string,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'failed',
    step: 'failed',
    message: 'Classroom generation failed',
    completedAt: new Date().toISOString(),
    error,
  });
}

/**
 * Persist one resumable snapshot for a job and mirror a small summary onto the
 * job record (for the UI). Written outside the job lock's critical section for
 * the big file, but the summary patch takes the lock so it can't race a
 * terminal mark.
 */
export async function saveClassroomGenerationCheckpoint(
  jobId: string,
  state: ClassroomGenerationState,
): Promise<void> {
  await ensureClassroomJobsDir();
  await writeJsonFileAtomic(checkpointFilePath(jobId), state);
  await updateClassroomGenerationJob(jobId, {
    checkpoint: {
      scenesGenerated: state.scenes.length,
      totalScenes: state.outlines.length,
      savedAt: new Date().toISOString(),
    },
  });
}

/** Read a job's resumable snapshot, or null when none is stored. */
export async function readClassroomGenerationCheckpoint(
  jobId: string,
): Promise<ClassroomGenerationState | null> {
  try {
    const content = await fs.readFile(checkpointFilePath(jobId), 'utf-8');
    return JSON.parse(content) as ClassroomGenerationState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Delete a job's resumable snapshot, if any. */
export async function deleteClassroomGenerationCheckpoint(jobId: string): Promise<void> {
  await fs.rm(checkpointFilePath(jobId), { force: true });
}
