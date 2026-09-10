/**
 * System settings stored in the `system_settings` table (teacher backend).
 *
 * The one setting that matters today is `server_providers` — the operator's
 * provider configuration (LLM/TTS/ASR/image/video/web-search entries), the
 * same shape as `configs/server-providers.yml` sections. The provider-config
 * module merges it over the yml file, so the operations backend can configure
 * models and keys on the page instead of editing files or env vars.
 */
import { execute, query, withTransaction } from '@/lib/server/db/pg';

export const SERVER_PROVIDERS_SETTING_KEY = 'server_providers';

/**
 * The deployment-wide default model ("provider:model") chosen in the settings
 * dialog.
 *
 * Deliberately its own row rather than a field inside `server_providers`: that
 * row is written with replace-the-whole-value semantics, so saving a default
 * model from a browser that holds no provider credentials would erase every
 * server-managed provider. Separate rows keep the two concerns independent.
 */
export const SERVER_DEFAULT_MODEL_SETTING_KEY = 'server_default_model';

export interface StoredSetting<T = unknown> {
  key: string;
  value: T;
  updatedBy: string | null;
  updatedAt: number;
}

interface SettingRow {
  setting_key: string;
  value_json: unknown;
  updated_by: string | null;
  updated_at: number;
}

function decodeRow<T>(row: SettingRow): StoredSetting<T> {
  const value =
    typeof row.value_json === 'string' ? (JSON.parse(row.value_json) as T) : (row.value_json as T);
  return {
    key: row.setting_key,
    value,
    updatedBy: row.updated_by,
    updatedAt: Number(row.updated_at),
  };
}

export async function getSystemSetting<T>(key: string): Promise<StoredSetting<T> | null> {
  if (!/^[a-z0-9_:-]{1,128}$/i.test(key)) return null;
  const rows = await query<SettingRow>(
    'SELECT setting_key, value_json, updated_by, updated_at FROM system_settings WHERE setting_key = $1',
    [key],
  );
  try {
    return rows[0] ? decodeRow<T>(rows[0]) : null;
  } catch {
    return null;
  }
}

export async function setSystemSetting(
  key: string,
  value: unknown,
  updatedBy: string,
): Promise<void> {
  const serialized = JSON.stringify(value);
  await withTransaction(async (connection) => {
    await connection.execute(
      'INSERT INTO system_settings (setting_key, value_json, updated_by, updated_at) VALUES ($1, $2, $3, $4) ' +
        'ON CONFLICT (setting_key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at',
      [key, serialized, updatedBy, Date.now()],
    );
  });
}

export async function deleteSystemSetting(key: string): Promise<void> {
  if (!/^[a-z0-9_:-]{1,128}$/i.test(key)) return;
  await execute('DELETE FROM system_settings WHERE setting_key = $1', [key]);
}
