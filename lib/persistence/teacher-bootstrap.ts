'use client';

/**
 * Teacher workspace persistence bootstrap: swap the app-wide document storage
 * seam from the browser IndexedDB backend to the teacher's PostgreSQL-backed HTTP
 * contract at `/api/teacher/persistence`. Imported (for its side effect) at the
 * top of the teacher editor page module, so configuration lands at module
 * bootstrap — before any document consumer renders — exactly as the generic
 * persistence bootstrap in `lib/persistence/bootstrap.ts` does for the
 * Postgres-backed `/api/persistence`.
 *
 * The cookie session flows automatically (same origin). Editor saves (scene
 * edits, stage edits, whole-document writes) therefore autosave straight into
 * PostgreSQL under the signed-in teacher's ownership.
 */
import { HttpDocumentStore } from '@openmaic/storage';

import {
  assertDocumentStorageConfigurable,
  configureDocumentStorage,
  isDocumentStorageConfigured,
} from '@/lib/document-store/config';

if (typeof window !== 'undefined' && !isDocumentStorageConfigured()) {
  try {
    assertDocumentStorageConfigurable();
    configureDocumentStorage({
      store: ({ validateScene, validateStage }) =>
        new HttpDocumentStore({
          baseUrl: '/api/teacher/persistence',
          validateScene,
          validateStage,
        }),
    });
  } catch (error) {
    console.error(
      'FATAL: teacher persistence bootstrap failed; document storage stays browser-local',
      error,
    );
  }
}
