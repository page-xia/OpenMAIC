/**
 * Course media assets: bytes stored in PostgreSQL (`course_assets.byte_data`),
 * metadata alongside. Slide payloads reference assets by their public URL
 * (`/api/assets/<id>`), which the app's media-resolution chain already treats
 * as a concrete address — so server-hosted media renders without any client
 * changes.
 *
 * Bytes live in the database (not on disk) so the deployment only needs the
 * one `DATABASE_URL`: serverless targets such as Vercel have no persistent
 * writable filesystem.
 *
 * Asset ids are unguessable capabilities: the streaming route serves any valid
 * id without a session, matching the existing classroom-media posture.
 */
import { nanoid } from 'nanoid';

import { execute, query } from '@/lib/server/db/pg';

export type AssetKind = 'image' | 'audio' | 'video' | 'poster' | 'file';
export type AssetOrigin = 'pptx_import' | 'maic_zip' | 'upload' | 'generated' | 'tts';

export interface AssetRecord {
  id: string;
  courseId: string | null;
  kind: AssetKind;
  mimeType: string | null;
  sizeBytes: number | null;
  durationSec: number | null;
  origin: AssetOrigin;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

interface AssetTableRow {
  id: string;
  course_id: string | null;
  kind: string;
  mime_type: string | null;
  size_bytes: string | number | null;
  duration_sec: number | null;
  origin: string;
  metadata: unknown;
  created_at: number;
}

const KIND_BY_MIME_PREFIX: Record<string, AssetKind> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
};

export function inferAssetKind(mimeType: string | undefined, fallback: AssetKind): AssetKind {
  if (!mimeType) return fallback;
  const prefix = mimeType.split('/')[0] ?? '';
  return KIND_BY_MIME_PREFIX[prefix] ?? fallback;
}

export function assetUrl(assetId: string): string {
  return `/api/assets/${assetId}`;
}

function decodeMetadata(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string' && /^\s*[{\[]/.test(value)) {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function toRecord(row: AssetTableRow): AssetRecord {
  return {
    id: row.id,
    courseId: row.course_id,
    kind: row.kind as AssetKind,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    durationSec: row.duration_sec === null ? null : Number(row.duration_sec),
    origin: row.origin as AssetOrigin,
    metadata: decodeMetadata(row.metadata),
    createdAt: Number(row.created_at),
  };
}

function safeCourseSegment(courseId: string | undefined): string | undefined {
  return courseId && /^[a-zA-Z0-9_-]+$/.test(courseId) ? courseId : undefined;
}

export interface PutAssetInput {
  courseId?: string;
  mimeType?: string;
  kind?: AssetKind;
  origin: AssetOrigin;
  bytes: Buffer;
  durationSec?: number;
  metadata?: Record<string, unknown>;
}

export interface PutAssetResult {
  record: AssetRecord;
  url: string;
}

const ASSET_COLUMNS =
  'id, course_id, kind, mime_type, size_bytes, duration_sec, origin, metadata, created_at';

/** Insert the metadata row + bytes; returns the public URL. */
export async function putCourseAsset(input: PutAssetInput): Promise<PutAssetResult> {
  const id = `ast_${nanoid(24)}`;
  const kind = input.kind ?? inferAssetKind(input.mimeType, 'file');
  const now = Date.now();
  await execute(
    'INSERT INTO course_assets (id, course_id, kind, mime_type, size_bytes, duration_sec, origin, metadata, byte_data, created_at) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [
      id,
      safeCourseSegment(input.courseId) ?? null,
      kind,
      input.mimeType ?? null,
      input.bytes.byteLength,
      input.durationSec ?? null,
      input.origin,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.bytes,
      now,
    ],
  );
  const record: AssetRecord = {
    id,
    courseId: safeCourseSegment(input.courseId) ?? null,
    kind,
    mimeType: input.mimeType ?? null,
    sizeBytes: input.bytes.byteLength,
    durationSec: input.durationSec ?? null,
    origin: input.origin,
    metadata: input.metadata ?? null,
    createdAt: now,
  };
  return { record, url: assetUrl(id) };
}

export async function getCourseAsset(assetId: string): Promise<AssetRecord | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(assetId)) return null;
  const rows = await query<AssetTableRow>(
    `SELECT ${ASSET_COLUMNS} FROM course_assets WHERE id = $1`,
    [assetId],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** The full byte payload of one asset, or null when the id is unknown. */
export async function getCourseAssetBytes(assetId: string): Promise<Buffer | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(assetId)) return null;
  const rows = await query<{ byte_data: Buffer }>(
    'SELECT byte_data FROM course_assets WHERE id = $1',
    [assetId],
  );
  return rows[0]?.byte_data ?? null;
}

/**
 * One byte range of an asset (1-based SQL offsets), for range requests that
 * must not pull the whole payload into memory. Null when the id is unknown.
 */
export async function getCourseAssetSlice(
  assetId: string,
  start: number,
  length: number,
): Promise<Buffer | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(assetId)) return null;
  if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length <= 0) {
    return null;
  }
  const rows = await query<{ chunk: Buffer }>(
    'SELECT substring(byte_data from $2 for $3) AS chunk FROM course_assets WHERE id = $1',
    [assetId, start + 1, length],
  );
  return rows[0]?.chunk ?? null;
}

export async function listCourseAssets(courseId: string): Promise<AssetRecord[]> {
  if (!/^[a-zA-Z0-9_-]+$/.test(courseId)) return [];
  const rows = await query<AssetTableRow>(
    `SELECT ${ASSET_COLUMNS} FROM course_assets WHERE course_id = $1 ORDER BY created_at DESC`,
    [courseId],
  );
  return rows.map(toRecord);
}

/** Re-bind an unfiled asset to a course (used after import creates the row). */
export async function bindAssetToCourse(assetId: string, courseId: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(courseId)) return;
  await execute('UPDATE course_assets SET course_id = $1 WHERE id = $2 AND course_id IS NULL', [
    courseId,
    assetId,
  ]);
}
