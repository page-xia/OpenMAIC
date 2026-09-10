import { describe, expect, it } from 'vitest';

import { startRequestLog } from '@/lib/server/request-log';
import type { createLogger } from '@/lib/logger';

type Logger = ReturnType<typeof createLogger>;

function fakeLogger() {
  const calls: Array<{ level: string; args: unknown[] }> = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      calls.push({ level, args });
    };
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  } as unknown as Logger;
  return { logger, calls };
}

function request(url: string, method = 'POST', headers: Record<string, string> = {}) {
  return new Request(url, { method, headers });
}

describe('startRequestLog', () => {
  it('derives the level from the status code', () => {
    const { logger, calls } = fakeLogger();
    startRequestLog(logger, request('http://x/api/a')).done(200);
    startRequestLog(logger, request('http://x/api/a')).done(404);
    startRequestLog(logger, request('http://x/api/a')).done(500);
    expect(calls.map((c) => c.level)).toEqual(['info', 'warn', 'error']);
  });

  it('honours the debug level for high-volume success', () => {
    const { logger, calls } = fakeLogger();
    startRequestLog(logger, request('http://x/api/p')).done(200, undefined, 'debug');
    expect(calls[0]!.level).toBe('debug');
  });

  it('includes method, path, status and attached fields', () => {
    const { logger, calls } = fakeLogger();
    const reqLog = startRequestLog(logger, request('http://x/api/student/progress'));
    reqLog.set({ studentId: 's_1' });
    reqLog.done(200, { sceneOrder: 3 });

    const [message, fields] = calls[0]!.args as [string, Record<string, unknown>];
    expect(message).toMatch(/^POST \/api\/student\/progress -> 200 in \d+ms$/);
    expect(fields).toMatchObject({ studentId: 's_1', sceneOrder: 3 });
    expect(fields.req).toBe(reqLog.id);
  });

  it('reuses an incoming x-request-id for correlation', () => {
    const { logger } = fakeLogger();
    const reqLog = startRequestLog(
      logger,
      request('http://x/api/a', 'GET', { 'x-request-id': 'trace-42' }),
    );
    expect(reqLog.id).toBe('trace-42');
  });

  it('generates an id when none is supplied', () => {
    const { logger } = fakeLogger();
    expect(startRequestLog(logger, request('http://x/api/a')).id).toMatch(/^[0-9a-f-]{8}$/);
  });

  it('fail() logs the error at error level with the fields', () => {
    const { logger, calls } = fakeLogger();
    const error = new Error('boom');
    startRequestLog(logger, request('http://x/api/a')).fail(error, { courseId: 'c_1' });

    expect(calls[0]!.level).toBe('error');
    const [message, logged, fields] = calls[0]!.args as [
      string,
      Error,
      Record<string, unknown>,
    ];
    expect(message).toMatch(/-> error in \d+ms$/);
    expect(logged).toBe(error);
    expect(fields).toMatchObject({ courseId: 'c_1' });
  });
});
