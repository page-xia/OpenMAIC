import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// GET /api/classroom on a course with no published snapshot must serve the
// owner teacher's LIVE draft document — otherwise "预览课堂" on an unpublished
// course 404s and the classroom shell sits empty, which is exactly the state
// that made a course unpublishable-by-inspection.
//
// The load is owner-scoped, so the same branch is the authorization check:
// a teacher who does not own the document gets nothing back, and students and
// anonymous visitors never reach it.

const mocks = vi.hoisted(() => ({
  readClassroom: vi.fn(),
  getPublishedSnapshot: vi.fn(),
  documentStoreFor: vi.fn(),
  loadDocument: vi.fn(),
  getTeacherSession: vi.fn(),
  getStudentSession: vi.fn(),
}));

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/classroom-storage')>();
  return { ...actual, readClassroom: mocks.readClassroom };
});

vi.mock('@/lib/server/courseware/course-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/courseware/course-repo')>();
  return {
    ...actual,
    getPublishedSnapshot: mocks.getPublishedSnapshot,
    documentStoreFor: mocks.documentStoreFor,
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

const DOCUMENT_ID = 'crs_draft_only';

/** A minimal DSL-shaped slide scene, so validation/sanitization have real work. */
function draftDocument() {
  return {
    stage: { id: DOCUMENT_ID, name: '未发布课件', createdAt: 0, updatedAt: 0 },
    scenes: [
      {
        id: 'scene-1',
        stageId: DOCUMENT_ID,
        title: '第一页',
        order: 0,
        type: 'slide',
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: {
              backgroundColor: '#ffffff',
              themeColors: ['#5b9bd5'],
              fontColor: '#333333',
              fontName: 'Microsoft YaHei',
            },
            elements: [],
          },
        },
      },
    ],
  };
}

function getRequest() {
  return new NextRequest(`http://localhost/api/classroom?id=${DOCUMENT_ID}`);
}

describe('GET /api/classroom — owner draft preview when nothing is published', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.readClassroom.mockReset();
    mocks.getPublishedSnapshot.mockReset();
    mocks.documentStoreFor.mockReset();
    mocks.loadDocument.mockReset();
    mocks.getTeacherSession.mockReset();
    mocks.getStudentSession.mockReset();

    // Every case starts "not published" and "no filesystem copy".
    mocks.getPublishedSnapshot.mockResolvedValue(null);
    mocks.readClassroom.mockResolvedValue(null);
    mocks.getStudentSession.mockReturnValue(null);
    mocks.documentStoreFor.mockReturnValue({ loadDocument: mocks.loadDocument });
  });

  it("serves the owner teacher's live draft and sanitizes it", async () => {
    mocks.getTeacherSession.mockReturnValue({ tid: 'tch_owner' });
    mocks.loadDocument.mockResolvedValue(draftDocument());

    const { GET } = await import('@/app/api/classroom/route');
    const res = await GET(getRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.classroom.id).toBe(DOCUMENT_ID);
    expect(json.classroom.scenes).toHaveLength(1);
    // The read was scoped to the asking teacher, not a global document read.
    expect(mocks.documentStoreFor).toHaveBeenCalledWith('tch_owner');
    expect(mocks.loadDocument).toHaveBeenCalledWith(DOCUMENT_ID);
  });

  it('does not fall back to a document the teacher does not own', async () => {
    // Owner-scoped read misses: null means "no such document in THIS workspace".
    mocks.getTeacherSession.mockReturnValue({ tid: 'tch_stranger' });
    mocks.loadDocument.mockResolvedValue(null);

    const { GET } = await import('@/app/api/classroom/route');
    const res = await GET(getRequest());

    expect(res.status).toBe(404);
    expect(mocks.documentStoreFor).toHaveBeenCalledWith('tch_stranger');
  });

  it('never reaches the draft store for an anonymous or student viewer', async () => {
    mocks.getTeacherSession.mockReturnValue(null);
    mocks.getStudentSession.mockReturnValue({ sid: 'stu_1' });

    const { GET } = await import('@/app/api/classroom/route');
    const res = await GET(getRequest());

    expect(res.status).toBe(404);
    expect(mocks.documentStoreFor).not.toHaveBeenCalled();
    expect(mocks.loadDocument).not.toHaveBeenCalled();
  });

  it('keeps serving the published snapshot when one exists', async () => {
    mocks.getTeacherSession.mockReturnValue({ tid: 'tch_owner' });
    mocks.getPublishedSnapshot.mockResolvedValue({
      courseId: DOCUMENT_ID,
      version: 3,
      stage: { id: DOCUMENT_ID, name: '已发布课件' },
      scenes: draftDocument().scenes,
    });

    const { GET } = await import('@/app/api/classroom/route');
    const res = await GET(getRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.classroom.stage.name).toBe('已发布课件');
    // The draft read is a FALLBACK, not a parallel source: it must not run.
    expect(mocks.documentStoreFor).not.toHaveBeenCalled();
  });
});
