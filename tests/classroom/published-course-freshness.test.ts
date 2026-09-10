import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The classroom's server-freshness probe drops a stale LOCAL document so the
// load re-fetches. Published courses are marked by version; unpublished drafts
// have no version, so their own `updatedAt` stamp is the marker — without it a
// re-preview after an edit would keep playing the cached copy.

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => void storage.clear(),
  key: () => null,
  length: 0,
};
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

const deleteDocument = vi.fn();

vi.mock('@/lib/document-store/store', () => ({
  getDocumentStore: () => ({ deleteDocument }),
}));

function mockCourseResponse(body: unknown, ok = true) {
  return vi.fn(async () => ({
    ok,
    json: async () => body,
  })) as unknown as typeof globalThis.fetch;
}

describe('syncPublishedCourseFreshness', () => {
  beforeEach(() => {
    vi.resetModules();
    deleteDocument.mockReset();
    storage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops the local copy when the draft stamp advanced', async () => {
    globalThis.fetch = mockCourseResponse({
      success: true,
      version: 0,
      teacherPreview: true,
      draftUpdatedAt: 200,
    });
    const { syncPublishedCourseFreshness } = await import(
      '@/lib/classroom/published-course-freshness'
    );

    // First visit: nothing cached yet, so nothing to drop.
    const first = await syncPublishedCourseFreshness('crs_x');
    expect(first).toMatchObject({ teacherPreview: true, draftUpdatedAt: 200 });
    expect(deleteDocument).not.toHaveBeenCalled();

    // Server edit advances the stamp → the now-cached copy is behind.
    await syncPublishedCourseFreshness('crs_x');
    globalThis.fetch = mockCourseResponse({
      success: true,
      version: 0,
      teacherPreview: true,
      draftUpdatedAt: 300,
    });
    await syncPublishedCourseFreshness('crs_x');
    expect(deleteDocument).toHaveBeenCalledWith('crs_x');
  });

  it('keeps the local copy when the draft stamp is unchanged', async () => {
    globalThis.fetch = mockCourseResponse({
      success: true,
      version: 0,
      teacherPreview: true,
      draftUpdatedAt: 500,
    });
    const { syncPublishedCourseFreshness } = await import(
      '@/lib/classroom/published-course-freshness'
    );

    await syncPublishedCourseFreshness('crs_y');
    await syncPublishedCourseFreshness('crs_y');

    expect(deleteDocument).not.toHaveBeenCalled();
  });

  it('uses the version, not the draft stamp, for a published course', async () => {
    globalThis.fetch = mockCourseResponse({ success: true, version: 1, teacherPreview: false });
    const { syncPublishedCourseFreshness } = await import(
      '@/lib/classroom/published-course-freshness'
    );

    await syncPublishedCourseFreshness('crs_z');
    globalThis.fetch = mockCourseResponse({ success: true, version: 2, teacherPreview: false });
    const probe = await syncPublishedCourseFreshness('crs_z');

    expect(probe?.draftUpdatedAt).toBeUndefined();
    expect(deleteDocument).toHaveBeenCalledWith('crs_z');
  });

  it('returns null when the course is not readable by this viewer', async () => {
    globalThis.fetch = mockCourseResponse({ success: false }, false);
    const { syncPublishedCourseFreshness } = await import(
      '@/lib/classroom/published-course-freshness'
    );

    expect(await syncPublishedCourseFreshness('crs_none')).toBeNull();
    expect(deleteDocument).not.toHaveBeenCalled();
  });
});
