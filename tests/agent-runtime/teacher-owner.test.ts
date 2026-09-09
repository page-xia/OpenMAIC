/**
 * Teacher-owner resolution for the agent runtime: the `teacher:<tid>` owner
 * partition used to bind agent sessions (and their document stores) to a
 * signed-in teacher, plus the courseware-side adapters that fill the courseware
 * schema's gaps against the agent toolset's store contract.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

import {
  teacherOwnerId,
  teacherIdFromOwner,
  TEACHER_OWNER_PREFIX,
} from '@/lib/server/agent-runtime/owner';
import { asTeacherAgentDocumentStore } from '@/lib/server/agent-runtime/teacher-documents';
import { probeTeacherStageAccess } from '@/lib/server/agent-runtime/curriculum-tools';
import * as pgModule from '@/lib/server/db/pg';

describe('teacher owner ids', () => {
  test('teacherOwnerId prefixes, teacherIdFromOwner round-trips', () => {
    const ownerId = teacherOwnerId('tch_abc');
    expect(ownerId.startsWith(TEACHER_OWNER_PREFIX)).toBe(true);
    expect(teacherIdFromOwner(ownerId)).toBe('tch_abc');
  });

  test('anonymous owners do not parse as teachers', () => {
    expect(teacherIdFromOwner('anon:00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(teacherIdFromOwner(TEACHER_OWNER_PREFIX)).toBeNull();
  });
});

describe('asTeacherAgentDocumentStore', () => {
  const baseStore = {
    listDocuments: vi.fn(async () => [
      { id: 'crs_1', name: 'One', createdAt: 1, updatedAt: 1, sceneCount: 2 },
    ]),
  };

  test('folder ops report an owner with no folders', async () => {
    const store = asTeacherAgentDocumentStore(baseStore as never, 'tch_1');
    await expect(store.listFolders()).resolves.toEqual([]);
    await expect(store.renameFolder('f1', 'x')).resolves.toBeNull();
    await expect(store.deleteFolder('f1', 'ungroup')).resolves.toBeNull();
    await expect(store.moveDocumentToFolder('crs_1', 'f1')).resolves.toBe(false);
    await expect(store.setStageFolder('crs_1', null)).resolves.toBe(false);
    await expect(store.createFolder('f1', 'x')).rejects.toThrow(/not supported/);
  });

  test('listDocuments without a folder passes through to the wrapped store', async () => {
    const store = asTeacherAgentDocumentStore(baseStore as never, 'tch_1');
    const all = await store.listDocuments();
    expect(all).toHaveLength(1);
    // A folder filter can only select nothing.
    await expect(store.listDocuments('f1')).resolves.toEqual([]);
  });

  test('readFreshnessManifest derives revs from the stage row and scopes by owner', async () => {
    const querySpy = vi
      .spyOn(pgModule, 'query')
      .mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('document_stages')) {
          expect(params).toEqual(['crs_1', 'tch_1']);
          return [{ id: 'crs_1', updated_at: 1234 }] as never;
        }
        return [
          { id: 'sc_1', scene_order: 1 },
          { id: 'sc_2', scene_order: 2 },
        ] as never;
      });

    const store = asTeacherAgentDocumentStore(baseStore as never, 'tch_1');
    const manifest = await store.readFreshnessManifest('crs_1');
    expect(manifest).toEqual({
      rev: 1234,
      scenes: [
        { id: 'sc_1', order: 1, rev: 1234 },
        { id: 'sc_2', order: 2, rev: 1234 },
      ],
    });

    querySpy.mockRestore();
  });

  test('readFreshnessManifest is null for a foreign/missing stage', async () => {
    const querySpy = vi.spyOn(pgModule, 'query').mockResolvedValue([] as never);
    const store = asTeacherAgentDocumentStore(baseStore as never, 'tch_1');
    await expect(store.readFreshnessManifest('crs_other')).resolves.toBeNull();
    querySpy.mockRestore();
  });
});

describe('probeTeacherStageAccess', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('owned stage resolves with its name', async () => {
    const querySpy = vi
      .spyOn(pgModule, 'query')
      .mockResolvedValue([{ id: 'crs_1', name: '牛顿第一定律' }] as never);
    await expect(probeTeacherStageAccess('tch_1', 'crs_1')).resolves.toEqual({
      kind: 'owned',
      stage: { stageId: 'crs_1', name: '牛顿第一定律' },
    });
    querySpy.mockRestore();
  });

  test('a foreign or missing stage collapses to foreign (no existence oracle)', async () => {
    const querySpy = vi.spyOn(pgModule, 'query').mockResolvedValue([] as never);
    await expect(probeTeacherStageAccess('tch_1', 'crs_1')).resolves.toEqual({ kind: 'foreign' });
    querySpy.mockRestore();
  });

  test('a malformed stage id never reaches the database', async () => {
    const querySpy = vi.spyOn(pgModule, 'query').mockResolvedValue([] as never);
    await expect(probeTeacherStageAccess('tch_1', 'crs 1; DROP TABLE')).resolves.toEqual({
      kind: 'missing',
    });
    expect(querySpy).not.toHaveBeenCalled();
    querySpy.mockRestore();
  });
});
