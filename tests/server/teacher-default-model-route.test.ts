import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The deployment default model route. Its reason to exist as a separate route
 * is that it must never write through `/api/teacher/settings` (which replaces
 * the whole `server_providers` value); these tests pin that independence plus
 * the admin-only write and the clear-on-empty behaviour.
 */
const mocks = vi.hoisted(() => ({
  requireTeacher: vi.fn(),
  getSystemSetting: vi.fn(),
  setSystemSetting: vi.fn(),
}));

vi.mock('@/lib/server/teacher-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/teacher-auth')>();
  return {
    ...actual,
    requireTeacher: mocks.requireTeacher,
  };
});

vi.mock('@/lib/server/courseware/settings-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/courseware/settings-repo')>();
  return {
    ...actual,
    getSystemSetting: mocks.getSystemSetting,
    setSystemSetting: mocks.setSystemSetting,
  };
});

const ADMIN = {
  tid: 't-1',
  username: 'admin',
  displayName: 'Admin',
  role: 'admin' as const,
  iat: 0,
  exp: 0,
};

function request(body?: unknown): Request {
  return new Request('http://localhost/api/teacher/default-model', {
    method: body === undefined ? 'GET' : 'PUT',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function putJson(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const { PUT } = await import('@/app/api/teacher/default-model/route');
  const response = await PUT(request(body) as never);
  return { status: response.status, json: await response.json() };
}

describe('teacher default-model route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.requireTeacher.mockReset();
    mocks.getSystemSetting.mockReset();
    mocks.setSystemSetting.mockReset();
    mocks.requireTeacher.mockResolvedValue(ADMIN);
  });

  it('returns null when nothing is stored', async () => {
    mocks.getSystemSetting.mockResolvedValue(null);
    const { GET } = await import('@/app/api/teacher/default-model/route');
    const response = await GET(request() as never);
    expect(response.status).toBe(200);
    expect((await response.json()).defaultModel).toBeNull();
  });

  it('returns the stored model', async () => {
    mocks.getSystemSetting.mockResolvedValue({ value: 'deepseek:deepseek-flash' });
    const { GET } = await import('@/app/api/teacher/default-model/route');
    const response = await GET(request() as never);
    expect((await response.json()).defaultModel).toBe('deepseek:deepseek-flash');
  });

  it('saves the selected model to its own settings key', async () => {
    const result = await putJson({ model: 'deepseek:deepseek-flash' });
    expect(result.status).toBe(200);
    expect(mocks.setSystemSetting).toHaveBeenCalledWith(
      'server_default_model',
      'deepseek:deepseek-flash',
      ADMIN.tid,
    );
  });

  it('does not write through the server_providers key', async () => {
    await putJson({ model: 'deepseek:deepseek-flash' });
    const keys = mocks.setSystemSetting.mock.calls.map((call) => call[0]);
    expect(keys).not.toContain('server_providers');
  });

  it('clears the setting when given an empty string', async () => {
    const result = await putJson({ model: '' });
    expect(result.status).toBe(200);
    expect(mocks.setSystemSetting).toHaveBeenCalledWith('server_default_model', '', ADMIN.tid);
    expect(result.json.defaultModel).toBeNull();
  });

  it('trims whitespace before storing', async () => {
    await putJson({ model: '  openai:gpt-4o  ' });
    expect(mocks.setSystemSetting).toHaveBeenCalledWith(
      'server_default_model',
      'openai:gpt-4o',
      ADMIN.tid,
    );
  });

  it('refuses a non-admin write', async () => {
    mocks.requireTeacher.mockResolvedValue({ ...ADMIN, role: 'teacher' });
    const result = await putJson({ model: 'deepseek:deepseek-flash' });
    expect(result.status).toBe(403);
    expect(mocks.setSystemSetting).not.toHaveBeenCalled();
  });

  it('rejects a malformed body', async () => {
    const result = await putJson({ model: 42 });
    expect(result.status).toBe(400);
    expect(mocks.setSystemSetting).not.toHaveBeenCalled();
  });
});
