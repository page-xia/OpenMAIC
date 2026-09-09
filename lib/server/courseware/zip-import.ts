/**
 * Server-side `.maic.zip` import: the counterpart of the browser import hook,
 * landing the course in the courseware PostgreSQL store with database-hosted media instead of IndexedDB.
 *
 * Media refs in the rebuilt document become root-relative asset URLs
 * (`/api/assets/<id>`), which the app's media-resolution chain already treats
 * as concrete addresses; speech actions carry the same URLs through their
 * legacy `audioUrl` field, which the audio player fetches and plays. Nothing
 * about the student-side playback path changes.
 *
 * The ref-rewrite logic mirrors `lib/import/use-import-classroom.ts` but is
 * re-implemented here because the client module imports Dexie at module scope.
 */
import JSZip from 'jszip';
import { nanoid } from 'nanoid';
import type { Slide, VideoManifest, GeneratedAgentConfig } from '@openmaic/dsl';

import type { Action, SpeechAction } from '@/lib/types/action';
import type { AppScene, SceneContent } from '@/lib/types/stage';
import type { AppStage } from '@/lib/document-store/persistence-types';
import {
  agentConfigFromManifest,
  type ClassroomManifest,
  type ManifestScene,
} from '@/lib/export/classroom-zip-types';
import { putCourseAsset } from './asset-repo';
import { createCourse, type CourseListItem } from './course-repo';

export interface ZipImportResult {
  course: CourseListItem;
  assetCount: number;
}

/** Mapping from a document media ref (or audio sourceRef) to its asset URL. */
type RefToUrl = Map<string, string>;

function mediaRefFromZipPath(zipPath: string, mimeType?: string): string {
  const relative = zipPath.startsWith('media/') ? zipPath.slice('media/'.length) : zipPath;
  const subtype = mimeType?.split('/')[1];
  const suffix = subtype ? `.${subtype}` : undefined;
  if (suffix && relative.endsWith(suffix)) return relative.slice(0, -suffix.length);
  const slash = relative.lastIndexOf('/');
  const dot = relative.lastIndexOf('.');
  return dot > slash ? relative.slice(0, dot) : relative;
}

function rewriteRef(value: unknown, mapping: RefToUrl): string | undefined {
  if (typeof value !== 'string') return undefined;
  return mapping.get(value);
}

/** Keep concrete addresses (http/data/blob) and generation placeholders as-is. */
function isPassthroughRef(value: string): boolean {
  if (/^(https?:|data:|blob:|\/)/i.test(value)) return true;
  return /^gen_/.test(value);
}

function rewriteSlideMediaRefs(slide: Slide, mediaMap: RefToUrl, audioMap: RefToUrl): Slide {
  const background =
    slide.background?.type === 'image' && slide.background.image
      ? {
          ...slide.background,
          image: {
            ...slide.background.image,
            src: rewriteRef(slide.background.image.src, mediaMap) ?? slide.background.image.src,
          },
        }
      : slide.background;
  return {
    ...slide,
    background,
    elements: slide.elements.map((element) => {
      if (element.type === 'image' || element.type === 'audio') {
        const mapped =
          element.type === 'image'
            ? rewriteRef(element.src, mediaMap)
            : rewriteRef(element.src, audioMap);
        if (mapped) return { ...element, src: mapped };
        return element;
      }
      if (element.type !== 'video') return element;
      const src = rewriteRef(element.src, mediaMap) ?? element.src;
      const mediaRef = rewriteRef(element.mediaRef, mediaMap) ?? element.mediaRef;
      const poster = rewriteRef(element.poster, mediaMap) ?? element.poster;
      return { ...element, src, ...(mediaRef ? { mediaRef } : {}), ...(poster ? { poster } : {}) };
    }),
  };
}

function rewriteVideoManifest(manifest: VideoManifest | undefined, mediaMap: RefToUrl) {
  if (!manifest) return undefined;
  const rewritten: VideoManifest = {};
  for (const [ref, entry] of Object.entries(manifest)) {
    const mapped = mediaMap.get(ref) ?? (isPassthroughRef(ref) ? ref : undefined);
    if (mapped) rewritten[mapped] = entry;
  }
  return Object.keys(rewritten).length > 0 ? rewritten : undefined;
}

/**
 * Rewrite manifest actions: `audioRef` (zip path) becomes the server asset URL
 * carried as `audioUrl`; `agentIndex` becomes the remapped agent id.
 */
