'use client';

/**
 * Server-course freshness for the classroom.
 *
 * A server course is authoritative: students play a frozen
 * `course_publications` snapshot, and a teacher previews either that snapshot
 * or their live draft. The browser may still hold an older local copy from a
 * previous visit (the load pipeline's first source), so before a classroom
 * loads we ask the server how fresh its copy is and drop the local document
 * when it is behind. The load pipeline then misses locally and re-fetches —
 * no changes to the pipeline itself.
 *
 * The two kinds of course are freshness-marked differently, on purpose:
 *
 * - A PUBLISHED course changes only when its version advances, so the version
 *   number is the marker.
 * - A DRAFT has no version — every edit would have to bump one just to be seen
 *   here — so the document's own `updatedAt` stamp is the marker. Previewing a
 *   draft after editing it must show the edits, or the author cannot judge the
 *   course before publishing it.
 */

const VERSION_KEY_PREFIX = 'openmaic_published_version:';
const DRAFT_STAMP_KEY_PREFIX = 'openmaic_draft_stamp:';

function readAppliedVersion(courseId: string): number {
  try {
    return Number(window.localStorage.getItem(VERSION_KEY_PREFIX + courseId) ?? '0') || 0;
  } catch {
    return 0;
  }
}

function writeAppliedVersion(courseId: string, version: number): void {
  try {
    window.localStorage.setItem(VERSION_KEY_PREFIX + courseId, String(version));
  } catch {
    // Private-browsing storage failures are non-fatal: worst case the local
    // copy is dropped again on the next visit.
  }
}

function readDraftStamp(courseId: string): number {
  try {
    return Number(window.localStorage.getItem(DRAFT_STAMP_KEY_PREFIX + courseId) ?? '0') || 0;
  } catch {
    return 0;
  }
}

function writeDraftStamp(courseId: string, stamp: number): void {
  try {
    window.localStorage.setItem(DRAFT_STAMP_KEY_PREFIX + courseId, String(stamp));
  } catch {
    // Same non-fatal reasoning as writeAppliedVersion.
  }
}

/** Drop the cached local document so the load pipeline re-fetches from the server. */
async function dropLocalDocument(courseId: string): Promise<void> {
  try {
    const { getDocumentStore } = await import('@/lib/document-store/store');
    await getDocumentStore().deleteDocument(courseId);
  } catch {
    // A failed drop only means the stale copy plays once more; the next open
    // retries.
  }
}

export interface PublishedCourseProbe {
  version: number;
  teacherPreview: boolean;
  /** Present for an owner's unpublished draft: the document's `updatedAt`. */
  draftUpdatedAt?: number;
}

/**
 * Probe a course's server freshness; null when it is not a server course this
 * viewer can read (unpublished and not the owner, or absent).
 */
export async function probePublishedCourse(courseId: string): Promise<PublishedCourseProbe | null> {
  try {
    const response = await fetch(`/api/student/courses/${encodeURIComponent(courseId)}`);
    if (!response.ok) return null;
    const body = (await response.json()) as {
      success?: boolean;
      version?: number;
      teacherPreview?: boolean;
      draftUpdatedAt?: number;
    };
    if (!body.success || typeof body.version !== 'number') return null;
    return {
      version: body.version,
      teacherPreview: body.teacherPreview === true,
      ...(typeof body.draftUpdatedAt === 'number' ? { draftUpdatedAt: body.draftUpdatedAt } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Drop the local document for `courseId` when it is behind the server, so the
 * classroom load re-fetches. Returns the probe result (callers use
 * `teacherPreview` for view gating).
 */
export async function syncPublishedCourseFreshness(
  courseId: string,
): Promise<PublishedCourseProbe | null> {
  const probe = await probePublishedCourse(courseId);
  if (!probe) return null;

  // Draft: freshness is the document stamp, not a version.
  if (probe.draftUpdatedAt !== undefined) {
    const applied = readDraftStamp(courseId);
    if (probe.draftUpdatedAt > applied) {
      if (applied > 0) await dropLocalDocument(courseId);
      writeDraftStamp(courseId, probe.draftUpdatedAt);
    }
    return probe;
  }

  const applied = readAppliedVersion(courseId);
  if (probe.version > applied) {
    if (applied > 0) await dropLocalDocument(courseId);
    writeAppliedVersion(courseId, probe.version);
  }
  return probe;
}
