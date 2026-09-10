/**
 * Course operations repository: the ops metadata layer beside the courseware
 * document store. `courses` rows carry ownership / status / publish info and
 * join `document_stages` for titles; documents themselves are written through
 * {@link CoursewareDocumentStore} so validation and versioning stay on one path.
 *
 * Publishing freezes a full `{stage, scenes}` snapshot into
 * `course_publications` (version + 1): students read snapshots only, so a
 * teacher editing a draft can never change a lesson mid-class. Unpublishing
 * flips status back to draft (students lose access; snapshots are kept for
 * history and instant re-publish).
 */
import { nanoid } from 'nanoid';

import type { AppScene } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { createBlankSlideScene } from '@/lib/edit/slide-defaults';
import { sanitizeSceneContent } from '@/lib/server/sanitize-scene-content';
import { query, withTransaction } from '@/lib/server/db/pg';
import { assetUrl } from './asset-repo';
import { CoursewareDocumentStore } from './document-store';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';

export type CourseStatus = 'draft' | 'published' | 'archived';
export type CourseSource = 'pptx' | 'ai_generation' | 'maic_zip' | 'blank';

export interface CourseListItem {
  id: string;
  title: string;
  description: string | null;
  status: CourseStatus;
  source: CourseSource;
  sceneCount: number;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  publishedVersion: number;
  /** Public URL of the course cover image, or null when none is set. */
  coverUrl: string | null;
}

export interface PublishedCourseListItem {
  id: string;
  title: string;
  description: string | null;
  sceneCount: number;
  publishedAt: number;
  version: number;
  /** Public URL of the course cover image, or null when none is set. */
  coverUrl: string | null;
}

interface CourseJoinRow {
  id: string;
  status: string;
  source: string;
  cover_asset_id: string | null;
  published_version: number;
  published_at: number | null;
  created_at: number;
  updated_at: number;
  name: string;
  description: string | null;
  scene_count: number;
}

const COURSE_SELECT = `
  SELECT c.id, c.status, c.source, c.cover_asset_id, c.published_version, c.published_at,
         c.created_at, c.updated_at,
         s.name, s.description,
         (SELECT COUNT(*) FROM document_scenes sc WHERE sc.stage_id = c.id) AS scene_count
    FROM courses c
    JOIN document_stages s ON s.id = c.id
`;

/**
 * Cover art lives in `course_assets` (bytes in the database) and is addressed
 * by an unguessable asset id, so the public asset route needs no session —
 * the same posture as every other course media reference. A cover is preserved
 * across publish/unpublish: it is course metadata, not part of the frozen
 * content snapshot.
 */
export function coverUrlFor(coverAssetId: string | null | undefined): string | null {
  return coverAssetId ? assetUrl(coverAssetId) : null;
}

function normalizeStatus(value: string): CourseStatus {
  return value === 'published' || value === 'archived' ? value : 'draft';
}

function normalizeSource(value: string): CourseSource {
  return value === 'pptx' || value === 'ai_generation' || value === 'maic_zip' ? value : 'blank';
}

function toListItem(row: CourseJoinRow): CourseListItem {
  return {
    id: row.id,
    title: row.name,
    description: row.description,
    status: normalizeStatus(row.status),
    source: normalizeSource(row.source),
    sceneCount: Number(row.scene_count),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    publishedAt: row.published_at === null ? null : Number(row.published_at),
    publishedVersion: Number(row.published_version),
    coverUrl: coverUrlFor(row.cover_asset_id),
  };
}

export function documentStoreFor(teacherId: string): CoursewareDocumentStore {
  return new CoursewareDocumentStore({
    ownerId: teacherId,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
}

export async function listCoursesForTeacher(
  teacherId: string,
  filter: { status?: CourseStatus; q?: string } = {},
): Promise<CourseListItem[]> {
  const conditions = ['c.teacher_id = $1'];
  const params: unknown[] = [teacherId];
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`c.status = $${params.length}`);
  }
  if (filter.q) {
    params.push(`%${filter.q.replace(/[%_]/g, (ch) => `\\${ch}`)}%`);
    conditions.push(`s.name ILIKE $${params.length}`);
  }
  const rows = await query<CourseJoinRow>(
    `${COURSE_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY c.updated_at DESC`,
    params,
  );
  return rows.map(toListItem);
}

