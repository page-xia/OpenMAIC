import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// GET /api/student/courses/:id normally serves a published snapshot's version.
// For an unpublished course it must answer the OWNER teacher with a draft
// freshness marker instead of 404 — that marker is what lets the classroom drop
// a locally cached copy that predates the latest edit. Everyone else keeps
// getting the same 404 a nonexistent course gets, so this never becomes an
// existence oracle for another teacher's unpublished work.

const mocks = vi.hoisted(() => ({
  getPublishedSnapshot: vi.fn(),
  getDraftDocumentInfo: vi.fn(),
  getTeacherSession: vi.fn(),
  getStudentSession: vi.fn(),
}));

vi.mock('@/lib/server/courseware/course-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/courseware/course-repo')>();
  return {
    ...actual,
    getPublishedSnapshot: mocks.getPublishedSnapshot,
    getDraftDocumentInfo: mocks.getDraftDocumentInfo,
  };
});

vi.mock('@/lib/server/teacher-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/teacher-auth')>();
  return { ...actual, getTeacherSession: mocks.getTeacherSession };
});

vi.mock('@/lib/server/student-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/student-auth')>();
  return { ...actual, getStudentSession: mocks.getStudentSession };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const COURSE_ID = 'crs_draft_only';
const params = Promise.resolve({ id: COURSE_ID });
const request = new NextRequest(`http://localhost/api/student/courses/${COURSE_ID}`);

describe('GET /api/student/courses/:id — unpublished course', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getPublishedSnapshot.mockReset();
    mocks.getDraftDocumentInfo.mockReset();
    mocks.getTeacherSession.mockReset();
    mocks.getStudentSession.mockReset();
    mocks.getPublishedSnapshot.mockResolvedValue(null);
    mocks.getStudentSession.mockReturnValue(null);
  });

  it("answers the owner teacher with the draft's freshness stamp", async () => {
    mocks.getTeacherSession.mockReturnValue({ tid: 'tch_owner' });
    mocks.getDraftDocumentInfo.mockResolvedValue({ name: '草稿课件', updatedAt: 123456 });

    const { GET } = await import('@/app/api/student/courses/[id]/route');
    const res = await GET(request, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      success: true,
      version: 0,
      teacherPreview: true,
      draftUpdatedAt: 123456,
    });
    expect(mocks.getDraftDocumentInfo).toHaveBeenCalledWith('tch_owner', COURSE_ID);
  });

  it('does not answer a teacher who does not own the draft', async () => {
    mocks.getTeacherSession.mockReturnValue({ tid: 'tch_stranger' });
    // Owner-scoped read misses for a non-owner.
    mocks.getDraftDocumentInfo.mockResolvedValue(null);

    const { GET } = await import('@/app/api/student/courses/[id]/route');
    const res = await GET(request, { params });

    expect(res.status).toBe(404);
  });

  it('does not reach the draft store for a student viewer', async () => {
    mocks.getTeacherSession.mockReturnValue(null);
    mocks.getStudentSession.mockReturnValue({ sid: 'stu_1' });

    const { GET } = await import('@/app/api/student/courses/[id]/route');
    const res = await GET(request, { params });

    expect(res.status).toBe(404);
    expect(mocks.getDraftDocumentInfo).not.toHaveBeenCalled();
  });

  it('prefers the published snapshot when one exists', async () => {
    mocks.getTeacherSession.mockReturnValue({ tid: 'tch_owner' });
    mocks.getPublishedSnapshot.mockResolvedValue({
      courseId: COURSE_ID,
      version: 4,
      stage: { id: COURSE_ID, name: '已发布' },
      scenes: [],
    });

    const { GET } = await import('@/app/api/student/courses/[id]/route');
    const res = await GET(request, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.version).toBe(4);
    expect(json.draftUpdatedAt).toBeUndefined();
    expect(mocks.getDraftDocumentInfo).not.toHaveBeenCalled();
  });
});
