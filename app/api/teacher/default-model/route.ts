import { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import {
  getSystemSetting,
  SERVER_DEFAULT_MODEL_SETTING_KEY,
  setSystemSetting,
} from '@/lib/server/courseware/settings-repo';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('TeacherDefaultModel');

/**
 * The deployment-wide default model, stored in its own `system_settings` row.
 *
 * Separate from `/api/teacher/settings` (the provider credentials) on purpose:
 * that route replaces the whole `server_providers` value, so folding the
 * default model in would make "pick a default model" erase the operator's
 * providers whenever the writing browser held no provider credentials.
 *
 * "provider:model" form; an empty string clears the setting (the "follow
 * system" choice). Reads are any signed-in teacher; writes are admin-only,
 * matching the rest of the system settings surface.
 */
const bodySchema = z.object({
  model: z.string().trim().max(200),
});

export async function GET(request: NextRequest) {
  try {
    await requireTeacher(request);
    const setting = await getSystemSetting<unknown>(SERVER_DEFAULT_MODEL_SETTING_KEY);
    const value = typeof setting?.value === 'string' ? setting.value : '';
    return apiSuccess({
      defaultModel: value || null,
      updatedAt: setting?.updatedAt ?? null,
      updatedBy: setting?.updatedBy ?? null,
    });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Read default model failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to read default model');
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await requireTeacher(request);
    if (session.role !== 'admin') {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 403, '仅管理员可修改系统设置');
    }
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, '设置格式不正确');
    }

    await setSystemSetting(SERVER_DEFAULT_MODEL_SETTING_KEY, parsed.data.model, session.tid);
    return apiSuccess({ saved: true, defaultModel: parsed.data.model || null });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Write default model failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to save default model');
  }
}
