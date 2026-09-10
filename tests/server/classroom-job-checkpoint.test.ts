import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Point the job store at a per-test temp directory so the checkpoint files
// never touch the repo's data/ dir.
const dirs = vi.hoisted(() => ({ jobs: '' }));

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/classroom-storage')>();
  return {
    ...actual,
    get CLASSROOM_JOBS_DIR() {
      return dirs.jobs;
    },
    ensureClassroomJobsDir: async () => {
      await fs.mkdir(dirs.jobs, { recursive: true });
    },
  };
});

const stage = { id: 'stage-1', name: 'Course', style: 'interactive' } as never;
const outline = { id: 'outline-1', order: 0, title: 'Page', type: 'slide' } as never;

describe('classroom job checkpoint store', () => {
  beforeEach(async () => {
    dirs.jobs = await fs.mkdtemp(path.join(os.tmpdir(), 'maic-jobs-'));
    vi.resetModules();
  });

  afterEach(async () => {
    await fs.rm(dirs.jobs, { recursive: true, force: true });
  });

  it('round-trips a checkpoint and mirrors a summary onto the job', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    await store.createClassroomGenerationJob('job1', { requirement: 'teach' } as never);
    await store.saveClassroomGenerationCheckpoint('job1', {
      languageDirective: 'Use English.',
      outlines: [outline],
      agents: [],
      agentMode: 'default',
      stage,
      scenes: [{ id: 'scene-1', order: 0 }] as never,
    });

    const job = await store.readClassroomGenerationJob('job1');
    expect(job?.checkpoint).toMatchObject({ scenesGenerated: 1, totalScenes: 1 });

    const readBack = await store.readClassroomGenerationCheckpoint('job1');
    expect(readBack?.outlines).toHaveLength(1);
    expect(readBack?.scenes).toHaveLength(1);
    expect(readBack?.stage).toMatchObject({ id: 'stage-1' });
  });

  it('persists the exact input so a resume can rebuild the run', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    const input = { requirement: 'teach', enableTTS: true, pdfContent: { text: 'x', images: [] } };
    await store.createClassroomGenerationJob('job2', input as never);
    expect(await store.readClassroomGenerationJobInput('job2')).toMatchObject(input);
  });

  it('drops the checkpoint when the job succeeds, so it cannot be resumed', async () => {
    const store = await import('@/lib/server/classroom-job-store');
    await store.createClassroomGenerationJob('job3', { requirement: 'teach' } as never);
    await store.saveClassroomGenerationCheckpoint('job3', {
      languageDirective: '',
      outlines: [outline],
      agents: [],
      agentMode: 'default',
      stage,
      scenes: [],
    } as never);
    await store.markClassroomGenerationJobSucceeded('job3', {
      id: 'classroom-1',
      url: 'http://localhost/classroom/classroom-1',
      scenesCount: 1,
    } as never);

    expect(await store.readClassroomGenerationCheckpoint('job3')).toBeNull();
    const job = await store.readClassroomGenerationJob('job3');
    expect(job?.status).toBe('succeeded');
    expect(job?.checkpoint).toBeUndefined();
  });
});
