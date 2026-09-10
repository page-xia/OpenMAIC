'use client';

/**
 * Course cover from the deck's first page.
 *
 * A generated course has no cover art of its own: its pages are DOM, not
 * images, so there is nothing to point a library card at. Rather than show an
 * empty placeholder, the teacher console rasterizes the FIRST slide through the
 * same off-screen renderer the export pipeline uses (`slideToPng`) and stores
 * the PNG as the course cover asset. Everything downstream — the student
 * library card, the teacher list — then just serves an image.
 *
 * The renderer is imported lazily on purpose: only a course that still has no
 * cover pays for the slide-renderer chunk, and every other visit to the course
 * page loads nothing extra.
 */
import type { AppScene, SlideContent } from '@/lib/types/stage';

/** Rendered width in px; the deck's own aspect ratio supplies the height. */
export const COVER_RENDER_WIDTH = 1280;

/**
 * The scene a cover should show: the deck's first page in play order.
 *
 * Returns the first SLIDE scene rather than literally `scenes[0]`, because only
 * a slide can be rasterized — a deck that opens on a quiz or an interactive
 * page still deserves its first real page as the cover. A slide with no
 * elements is skipped too: a freshly created deck's placeholder page would
 * rasterize to a blank white card, which reads worse than the library's
 * "no cover" placeholder.
 */
export function firstCoverScene(scenes: readonly AppScene[]): AppScene | null {
  const ordered = [...scenes].sort((a, b) => a.order - b.order);
  return (
    ordered.find((scene) => {
      if (scene.type !== 'slide') return false;
      const slide = (scene.content as SlideContent | undefined)?.canvas;
      return !!slide && slide.elements.length > 0;
    }) ?? null
  );
}

/**
 * Rasterize the deck's first page to a PNG blob, or null when there is no slide
 * page or the snapshot cannot be taken (unreachable media, tainted canvas…).
 *
 * Never throws: a cover is decoration, and a course must stay saveable /
 * publishable without one.
 */
export async function renderCoverFromScenes(scenes: readonly AppScene[]): Promise<Blob | null> {
  const scene = firstCoverScene(scenes);
  if (!scene) return null;
  const slide = (scene.content as SlideContent | undefined)?.canvas;
  if (!slide) return null;

  try {
    const { slideToPng } = await import('@openmaic/renderer/snapshot');
    const output = await slideToPng(slide, {
      width: COVER_RENDER_WIDTH,
      pixelRatio: 1,
      backgroundColor: '#ffffff',
      format: 'blob',
    });
    return output instanceof Blob ? output : await (await fetch(output)).blob();
  } catch (error) {
    console.warn('[CourseCover] first-page snapshot failed', error);
    return null;
  }
}

/**
 * Store a cover image and point the course at it.
 *
 * Uploads through the shared teacher asset endpoint (bytes land in
 * `course_assets`), then flips `courses.cover_asset_id`. Returns the refreshed
 * course row on success and null on any failure — the caller decides whether to
 * surface it.
 */
export async function uploadCourseCover<T>(
  courseId: string,
  blob: Blob,
  filename = 'cover.png',
): Promise<T | null> {
  try {
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('courseId', courseId);
    const upload = await fetch('/api/teacher/assets', { method: 'POST', body: form });
    const uploaded = (await upload.json().catch(() => null)) as {
      success?: boolean;
      asset?: { id?: string };
    } | null;
    const assetId = uploaded?.asset?.id;
    if (!upload.ok || !uploaded?.success || !assetId) return null;

    const patch = await fetch(`/api/teacher/courses/${courseId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ coverAssetId: assetId }),
    });
    const patched = (await patch.json().catch(() => null)) as {
      success?: boolean;
      course?: T;
    } | null;
    if (!patch.ok || !patched?.success || !patched.course) return null;
    return patched.course;
  } catch {
    return null;
  }
}

/** Rasterize the first page and store it as the course cover in one step. */
export async function generateAndStoreCourseCover<T>(
  courseId: string,
  scenes: readonly AppScene[],
): Promise<T | null> {
  const blob = await renderCoverFromScenes(scenes);
  if (!blob) return null;
  return uploadCourseCover<T>(courseId, blob);
}
