'use client';

/**
 * "The teacher's course library changed" — the one signal every surface showing
 * that list listens to.
 *
 * Why this exists: the teacher shell (`app/teacher/(protected)/layout.tsx`)
 * fetches the course list once when it mounts, and the rail it feeds
 * (`TeacherRail`) only offers a reload in its error branch. Course creation and
 * import happen on OTHER routes that share that same layout, so a client-side
 * navigation mints a course server-side and never remounts the layout — the new
 * row stays invisible until the user hard-refreshes the page.
 *
 * This mirrors the workbench's own answer to the identical problem (a
 * `libraryRevision` counter reconciled by `useGeneratedCourseDiscoverySync`):
 * the writer announces the change, the reader reloads. It is deliberately a
 * module-level counter plus a window event rather than React context, because
 * the writer (a page) and the reader (the layout) are not in a
 * parent/child relationship — they are siblings under the same layout, and the
 * event also covers the case where both are mounted at once.
 */

const LIBRARY_CHANGED_EVENT = 'openmaic:teacher-library-changed';

/**
 * Announce that the teacher's course list is stale. Called by the flows that
 * create, import, claim or delete a course.
 */
export function notifyTeacherLibraryChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));
}

/**
 * Subscribe to library changes. Returns the unsubscribe function, so the caller
 * can hand it straight back to an effect cleanup.
 */
export function onTeacherLibraryChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(LIBRARY_CHANGED_EVENT, listener);
  return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, listener);
}
