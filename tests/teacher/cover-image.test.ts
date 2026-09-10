/**
 * Course covers: which page becomes the default cover, and how a rasterized
 * page (or an uploaded image) is stored.
 *
 * The renderer snapshot is mocked — the real `@openmaic/renderer/snapshot`
 * needs a browser — so these tests cover the policy (which scene, what happens
 * when there is none) and the two-call storage handshake (asset upload →
 * course pointer), not html-to-image itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const renderedSlides: unknown[] = [];
vi.mock('@openmaic/renderer/snapshot', () => ({
  slideToPng: vi.fn(async (slide: unknown) => {
    renderedSlides.push(slide);
    return new Blob(['png'], { type: 'image/png' });
  }),
}));

import {
  COVER_RENDER_WIDTH,
  firstCoverScene,
  generateAndStoreCourseCover,
  renderCoverFromScenes,
  uploadCourseCover,
} from '@/lib/teacher/cover-image';
import type { AppScene, SlideContent } from '@/lib/types/stage';

function slideScene(id: string, order: number, elementCount: number): AppScene {
  const content: SlideContent = {
    type: 'slide',
    schemaVersion: 1,
    canvas: {
      id: `canvas-${id}`,
      viewportSize: 1000,
      viewportRatio: 0.5625,
      theme: {
        backgroundColor: '#ffffff',
        themeColors: ['#5b9bd5'],
        fontColor: '#333333',
        fontName: 'Microsoft YaHei',
        outline: { color: '#d14424', width: 2, style: 'solid' },
        shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
      },
      elements: Array.from({ length: elementCount }, (_, index) => ({
        id: `el-${id}-${index}`,
        type: 'text' as const,
        left: 0,
        top: 0,
        width: 100,
        height: 40,
        rotate: 0,
        content: '<p>hi</p>',
        defaultFontName: 'Microsoft YaHei',
        defaultColor: '#333333',
      })),
    },
  };
  return { id, stageId: 'stage-1', type: 'slide', order, title: id, actions: [], content };
}

function quizScene(id: string, order: number): AppScene {
  return {
    id,
    stageId: 'stage-1',
    type: 'quiz',
    order,
    title: id,
    actions: [],
    content: { type: 'quiz', questions: [] },
  } as unknown as AppScene;
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

afterEach(() => {
  renderedSlides.length = 0;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('firstCoverScene', () => {
  it('takes the first slide in play order, not array order', () => {
    const scenes = [slideScene('page-2', 2, 3), slideScene('page-1', 1, 2)];
    expect(firstCoverScene(scenes)?.id).toBe('page-1');
  });

  it('skips non-slide pages that cannot be rasterized', () => {
    const scenes = [quizScene('quiz', 1), slideScene('page-2', 2, 1)];
    expect(firstCoverScene(scenes)?.id).toBe('page-2');
  });

  it('skips an empty placeholder page — a blank card is worse than no cover', () => {
    const scenes = [slideScene('blank', 1, 0), slideScene('page-2', 2, 4)];
    expect(firstCoverScene(scenes)?.id).toBe('page-2');
    expect(firstCoverScene([slideScene('blank', 1, 0)])).toBeNull();
    expect(firstCoverScene([])).toBeNull();
  });
});

describe('renderCoverFromScenes', () => {
  it('rasterizes the first page at cover size', async () => {
    const blob = await renderCoverFromScenes([slideScene('page-1', 1, 2)]);
    expect(blob).toBeInstanceOf(Blob);
    expect(renderedSlides).toHaveLength(1);
    expect((renderedSlides[0] as { id: string }).id).toBe('canvas-page-1');
  });

  it('returns null without a renderable page instead of throwing', async () => {
    expect(await renderCoverFromScenes([quizScene('quiz', 1)])).toBeNull();
    expect(renderedSlides).toHaveLength(0);
    expect(COVER_RENDER_WIDTH).toBeGreaterThan(0);
  });
});

describe('cover storage', () => {
  it('uploads the image, then points the course at it', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === '/api/teacher/assets') {
        return jsonResponse({ success: true, asset: { id: 'ast_cover' } });
      }
      return jsonResponse({
        success: true,
        course: { id: 'crs_1', coverUrl: '/api/assets/ast_cover' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const course = await uploadCourseCover<{ id: string; coverUrl: string }>(
      'crs_1',
      new Blob(['png'], { type: 'image/png' }),
    );

    expect(course?.coverUrl).toBe('/api/assets/ast_cover');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [patchUrl, patchInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(patchUrl).toBe('/api/teacher/courses/crs_1');
    expect(patchInit.method).toBe('PATCH');
    expect(JSON.parse(String(patchInit.body))).toEqual({ coverAssetId: 'ast_cover' });
  });

  it('stops at the asset upload when it fails, and never throws', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: false }, false));
    vi.stubGlobal('fetch', fetchMock);

    expect(await uploadCourseCover('crs_1', new Blob(['png']))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('generates and stores in one step', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/teacher/assets') {
        return jsonResponse({ success: true, asset: { id: 'ast_auto' } });
      }
      return jsonResponse({
        success: true,
        course: { id: 'crs_1', coverUrl: '/api/assets/ast_auto' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const course = await generateAndStoreCourseCover<{ coverUrl: string }>('crs_1', [
      slideScene('page-1', 1, 1),
    ]);
    expect(course?.coverUrl).toBe('/api/assets/ast_auto');
  });
});
