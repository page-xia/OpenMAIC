/**
 * Courseware document-store adapter that shapes the teacher courseware store
 * (`CoursewareDocumentStore`) into the agent runtime's `CourseStore` contract.
 *
 * The agent toolset types its store as `DocumentStore & DocumentFolderStore`
 * (plus, on the PG path, `StageFreshnessManifestStore`), while the courseware
 * schema has no folder tables and no trigger-maintained revision columns.
 * This adapter fills those gaps deliberately:
 *
 *  - Folders are absent by construction: every folder op is a no-op that
 *    reports "not found" / "nothing filed", so folder tools see an owner with
 *    no folders rather than a crash. The agent's course tools still work —
 *    they only consult folders for organization prompts.
 *  - The freshness manifest degrades to a snapshot derived from the rows
 *    themselves: every write seam in the courseware schema bumps the stage's
 *    `updated_at`, so the stage stamp stands in for the trigger-maintained
 *    per-row revision as a change-detection signal.
 *
 * Document CRUD passes straight through to the wrapped courseware store —
 * that part already implements the full `DocumentStore` interface.
 */
import type {
  DocumentFolder,
  DocumentFolderStore,
  DocumentStore,
  StageFreshnessManifest,
  StageFreshnessManifestStore,
} from '@openmaic/storage';

import { query } from '@/lib/server/db/pg';
import type { AppStage } from '@/lib/document-store/persistence-types';
import type { AppScene } from '@/lib/types/stage';

export type TeacherAgentDocumentStore = DocumentStore<AppScene, AppStage> &
  DocumentFolderStore &
  StageFreshnessManifestStore;

interface StageRowMeta {
  id: string;
  updated_at: number;
}

interface SceneRowMeta {
  id: string;
  scene_order: number;
}

/**
 * Shape the courseware store into the agent runtime's store contract.
 * `ownerId` is the teacher id the store was constructed with (repeated here
 * because `CoursewareDocumentStore` keeps its options private).
 */
export function asTeacherAgentDocumentStore(
  store: DocumentStore<AppScene, AppStage>,
  ownerId: string,
): TeacherAgentDocumentStore {
  const folders: DocumentFolderStore = {
    async createFolder() {
      throw new Error('folders are not supported in the teacher courseware workspace');
    },
    async listFolders(): Promise<DocumentFolder[]> {
      return [];
    },
    async renameFolder() {
      return null;
    },
    async deleteFolder() {
      return null;
    },
    async moveDocumentToFolder() {
      return false;
    },
    async setStageFolder() {
      return false;
    },
    async listDocuments(folderId?: string) {
      // A folder filter can only select nothing: this owner has no folders.
      return folderId ? [] : store.listDocuments();
    },
  };

  const freshness: StageFreshnessManifestStore = {
    async readFreshnessManifest(stageId): Promise<StageFreshnessManifest | null> {
      const stageRows = await query<StageRowMeta>(
        'SELECT id, updated_at FROM document_stages WHERE id = $1 AND owner_id = $2',
        [stageId, ownerId],
      );
      const stage = stageRows[0];
      if (!stage) return null;
      const sceneRows = await query<SceneRowMeta>(
        'SELECT id, scene_order FROM document_scenes WHERE stage_id = $1 ORDER BY scene_order, id',
        [stageId],
      );
      const rev = Number(stage.updated_at);
      return {
        rev,
        scenes: sceneRows.map((row) => ({
          id: row.id,
          order: Number(row.scene_order),
          rev,
        })),
      };
    },
  };

  return Object.assign(Object.create(Object.getPrototypeOf(store)), store, folders, freshness);
}
