import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { putCourseAsset } from '@/lib/server/courseware/asset-repo';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('TeacherAssets');

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB — covers course videos
const ALLOWED_MIME_PREFIXES = ['image/', 'audio/', 'video/', 'application/pdf'];

export async function POST(request: NextRequest) {
  try {
    await requireTeacher(request);
    const form = await request.formData();
    const file = form.get('file');
    const courseIdRaw = form.get('courseId');
    const durationRaw = form.get('durationSec');

    if (!(file instanceof File)) {
      return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'Missing file field');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 413, 'File exceeds the 200 MB limit');
    }
    const mimeType = file.type || undefined;
    if (!mimeType || !ALLOWED_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        415,
        'Unsupported media type; images, audio, video and PDF are accepted',
      );
    }

    const courseId =
      typeof courseIdRaw === 'string' && /^[a-zA-Z0-9_-]+$/.test(courseIdRaw)
        ? courseIdRaw
        : undefined;
    const duration = typeof durationRaw === 'string' ? Number(durationRaw) : undefined;

    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await putCourseAsset({
      courseId,
      mimeType,
      origin: 'upload',
      bytes,
      ...(Number.isFinite(duration) && duration !== undefined && duration > 0
        ? { durationSec: duration }
        : {}),
      metadata: { originalName: file.name },
    });

    return apiSuccess(
      {
        asset: {
          id: result.record.id,
          url: result.url,
          kind: result.record.kind,
          mimeType: result.record.mimeType,
          sizeBytes: result.record.sizeBytes,
        },
      },
      201,
    );
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Asset upload failed:', error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to store asset',
      error instanceof Error ? error.message : String(error),
    );
  }
}
