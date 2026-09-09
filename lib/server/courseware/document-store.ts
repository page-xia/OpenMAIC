/**
 * PostgreSQL DocumentStore backend for the teacher courseware workspace.
 *
 * A twin of the storage package's PostgreSQL document backend, bound to the
 * courseware schema's owner column instead of `stage_meta`: the same
 * normalized layout (`document_stages` / `document_scenes` /
 * `document_outlines`), the same split/reassemble semantics (the DSL version
 * stamp lives inside the stage payload), and the same write-boundary
 * validation. `splitDocument`/`reassembleDocument` are re-implemented here
 * because the package keeps its adapter internal.
 *
 * All operations are scoped to `ownerId` (the teacher id), including reads:
 * the teacher workspace never lists or loads another teacher's documents.
 */
import { DSL_VERSION, DSL_VERSION_KEY, dslVersionOf, migrate, needsMigration } from '@openmaic/dsl';
import type { Stage } from '@openmaic/dsl';
import type {
  DocumentStore,
  DocumentSummary,
  MaicDocument,
  SceneValidator,
  StageValidator,
} from '@openmaic/storage';
import { DocumentNotFoundError, DocumentVersionError } from '@openmaic/storage';

import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { withTransaction, query as poolQuery, type DbClient } from '@/lib/server/db/pg';

export interface CoursewareDocumentStoreOptions {
  /** Owner scope: every read, write, and listing is restricted to this teacher. */
  ownerId: string;
  validateScene: SceneValidator;
  validateStage: StageValidator;
}

interface StageTableRow {
  id: string;
  name: string;
  description: string | null;
  interactive_mode: boolean | null;
  task_engine_mode: boolean | null;
  created_at: number;
  updated_at: number;
  owner_id: string | null;
  data: unknown;
}

interface SceneTableRow {
  id: string;
  scene_order: number;
  data: unknown;
}