export async function getCourseForTeacher(
  teacherId: string,
  courseId: string,
): Promise<CourseListItem | null> {
  const rows = await query<CourseJoinRow>(
    `${COURSE_SELECT} WHERE c.teacher_id = $1 AND c.id = $2`,
    [teacherId, courseId],
  );
  return rows[0] ? toListItem(rows[0]) : null;
}

export interface CreateCourseInput {
  title: string;
  description?: string;
  source: CourseSource;
  /** Pre-allocated course id (imports write bound assets before the document). */
  id?: string;
  /** Stage fields merged under the derived id/timestamps (imports/generation). */
  stage?: Partial<AppStage>;
  scenes?: AppScene[];
  outline?: unknown;
}

/**
 * Create a course: one blank slide scene unless scenes are supplied (imports
 * and generation pass their own), written through the document store in the
 * same transaction as the ops metadata row.
 */
export async function createCourse(
  teacherId: string,
  input: CreateCourseInput,
): Promise<CourseListItem> {
  const courseId = input.id ?? `crs_${nanoid(16)}`;
  const now = Date.now();
  const stage = {
    ...(input.stage ? input.stage : {}),
    name: input.title,
    ...(input.description ? { description: input.description } : {}),
    createdAt: now,
    updatedAt: now,
    id: courseId,
  } as AppStage;

  const scenes =
    input.scenes && input.scenes.length > 0
      ? input.scenes
      : [createBlankSlideScene(courseId, input.title, 0)];

  const store = documentStoreFor(teacherId);
  // Scenes may arrive from another document (a generated classroom, a zip
  // import) still carrying their ORIGINAL stageId — rebind every scene to the
  // new course id before the document store's per-scene partition check.
  const boundScenes = scenes.map((scene) => ({ ...scene, stageId: courseId }));
  await store.saveDocument({
    stage,
    scenes: sanitizeSceneContent(boundScenes) as AppScene[],
    ...(input.outline !== undefined ? { outline: input.outline } : {}),
  });
  await withTransaction(async (connection) => {
    await connection.execute(
      'INSERT INTO courses (id, teacher_id, status, source, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [courseId, teacherId, 'draft', input.source, now, now],
    );
  });
  const created = await getCourseForTeacher(teacherId, courseId);
  if (!created) throw new Error('course creation failed: metadata row missing after insert');
  return created;
}

export async function deleteCourse(teacherId: string, courseId: string): Promise<boolean> {
  return withTransaction(async (connection) => {
    // Deleting the stage cascades to scenes/outlines/courses/publications.
    return (
      (await connection.execute('DELETE FROM document_stages WHERE id = $1 AND owner_id = $2', [
        courseId,
        teacherId,
      ])) > 0
    );
  });
}

export interface DraftDocumentInfo {
  name: string;
  updatedAt: number;
}

/**
 * The owner's live draft document's name and `updated_at`, or null when this
 * teacher has no such document.
 *
 * This is the freshness marker for an UNPUBLISHED course: a published course
 * changes only when its version advances, but a draft has no version, so a
 * client that cached the document locally needs the document's own stamp to
 * notice its copy is behind. A cheap single-row read — deliberately not
 * `loadDocument`, which would reassemble every scene just to compare a stamp.
 *
 * The `owner_id` predicate IS the authorization: a teacher who does not own
 * the document sees null, so this cannot be used to confirm another teacher's
 * unpublished course exists.
 */
export async function getDraftDocumentInfo(
  teacherId: string,
  courseId: string,
): Promise<DraftDocumentInfo | null> {
  const rows = await query<{ name: string; updated_at: number }>(
    'SELECT name, updated_at FROM document_stages WHERE id = $1 AND owner_id = $2',
    [courseId, teacherId],
  );
  const row = rows[0];
  return row ? { name: row.name, updatedAt: Number(row.updated_at) } : null;
}

export interface PublishResult {
  version: number;
  publishedAt: number;
}

