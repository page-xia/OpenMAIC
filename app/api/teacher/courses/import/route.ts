import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { createCourse } from '@/lib/server/courseware/course-repo';
import { putCourseAsset } from '@/lib/server/courseware/asset-repo';
import { importClassroomZip, ZipImportError } from '@/lib/server/courseware/zip-import';
import { parsePptxIsolated, slidesToScenes } from '@/lib/server/agent-runtime/import-pptx';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';
import { createLogger } from '@/lib/logger';
import type { AppDocumentOutline } from '@/lib/document-store/persistence-types';

const log = createLogger('TeacherImport');

const MAX_IMPORT_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_IMPORT_SLIDES = 150;

function fileNameOf(file: File): string {
  return file.name || '';
}

function isPptxFile(file: File): boolean {
  const name = fileNameOf(file).toLowerCase();
  return (
    name.endsWith('.pptx') ||
    file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  );
}

function isZipFile(file: File): boolean {
  const name = fileNameOf(file).toLowerCase();
  return name.endsWith('.zip') || name.endsWith('.maic.zip') || file.type === 'application/zip';
}

async function importPptx(
  teacherId: string,
  file: File,
  titleOverride?: string,
): Promise<{ courseId: string; sceneCount: number }> {
  const { nanoid } = await import('nanoid');
  const courseId = `crs_${nanoid(16)}`;
  const buffer = await file.arrayBuffer();

  const slides = await parsePptxIsolated(buffer, {
    timeoutMs: 120_000,
    upload: async (blob: Blob, filename: string) => {
      const bytes = Buffer.from(await blob.arrayBuffer());
      const mimeType = blob.type || 'application/octet-stream';
      const { url } = await putCourseAsset({
        courseId,
        mimeType,
        origin: 'pptx_import',
        bytes,
        metadata: { originalName: filename },
      });
      return url;
    },
  });

  if (slides.length === 0) {
    throw new ZipImportError('PPTX 中没有可导入的幻灯片', 422);
  }
  if (slides.length > MAX_IMPORT_SLIDES) {
    slides.length = MAX_IMPORT_SLIDES;
  }

  const { scenes, outlines } = slidesToScenes(slides, courseId, { firstOrder: 0 });
  const firstTitle =
    titleOverride?.trim() ||
    fileNameOf(file).replace(/\.pptx$/i, '') ||
    '导入的课件';
  const now = Date.now();
  const outline: AppDocumentOutline = { outlines, createdAt: now, updatedAt: now };

  const course = await createCourse(teacherId, {
    id: courseId,
    title: firstTitle,
    source: 'pptx',
    scenes,
    outline,
  });
  return { courseId: course.id, sceneCount: scenes.length };
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireTeacher(request);
    const form = await request.formData();
    const file = form.get('file');
    const titleOverrideRaw = form.get('title');

    if (!(file instanceof File)) {
      return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'Missing file field');
    }
    if (file.size === 0 || file.size > MAX_IMPORT_BYTES) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 413, '文件为空或超过 100MB 限制');
    }
    const titleOverride = typeof titleOverrideRaw === 'string' ? titleOverrideRaw : undefined;

    if (isZipFile(file)) {
      const bytes = Buffer.from(await file.arrayBuffer());
      const result = await importClassroomZip(session.tid, bytes, { titleOverride });
      return apiSuccess(
        {
          course: result.course,
          assetCount: result.assetCount,
          source: 'maic_zip',
        },
        201,
      );
    }

    if (isPptxFile(file)) {
      const result = await importPptx(session.tid, file, titleOverride);
      return apiSuccess(
        { courseId: result.courseId, sceneCount: result.sceneCount, source: 'pptx' },
        201,
      );
    }

    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      415,
      '仅支持 .pptx 或 .maic.zip 文件',
    );
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    if (error instanceof ZipImportError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Course import failed:', error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      '导入失败',
      error instanceof Error ? error.message : String(error),
    );
  }
}
