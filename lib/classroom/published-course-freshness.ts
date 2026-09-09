'use client';

/**
 * Published-course freshness for the student classroom.
 *
 * A published course is server-authoritative: students play a frozen
 * `course_publications` snapshot. The browser may still hold an older local
 * copy from a previous visit (the load pipeline's first source), so before a
 * classroom loads we ask the server for the published version and drop the
 * local document when it predates a newer publication. The load pipeline then
 * misses locally and re-fetches the fresh snapshot — no changes to the
 * pipeline itself.
 */

const VERSION_KEY_PREFIX = 'openmaic_published_version:';

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

export interface PublishedCourseProbe {
  version: number;
  teacherPreview: boolean;
}

/** Probe the published version of a course; null when it is not a published server course. */
export async function probePublishedCourse(courseId: string): Promise<PublishedCourseProbe | null> {
  try {
    const response = await fetch(`/api/student/courses/${encodeURIComponent(courseId)}`);
    if (!response.ok) return null;
    const body = (await response.json()) as {
      success?: boolean;
      version?: number;
      teacherPreview?: boolean;
    };
    if (!body.success || typeof body.version !== 'number') return null;
    return { version: body.version, teacherPreview: body.teacherPreview === true };
  } catch {
    return null;
  }
}

/**
 * Drop the local document for `courseId` when it predates a newer published
 * version, so the classroom load re-fetches the server snapshot. Returns the
 * probe result (callers use `teacherPreview` for view gating).
 */
export async function syncPublishedCourseFreshness(
  courseId: string,
): Promise<PublishedCourseProbe | null> {
  const probe = await probePublishedCourse(courseId);
  if (!probe) return null;

  const applied = readAppliedVersion(courseId);
  if (probe.version > applied) {
    if (applied > 0) {
      try {
        const { getDocumentStore } = await import('@/lib/document-store/store');
        await getDocumentStore().deleteDocument(courseId);
      } catch {
        // A failed drop only means the stale copy plays once more; the next
        // open retries.
      }
    }
    writeAppliedVersion(courseId, probe.version);
  }
  return probe;
}