export async function publishCourse(
  teacherId: string,
  courseId: string,
): Promise<PublishResult | null> {
  const store = documentStoreFor(teacherId);
  const document = await store.loadDocument(courseId);
  if (!document) return null;

  const now = Date.now();
  return withTransaction(async (connection) => {
    const rows = await connection.query<CourseJoinRow>(
      `${COURSE_SELECT} WHERE c.teacher_id = $1 AND c.id = $2 FOR UPDATE`,
      [teacherId, courseId],
    );
    const course = rows[0];
    if (!course) return null;
    const version = Number(course.published_version) + 1;
    const snapshot = {
      stage: document.stage,
      scenes: document.scenes,
      ...(document.outline !== undefined ? { outline: document.outline } : {}),
      formatVersion: 1,
    };
    await connection.execute(
      'INSERT INTO course_publications (id, course_id, version, snapshot, published_by, published_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [nanoid(16), courseId, version, JSON.stringify(snapshot), teacherId, now],
    );
    await connection.execute(
      'UPDATE courses SET status = $1, published_version = $2, published_at = $3, updated_at = $4 WHERE id = $5',
      ['published', version, now, now, courseId],
    );
    return { version, publishedAt: now };
  });
}

/** Flip back to draft: students lose access, snapshots kept for re-publish. */
export async function unpublishCourse(
  teacherId: string,
  courseId: string,
): Promise<CourseListItem | null> {
  await withTransaction(async (connection) => {
    await connection.execute(
      "UPDATE courses SET status = 'draft', updated_at = $1 WHERE id = $2 AND teacher_id = $3 AND status = 'published'",
      [Date.now(), courseId, teacherId],
    );
  });
  return getCourseForTeacher(teacherId, courseId);
}

// --- Student-facing reads -----------------------------------------------------

export async function listPublishedCourses(
  filter: { q?: string; limit?: number } = {},
): Promise<PublishedCourseListItem[]> {
  const conditions = ["c.status = 'published'"];
  const params: unknown[] = [];
  if (filter.q) {
    params.push(`%${filter.q.replace(/[%_]/g, (ch) => `\\${ch}`)}%`);
    conditions.push(`s.name ILIKE $${params.length}`);
  }
  params.push(filter.limit && filter.limit > 0 ? Math.min(filter.limit, 200) : 200);
  const rows = await query<{
    id: string;
    name: string;
    description: string | null;
    cover_asset_id: string | null;
    scene_count: number;
    published_at: number;
    published_version: number;
  }>(
    `${COURSE_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY c.published_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.name,
    description: row.description,
    sceneCount: Number(row.scene_count),
    publishedAt: Number(row.published_at),
    version: Number(row.published_version),
    coverUrl: coverUrlFor(row.cover_asset_id),
  }));
}

/**
 * Attach (or clear) the course cover image. The caller validates that the asset
 * exists and is an image; this only flips the pointer, so a cover can be
 * swapped without touching the document or its published snapshot.
 */
export async function setCourseCover(
  teacherId: string,
  courseId: string,
  coverAssetId: string | null,
): Promise<CourseListItem | null> {
  const updated = await withTransaction(async (connection) =>
    connection.execute(
      'UPDATE courses SET cover_asset_id = $1, updated_at = $2 WHERE id = $3 AND teacher_id = $4',
      [coverAssetId, Date.now(), courseId, teacherId],
    ),
  );
  if (updated === 0) return null;
  return getCourseForTeacher(teacherId, courseId);
}

export interface PublishedSnapshot {
  courseId: string;
  version: number;
  stage: AppStage;
  scenes: AppScene[];
}

export async function getPublishedSnapshot(courseId: string): Promise<PublishedSnapshot | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(courseId)) return null;
  const statusRows = await query<{ status: string; published_version: number }>(
    'SELECT status, published_version FROM courses WHERE id = $1',
    [courseId],
  );
  const course = statusRows[0];
  if (!course || course.status !== 'published') return null;

  const snapshotRows = await query<{ version: number; snapshot: unknown }>(
    'SELECT version, snapshot FROM course_publications WHERE course_id = $1 ORDER BY version DESC LIMIT 1',
    [courseId],
  );
  const row = snapshotRows[0];
  if (!row) return null;
  const snapshot =
    typeof row.snapshot === 'string'
      ? (JSON.parse(row.snapshot) as { stage: AppStage; scenes: AppScene[] })
      : (row.snapshot as { stage: AppStage; scenes: AppScene[] });
  return {
    courseId,
    version: Number(row.version),
    stage: snapshot.stage,
    scenes: Array.isArray(snapshot.scenes) ? snapshot.scenes : [],
  };
}
