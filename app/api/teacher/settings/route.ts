import { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { refreshServerProviderConfigOverlay } from '@/lib/server/provider-config';
import {
  getSystemSetting,
  SERVER_PROVIDERS_SETTING_KEY,
  setSystemSetting,
} from '@/lib/server/courseware/settings-repo';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';
import { createLogger } from '@/lib/logger';

const log = createLogger('TeacherSettings');

const entrySchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  models: z.array(z.string()).optional(),
  proxy: z.string().optional(),
  disabled: z.boolean().optional(),
});

const providersSchema = z.object({
  providers: z.record(z.string(), entrySchema).optional(),
  tts: z.record(z.string(), entrySchema).optional(),
  asr: z.record(z.string(), entrySchema).optional(),
  pdf: z.record(z.string(), entrySchema).optional(),
  image: z.record(z.string(), entrySchema).optional(),
  video: z.record(z.string(), entrySchema).optional(),
  'web-search': z.record(z.string(), entrySchema).optional(),
});

/** Mask an apiKey for display: keep a short head/tail, hide the middle. */
function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function maskSection(
  section: Record<string, z.infer<typeof entrySchema>> | undefined,
): Record<string, z.infer<typeof entrySchema>> | undefined {
  if (!section) return undefined;
  return Object.fromEntries(
    Object.entries(section).map(([id, entry]) => [
      id,
      { ...entry, ...(entry.apiKey ? { apiKey: maskKey(entry.apiKey) } : {}) },
    ]),
  );
}

export async function GET(request: NextRequest) {
  try {
    await requireTeacher(request);
    const setting = await getSystemSetting<Record<string, unknown>>(
      SERVER_PROVIDERS_SETTING_KEY,
    );
    const value = providersSchema.parse(setting?.value ?? {});
    return apiSuccess({
      settings: {
        providers: maskSection(value.providers),
        tts: maskSection(value.tts),
        asr: maskSection(value.asr),
        pdf: maskSection(value.pdf),
        image: maskSection(value.image),
        video: maskSection(value.video),
        'web-search': maskSection(value['web-search']),
      },
      updatedAt: setting?.updatedAt ?? null,
      updatedBy: setting?.updatedBy ?? null,
    });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Read settings failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to read settings');
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await requireTeacher(request);
    if (session.role !== 'admin') {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 403, '仅管理员可修改系统设置');
    }
    const parsed = providersSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, '设置格式不正确');
    }

    // Merge semantics: entries whose only apiKey is a masked display value
    // (contains ••••) keep the previously stored key instead of overwriting
    // the real secret with mask characters.
    const existing = await getSystemSetting<Record<string, Record<string, { apiKey?: string }>>>(
      SERVER_PROVIDERS_SETTING_KEY,
    );
    const next = parsed.data;
    for (const section of Object.keys(next) as (keyof typeof next)[]) {
      const entries = next[section];
      if (!entries) continue;
      const prevSection = existing?.value?.[section] ?? {};
      for (const [id, entry] of Object.entries(entries)) {
        if (entry.apiKey?.includes('••••')) {
          const prevKey = prevSection[id]?.apiKey;
          if (prevKey) entry.apiKey = prevKey;
          else delete entry.apiKey;
        }
      }
    }

    await setSystemSetting(SERVER_PROVIDERS_SETTING_KEY, next, session.tid);
    await refreshServerProviderConfigOverlay();
    return apiSuccess({ saved: true });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Write settings failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to save settings');
  }
}