function rewriteActions(
  actions: ManifestScene['actions'],
  audioPathToUrl: Map<string, string>,
  agentIds: string[],
  fallbackDiscussionAgentIndex: number | undefined,
): Action[] | undefined {
  if (!actions) return undefined;
  return actions.map((action) => {
    const next: Record<string, unknown> = { ...action };
    delete next.audioRef;
    if (typeof action.agentIndex === 'number') {
      const agentId = agentIds[action.agentIndex];
      if (agentId !== undefined) next.agentId = agentId;
      delete next.agentIndex;
    }
    if (action.type === 'speech') {
      const url =
        typeof action.audioRef === 'string' ? audioPathToUrl.get(action.audioRef) : undefined;
      if (url) {
        next.audioId = '';
        next.audioUrl = url;
      } else {
        next.audioId = '';
        delete next.audioUrl;
      }
    }
    if (
      action.type === 'discussion' &&
      !next.agentId &&
      fallbackDiscussionAgentIndex !== undefined
    ) {
      const agentId = agentIds[fallbackDiscussionAgentIndex];
      if (agentId !== undefined) next.agentId = agentId;
    }
    return next as unknown as Action;
  }) as Action[];
}

export class ZipImportError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ZipImportError';
  }
}

/**
 * Import a `.maic.zip` buffer as a new course owned by `teacherId`.
 * Media/audio blobs become server assets before the document write, so the
 * course never references bytes that do not exist yet.
 */
