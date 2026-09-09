/**
 * Courseware backend integration test: exercises the PostgreSQL-backed teacher
 * workspace end to end — auth, course creation, document round-trips through
 * CoursewareDocumentStore, publish snapshots, `.maic.zip` import, and cascading
 * deletion. Requires a reachable PostgreSQL (DATABASE_URL); skips when the
 * server is down so environments without a database stay green.
 */
import { nanoid } from 'nanoid';
import JSZip from 'jszip';
import { afterAll, describe, expect, test } from 'vitest';

import { closeCoursewarePool, ensureCoursewareDatabase } from '@/lib/server/db/pg';
import {
  authenticateTeacher,
  createTeacherSessionToken,
  verifyTeacherSessionToken,
} from '@/lib/server/teacher-auth';
import {
  createCourse,
  deleteCourse,
  documentStoreFor,
  getCourseForTeacher,
  getPublishedSnapshot,
  listCoursesForTeacher,
  listPublishedCourses,
  publishCourse,
  unpublishCourse,
} from '@/lib/server/courseware/course-repo';
import { importClassroomZip } from '@/lib/server/courseware/zip-import';
import { createBlankSlideScene } from '@/lib/edit/slide-defaults';

async function coursewareReachable(): Promise<boolean> {
  try {
    await ensureCoursewareDatabase();
    return true;
  } catch {
    return false;
  }
}

const reachable = await coursewareReachable();