/** JSON columns may arrive as text (e.g. `$raw` reads); parse object/array payloads only. */
function decodeJson<T>(value: unknown): T {
  if (typeof value === 'string' && /^\s*[{\[]/.test(value)) {
    return JSON.parse(value) as T;
  }
  return value as T;
}

function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('document value is not JSON-serializable');
  return encoded;
}

/** The stage row: full stage payload plus the document version stamp. */
type StageRowWithVersion = AppStage & Record<string, unknown>;

function splitStageRow(doc: MaicDocument<AppScene, AppStage>): StageRowWithVersion {
  return { ...doc.stage, [DSL_VERSION_KEY]: DSL_VERSION } as StageRowWithVersion;
}

function reassemble(
  stageRowData: unknown,
  sceneRows: SceneTableRow[],
  outline: unknown,
): MaicDocument<AppScene, AppStage> {
  const stageRow = decodeJson<StageRowWithVersion>(stageRowData);
  const { [DSL_VERSION_KEY]: rawVersion, ...stageFields } = stageRow;
  const dslVersion = typeof rawVersion === 'string' ? rawVersion : undefined;
  const stage = stageFields as unknown as AppStage;
  const scenes = [...sceneRows]
    .map((row) => decodeJson<AppScene>(row.data))
    .sort((a, b) => a.order - b.order);
  const doc: MaicDocument<AppScene, AppStage> = { stage, scenes, dslVersion };
  if (outline !== undefined && outline !== null) doc.outline = outline;
  return doc;
}

function assertValid(
  result: ReturnType<SceneValidator>,
  label: string,
): asserts result is { valid: true } {
  if (result.valid) return;
  const detail = result.errors.map((error) => `${error.path || '/'}: ${error.message}`).join('; ');
  throw new Error(`@openmaic/storage: invalid ${label}: ${detail}`);
}

function assertStorableScene(scene: AppScene, stageId: string): void {
  if (typeof scene.id !== 'string' || scene.id === '') {
    throw new Error(`@openmaic/storage: scene id must be a non-empty string`);
  }
  if (scene.stageId !== stageId) {
    throw new Error(
      `@openmaic/storage: scene ${JSON.stringify(scene.id)} has stageId ` +
        `${JSON.stringify(scene.stageId)} but belongs to document ${JSON.stringify(stageId)}`,
    );
  }
  if (typeof scene.order !== 'number' || !Number.isFinite(scene.order)) {
    throw new Error(
      `@openmaic/storage: scene ${JSON.stringify(scene.id)} order must be a finite number`,
    );
  }
}

async function readStageRow(
  connection: DbClient,
  ownerId: string,
  stageId: string,
): Promise<StageTableRow | null> {
  const rows = await connection.query<StageTableRow>(
    'SELECT id, name, description, interactive_mode, task_engine_mode, created_at, updated_at, owner_id, data ' +
      'FROM document_stages WHERE id = $1 AND owner_id = $2',
    [stageId, ownerId],
  );
  return rows[0] ?? null;
}

async function readSceneRows(connection: DbClient, stageId: string): Promise<SceneTableRow[]> {
  return connection.query<SceneTableRow>(
    'SELECT id, scene_order, data FROM document_scenes WHERE stage_id = $1 ORDER BY scene_order, id',
    [stageId],
  );
}

/** Guard incremental writes: the stored document must be at the current version. */
async function requireCurrentDocument(
  connection: DbClient,
  ownerId: string,
  stageId: string,
): Promise<StageTableRow> {
  const row = await readStageRow(connection, ownerId, stageId);
  if (row === null) {
    throw new DocumentNotFoundError(
      stageId,
      `@openmaic/storage: missing document ${JSON.stringify(stageId)} in this workspace`,
    );
  }
  const stored = decodeJson<Record<string, unknown>>(row.data);
  const storedVersion = dslVersionOf(stored);
  if (!needsMigration(stored) && storedVersion !== DSL_VERSION) {
    throw new DocumentVersionError(
      stageId,
      'future',
      storedVersion,
      `@openmaic/storage: document ${JSON.stringify(stageId)} is at DSL version ` +
        `${JSON.stringify(storedVersion)}, newer than this server's ${DSL_VERSION}`,
    );
  }
  if (needsMigration(stored)) {
    throw new DocumentVersionError(
      stageId,
      'not-current',
      storedVersion,
      `@openmaic/storage: document ${JSON.stringify(stageId)} is at DSL version ` +
        `${JSON.stringify(storedVersion)} and must be loaded and saved in full before incremental writes`,
    );
  }
  return row;
}

async function upsertStageRow(
  connection: DbClient,
  ownerId: string,
  doc: MaicDocument<AppScene, AppStage>,
  createdAt: number,
): Promise<void> {
  const now = Date.now();
  const stageRow = splitStageRow(doc);
  await connection.execute(
    'INSERT INTO document_stages (id, name, description, interactive_mode, task_engine_mode, created_at, updated_at, owner_id, data) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ' +
      'ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, ' +
      'interactive_mode = EXCLUDED.interactive_mode, task_engine_mode = EXCLUDED.task_engine_mode, ' +
      'updated_at = EXCLUDED.updated_at, owner_id = EXCLUDED.owner_id, data = EXCLUDED.data',
    [
      doc.stage.id,
      doc.stage.name ?? '',
      doc.stage.description ?? null,
      doc.stage.interactiveMode ?? null,
      doc.stage.taskEngineMode ?? null,
      createdAt,
      now,
      ownerId,
      encodeJson(stageRow),
    ],
  );
}

export class CoursewareDocumentStore implements DocumentStore<AppScene, AppStage> {
  constructor(private readonly options: CoursewareDocumentStoreOptions) {}

  async saveDocument(doc: MaicDocument<AppScene, AppStage>): Promise<void> {
    // Migrate stale input before validating, mirroring the HTTP handler's
    // order; a future version is refused rather than downgraded.
    if (!needsMigration(doc as unknown as Record<string, unknown>)) {
      const version = dslVersionOf(doc as unknown as Record<string, unknown>);
      if (version !== DSL_VERSION) {
        throw new DocumentVersionError(
          doc.stage.id,
          'future',
          version,
          `@openmaic/storage: refusing to save document ${JSON.stringify(doc.stage.id)} — it was ` +
            `written at DSL version ${JSON.stringify(version)}, newer than this server's ${DSL_VERSION}`,
        );
      }
    }
    const { outline, ...core } = doc;
    const normalized = migrate(core) as MaicDocument<AppScene, AppStage>;
    assertValid(this.options.validateStage(normalized.stage), `stage ${normalized.stage.id}`);
    const seen = new Set<string>();
    for (const scene of normalized.scenes) {
      assertValid(this.options.validateScene(scene), `scene ${scene.id}`);
      assertStorableScene(scene, normalized.stage.id);
      if (seen.has(scene.id)) {
        throw new Error(
          `@openmaic/storage: duplicate scene id ${JSON.stringify(scene.id)} in document ` +
            JSON.stringify(normalized.stage.id),
        );
      }
      seen.add(scene.id);
    }

    await withTransaction(async (connection) => {
      const existing = await readStageRow(connection, this.options.ownerId, normalized.stage.id);
      const createdAt = existing?.created_at ?? Date.now();
      await upsertStageRow(connection, this.options.ownerId, normalized, createdAt);

      const existingScenes = await readSceneRows(connection, normalized.stage.id);
      const incomingIds = new Set(normalized.scenes.map((scene) => scene.id));
      for (const row of existingScenes) {
        if (!incomingIds.has(row.id)) {
          await connection.execute('DELETE FROM document_scenes WHERE stage_id = $1 AND id = $2', [
            normalized.stage.id,
            row.id,
          ]);
        }
      }
      for (const scene of normalized.scenes) {
        await connection.execute(
          'INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1, $2, $3, $4) ' +
            'ON CONFLICT (stage_id, id) DO UPDATE SET scene_order = EXCLUDED.scene_order, data = EXCLUDED.data',
          [normalized.stage.id, scene.id, scene.order, encodeJson(scene)],
        );
      }

      if (outline === undefined) {
        await connection.execute('DELETE FROM document_outlines WHERE stage_id = $1', [
          normalized.stage.id,
        ]);
      } else {
        await connection.execute(
          'INSERT INTO document_outlines (stage_id, data) VALUES ($1, $2) ' +
            'ON CONFLICT (stage_id) DO UPDATE SET data = EXCLUDED.data',
          [normalized.stage.id, encodeJson(outline)],
        );
      }

      // Best-effort freshness bump for the ops metadata row; courses created
      // through the courseware flow always have one.
      await connection.execute('UPDATE courses SET updated_at = $1 WHERE id = $2', [
        Date.now(),
        normalized.stage.id,
      ]);
    });
  }

  async loadDocument(stageId: string): Promise<MaicDocument<AppScene, AppStage> | null> {
    return withTransaction(async (connection) => {
      const stageRow = await readStageRow(connection, this.options.ownerId, stageId);
      if (stageRow === null) return null;
      const sceneRows = await readSceneRows(connection, stageId);
      const outlineRows = await connection.query<{ data: unknown }>(
        'SELECT data FROM document_outlines WHERE stage_id = $1',
        [stageId],
      );
      const outlineData = outlineRows[0]?.data;
      const document = reassemble(stageRow.data, sceneRows, outlineData);
      const { outline, ...core } = document;
      const migrated = migrate(core) as MaicDocument<AppScene, AppStage>;
      return outline === undefined ? migrated : { ...migrated, outline };
    });
  }

  async listDocuments(): Promise<DocumentSummary[]> {
    const rows = await poolQuery<{
      id: string;
      name: string;
      description: string | null;
      interactive_mode: boolean | null;
      task_engine_mode: boolean | null;
      created_at: number;
      updated_at: number;
      scene_count: number;
    }>(
      'SELECT s.id, s.name, s.description, s.interactive_mode, s.task_engine_mode, s.created_at, s.updated_at, ' +
        '(SELECT COUNT(*) FROM document_scenes sc WHERE sc.stage_id = s.id) AS scene_count ' +
        'FROM document_stages s WHERE s.owner_id = $1 ORDER BY s.updated_at DESC',
      [this.options.ownerId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      ...(row.description === null ? {} : { description: row.description }),
      ...(row.interactive_mode === null ? {} : { interactiveMode: !!row.interactive_mode }),
      ...(row.task_engine_mode === null ? {} : { taskEngineMode: !!row.task_engine_mode }),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      sceneCount: Number(row.scene_count),
    }));
  }

  async deleteDocument(stageId: string): Promise<void> {
    await withTransaction(async (connection) => {
      // Cascades to scenes/outlines (FK) and courses/publications (FK on courses).
      await connection.execute('DELETE FROM document_stages WHERE id = $1 AND owner_id = $2', [
        stageId,
        this.options.ownerId,
      ]);
    });
  }

  async putStage(stageId: string, stage: AppStage): Promise<void> {
    assertValid(this.options.validateStage(stage), `stage ${stage.id}`);
    if (stage.id !== stageId) {
      throw new Error(
        `@openmaic/storage: stage ${JSON.stringify(stage.id)} does not belong to document ` +
          JSON.stringify(stageId),
      );
    }
    await withTransaction(async (connection) => {
      const row = await requireCurrentDocument(connection, this.options.ownerId, stageId);
      const stageRow = { ...stage, [DSL_VERSION_KEY]: DSL_VERSION } as StageRowWithVersion;
      await connection.execute(
        'UPDATE document_stages SET name = $1, description = $2, interactive_mode = $3, task_engine_mode = $4, ' +
          'updated_at = $5, data = $6 WHERE id = $7 AND owner_id = $8',
        [
          stage.name ?? '',
          stage.description ?? null,
          stage.interactiveMode ?? null,
          stage.taskEngineMode ?? null,
          Date.now(),
          encodeJson(stageRow),
          stageId,
          this.options.ownerId,
        ],
      );
      await connection.execute('UPDATE courses SET updated_at = $1 WHERE id = $2', [
        Date.now(),
        row.id,
      ]);
    });
  }

  async putScene(stageId: string, scene: AppScene): Promise<void> {
    assertValid(this.options.validateScene(scene), `scene ${scene.id}`);
    assertStorableScene(scene, stageId);
    await withTransaction(async (connection) => {
      await requireCurrentDocument(connection, this.options.ownerId, stageId);
      await connection.execute(
        'INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1, $2, $3, $4) ' +
          'ON CONFLICT (stage_id, id) DO UPDATE SET scene_order = EXCLUDED.scene_order, data = EXCLUDED.data',
        [stageId, scene.id, scene.order, encodeJson(scene)],
      );
      await connection.execute(
        'UPDATE document_stages SET updated_at = $1 WHERE id = $2 AND owner_id = $3',
        [Date.now(), stageId, this.options.ownerId],
      );
      await connection.execute('UPDATE courses SET updated_at = $1 WHERE id = $2', [
        Date.now(),
        stageId,
      ]);
    });
  }

  async getScene(stageId: string, sceneId: string): Promise<AppScene | null> {
    return withTransaction(async (connection) => {
      const stageRow = await readStageRow(connection, this.options.ownerId, stageId);
      if (stageRow === null) return null;
      const sceneRows = await connection.query<SceneTableRow>(
        'SELECT id, scene_order, data FROM document_scenes WHERE stage_id = $1 AND id = $2',
        [stageId, sceneId],
      );
      if (sceneRows.length === 0) return null;
      const stored = decodeJson<Record<string, unknown>>(stageRow.data);
      const migratedStage = needsMigration(stored)
        ? (migrate({ stage: stored }) as { stage: Stage })
        : { stage: stored as unknown as Stage };
      void migratedStage;
      return decodeJson<AppScene>(sceneRows[0]!.data);
    });
  }

  async deleteScene(stageId: string, sceneId: string): Promise<void> {
    await withTransaction(async (connection) => {
      await requireCurrentDocument(connection, this.options.ownerId, stageId);
      await connection.execute('DELETE FROM document_scenes WHERE stage_id = $1 AND id = $2', [
        stageId,
        sceneId,
      ]);
      await connection.execute(
        'UPDATE document_stages SET updated_at = $1 WHERE id = $2 AND owner_id = $3',
        [Date.now(), stageId, this.options.ownerId],
      );
      await connection.execute('UPDATE courses SET updated_at = $1 WHERE id = $2', [
        Date.now(),
        stageId,
      ]);
    });
  }
}