export async function importClassroomZip(
  teacherId: string,
  zipBytes: Buffer,
  options: { titleOverride?: string } = {},
): Promise<ZipImportResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBytes);
  } catch {
    throw new ZipImportError('无法解析压缩包：不是有效的 zip 文件');
  }

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new ZipImportError('压缩包缺少 manifest.json，不是有效的课件包（.maic.zip）');
  }
  let manifest: ClassroomManifest;
  try {
    manifest = JSON.parse(await manifestFile.async('text')) as ClassroomManifest;
  } catch {
    throw new ZipImportError('manifest.json 解析失败');
  }
  if (!manifest.stage || !Array.isArray(manifest.scenes)) {
    throw new ZipImportError('manifest.json 缺少 stage 或 scenes 数据');
  }

  const courseId = `crs_${nanoid(16)}`;
  const now = Date.now();
  let assetCount = 0;

  // Pass 1: audio blobs → server assets; build zip-path and source-ref → URL maps.
  const audioPathToUrl = new Map<string, string>();
  const audioSourceRefToUrl = new Map<string, string>();
  const audioEntries = Object.entries(manifest.mediaIndex ?? {})
    .filter(([, meta]) => meta.type === 'audio' && !meta.missing)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [zipPath, meta] of audioEntries) {
    const entry = zip.file(zipPath);
    if (!entry) continue;
    const bytes = Buffer.from(await entry.async('arraybuffer'));
    const mimeType = meta.mimeType || `audio/${meta.format || 'mp3'}`;
    const { url } = await putCourseAsset({
      courseId,
      mimeType,
      origin: 'maic_zip',
      bytes,
      ...(meta.duration !== undefined ? { durationSec: meta.duration } : {}),
      metadata: { zipPath, voice: meta.voice },
    });
    assetCount += 1;
    audioPathToUrl.set(zipPath, url);
    const relativePath = zipPath.startsWith('audio/') ? zipPath.slice('audio/'.length) : zipPath;
    const formatSuffix = meta.format ? `.${meta.format}` : undefined;
    const sourceRef =
      (typeof meta.sourceRef === 'string' ? meta.sourceRef : undefined) ??
      (formatSuffix && relativePath.endsWith(formatSuffix)
        ? relativePath.slice(0, -formatSuffix.length)
        : relativePath.replace(/\.[^/.]+$/, ''));
    if (!audioSourceRefToUrl.has(sourceRef)) audioSourceRefToUrl.set(sourceRef, url);
  }

  // Pass 2: image/video blobs (incl. sibling posters) → server assets.
  const mediaRefToUrl: RefToUrl = new Map();
  const mediaEntries = Object.entries(manifest.mediaIndex ?? {}).filter(
    ([, meta]) => (meta.type === 'generated' || meta.type === 'image') && !meta.missing,
  );
  for (const [zipPath, meta] of mediaEntries) {
    const entry = zip.file(zipPath);
    if (!entry) continue;
    const bytes = Buffer.from(await entry.async('arraybuffer'));
    const mimeType = meta.mimeType || 'image/jpeg';
    const { url } = await putCourseAsset({
      courseId,
      mimeType,
      origin: 'maic_zip',
      bytes,
      metadata: { zipPath, prompt: meta.prompt },
    });
    assetCount += 1;
    const oldRef =
      typeof meta.sourceRef === 'string' ? meta.sourceRef : mediaRefFromZipPath(zipPath, mimeType);
    mediaRefToUrl.set(oldRef, url);

    // A video's sibling poster (`<name>.poster.jpg`) is consumed directly by
    // the renderer through the video element, so map it onto its own URL too.
    if (mimeType.startsWith('video/')) {
      const suffix = mimeType.split('/')[1];
      const posterPath = zipPath.endsWith(`.${suffix}`)
        ? `${zipPath.slice(0, -`.${suffix}`.length)}.poster.jpg`
        : zipPath.replace(/\.[^/]+$/, '.poster.jpg');
      const posterEntry = zip.file(posterPath);
      if (posterEntry) {
        const posterBytes = Buffer.from(await posterEntry.async('arraybuffer'));
        const { url: posterUrl } = await putCourseAsset({
          courseId,
          mimeType: 'image/jpeg',
          origin: 'maic_zip',
          bytes: posterBytes,
        });
        assetCount += 1;
        const posterRef = mediaRefFromZipPath(posterPath, 'image/jpeg');
        mediaRefToUrl.set(posterRef, posterUrl);
      }
    }
  }

  // Pass 3: rebuild the document with server URLs and fresh ids.
  const newAgentIds = (manifest.agents ?? []).map(() => nanoid());
  const studentAgentIndex = manifest.agents?.findIndex((agent) => agent.role === 'student') ?? -1;
  const nonTeacherAgentIndex =
    manifest.agents?.findIndex((agent) => agent.role !== 'teacher') ?? -1;
  const fallbackDiscussionAgentIndex =
    studentAgentIndex >= 0
      ? studentAgentIndex
      : nonTeacherAgentIndex >= 0
        ? nonTeacherAgentIndex
        : undefined;

  const importedAgentConfigs: GeneratedAgentConfig[] = (manifest.agents ?? []).map((agent, index) =>
    agentConfigFromManifest(agent, newAgentIds[index]),
  );

  const stage: AppStage = {
    id: courseId,
    name: options.titleOverride || manifest.stage.name || '导入的课件',
    ...(manifest.stage.description ? { description: manifest.stage.description } : {}),
    ...(manifest.stage.language ? { languageDirective: manifest.stage.language } : {}),
    ...(manifest.stage.style ? { style: manifest.stage.style } : {}),
    createdAt: manifest.stage.createdAt || now,
    updatedAt: now,
    ...(newAgentIds.length > 0 ? { agentIds: newAgentIds } : {}),
    ...(manifest.stage.videoManifest
      ? { videoManifest: rewriteVideoManifest(manifest.stage.videoManifest, mediaRefToUrl) }
      : {}),
    ...(importedAgentConfigs.length > 0 ? { generatedAgentConfigs: importedAgentConfigs } : {}),
  };

  const scenes: AppScene[] = manifest.scenes.map((mScene: ManifestScene, index: number) => {
    const content: SceneContent =
      mScene.content.type === 'slide'
        ? {
            ...mScene.content,
            canvas: rewriteSlideMediaRefs(
              mScene.content.canvas,
              mediaRefToUrl,
              audioSourceRefToUrl,
            ),
          }
        : (mScene.content as SceneContent);
    return {
      id: nanoid(),
      stageId: courseId,
      type: mScene.type,
      title: mScene.title,
      order: mScene.order ?? index,
      content,
      actions: rewriteActions(
        mScene.actions,
        audioPathToUrl,
        newAgentIds,
        fallbackDiscussionAgentIndex,
      ),
      ...(mScene.whiteboards
        ? {
            whiteboards: mScene.whiteboards.map((slide) =>
              rewriteSlideMediaRefs(slide, mediaRefToUrl, audioSourceRefToUrl),
            ),
          }
        : {}),
      ...(mScene.multiAgent?.enabled
        ? {
            multiAgent: {
              enabled: true,
              agentIds: (mScene.multiAgent.agentIndices ?? [])
                .map((idx) => newAgentIds[idx])
                .filter(Boolean),
              ...(mScene.multiAgent.directorPrompt
                ? { directorPrompt: mScene.multiAgent.directorPrompt }
                : {}),
            },
          }
        : {}),
      createdAt: now,
      updatedAt: now,
    } as AppScene;
  });

  try {
    const course = await createCourse(teacherId, {
      id: courseId,
      title: stage.name,
      ...(stage.description ? { description: stage.description } : {}),
      source: 'maic_zip',
      stage,
      scenes,
    });
    return { course, assetCount };
  } catch (error) {
    // The document write failed after assets landed; the unbound asset rows
    // are inert orphans (the course dir is keyed by an id no document uses).
    throw new ZipImportError(
      `课件数据写入失败: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
}

/** Type-only re-export used by import route logging. */
export type { SpeechAction };