describe.skipIf(!reachable)('courseware backend (PostgreSQL)', () => {
  afterAll(async () => {
    await closeCoursewarePool();
  });

  test('teacher login seeds an admin and mints verifiable sessions', async () => {
    const result = await authenticateTeacher('admin', 'Admin@123456');
    expect('error' in result && result.error).toBe(false);
    if ('error' in result) return;
    expect(result.teacher.role).toBe('admin');

    const { token } = createTeacherSessionToken(result.teacher);
    const session = verifyTeacherSessionToken(token);
    expect(session?.tid).toBe(result.teacher.id);

    expect(verifyTeacherSessionToken(`${token}x`)).toBeNull();
    expect(verifyTeacherSessionToken('garbage')).toBeNull();
  });

  test('blank course + document round-trip + scene ops', async () => {
    const auth = await authenticateTeacher('admin', 'Admin@123456');
    if ('error' in auth) throw new Error('login failed');
    const teacherId = auth.teacher.id;

    const course = await createCourse(teacherId, {
      title: `测试课程-${nanoid(4)}`,
      source: 'blank',
    });
    expect(course.status).toBe('draft');
    expect(course.sceneCount).toBe(1);

    const store = documentStoreFor(teacherId);
    const loaded = await store.loadDocument(course.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.stage.id).toBe(course.id);
    expect(loaded!.scenes).toHaveLength(1);

    const second = createBlankSlideScene(course.id, '第二页', 1);
    await store.saveDocument({
      stage: { ...loaded!.stage, name: `${course.title} v2` },
      scenes: [...loaded!.scenes, second],
    });
    const reloaded = await store.loadDocument(course.id);
    expect(reloaded!.scenes).toHaveLength(2);
    expect(reloaded!.stage.name).toBe(`${course.title} v2`);

    await store.deleteScene(course.id, second.id);
    const afterDelete = await store.loadDocument(course.id);
    expect(afterDelete!.scenes).toHaveLength(1);

    // Cross-teacher isolation: another owner sees nothing.
    const otherStore = documentStoreFor('tch_doesnotexist');
    expect(await otherStore.loadDocument(course.id)).toBeNull();

    expect(await deleteCourse(teacherId, course.id)).toBe(true);
    expect(await getCourseForTeacher(teacherId, course.id)).toBeNull();
  });

  test('publish freezes a snapshot; unpublish hides it', async () => {
    const auth = await authenticateTeacher('admin', 'Admin@123456');
    if ('error' in auth) throw new Error('login failed');
    const teacherId = auth.teacher.id;

    const course = await createCourse(teacherId, {
      title: `发布测试-${nanoid(4)}`,
      source: 'blank',
    });
    const published = await publishCourse(teacherId, course.id);
    expect(published).not.toBeNull();

    const snapshot = await getPublishedSnapshot(course.id);
    expect(snapshot?.version).toBe(published!.version);
    expect(snapshot?.stage.id).toBe(course.id);
    expect(await listPublishedCourses()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: course.id })]),
    );

    // Draft edits after publishing must not leak into the frozen snapshot.
    const store = documentStoreFor(teacherId);
    const loaded = await store.loadDocument(course.id);
    await store.saveDocument({
      stage: { ...loaded!.stage, name: `${course.title} 改后` },
      scenes: loaded!.scenes,
    });
    const frozen = await getPublishedSnapshot(course.id);
    expect(frozen?.stage.name).toBe(course.title);

    await unpublishCourse(teacherId, course.id);
    expect(await getPublishedSnapshot(course.id)).toBeNull();
    await deleteCourse(teacherId, course.id);
  });

  test('.maic.zip import rewrites media refs to server asset URLs', async () => {
    const auth = await authenticateTeacher('admin', 'Admin@123456');
    if ('error' in auth) throw new Error('login failed');
    const teacherId = auth.teacher.id;

    const zip = new JSZip();
    zip.file(
      'manifest.json',
      JSON.stringify({
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        appVersion: 'test',
        stage: { name: `Zip导入-${nanoid(4)}`, createdAt: Date.now(), updatedAt: Date.now() },
        agents: [
          {
            name: '王老师',
            role: 'teacher',
            persona: '严谨',
            avatar: '👩‍🏫',
            color: '#5b9bd5',
            priority: 100,
          },
        ],
        scenes: [
          {
            type: 'slide',
            title: '封面',
            order: 0,
            content: {
              type: 'slide',
              canvas: {
                id: nanoid(),
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
                elements: [
                  {
                    type: 'image',
                    id: 'img1',
                    src: 'coverimg',
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                    rotate: 0,
                  },
                ],
                background: { type: 'solid', color: '#ffffff' },
              },
            },
            actions: [
              {
                id: 'a1',
                type: 'speech',
                text: '大家好',
                audioRef: 'audio/narration.mp3',
                agentIndex: 0,
              },
            ],
          },
        ],
        mediaIndex: {
          'audio/narration.mp3': { type: 'audio', format: 'mp3', duration: 3 },
          'media/coverimg.jpeg': { type: 'image', mimeType: 'image/jpeg', sourceRef: 'coverimg' },
        },
      }),
    );
    zip.file('audio/narration.mp3', Buffer.from('fake-mp3-bytes'));
    zip.file('media/coverimg.jpeg', Buffer.from('fake-jpeg-bytes'));
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });

    const imported = await importClassroomZip(teacherId, bytes);
    expect(imported.assetCount).toBeGreaterThanOrEqual(2);

    const store = documentStoreFor(teacherId);
    const document = await store.loadDocument(imported.course.id);
    expect(document).not.toBeNull();
    expect(document!.stage.generatedAgentConfigs).toHaveLength(1);

    const canvas = (
      document!.scenes[0]!.content as { canvas: { elements: { type: string; src?: string }[] } }
    ).canvas;
    expect(canvas.elements[0]!.src).toMatch(/^\/api\/assets\/ast_/);

    const speech = document!.scenes[0]!.actions?.[0] as unknown as { audioUrl?: string };
    expect(speech?.audioUrl).toMatch(/^\/api\/assets\/ast_/);

    expect(await deleteCourse(teacherId, imported.course.id)).toBe(true);
    expect(
      (await listCoursesForTeacher(teacherId)).find((c) => c.id === imported.course.id),
    ).toBeUndefined();
  });

  test('rejects a buffer that is not a courseware zip', async () => {
    const auth = await authenticateTeacher('admin', 'Admin@123456');
    if ('error' in auth) throw new Error('login failed');
    await expect(importClassroomZip(auth.teacher.id, Buffer.from('not a zip'))).rejects.toThrow(
      /zip/,
    );
  });
});
