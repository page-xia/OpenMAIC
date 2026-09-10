/**
 * Request-scoped operational logging for API routes.
 *
 * A route that handles a user-facing operation emits ONE completion line —
 * method, path, status, duration, and who asked — so a support report
 * ("课件生成到一半卡住" / "学生说打不开课程") can be reconstructed from the server
 * log alone. The level follows the status: 5xx → error, 4xx → warn, else info,
 * which keeps a healthy deployment quiet while a broken one is loud.
 *
 * Facts a route only learns partway through (resolved model, job id, scene
 * count) are attached with `set()` and ride along on the completion line.
 * Credentials and message bodies must never be attached — log an identifier
 * (username, ids) or a length instead.
 *
 * `x-request-id` is honoured when a proxy or the client already mints one, so
 * a browser report can be grepped directly; otherwise a short random id is
 * generated. Either way `id` is returned so the route can echo it in an error
 * response and correlate client and server.
 */
import { randomUUID } from 'crypto';

import type { createLogger } from '@/lib/logger';

type Logger = ReturnType<typeof createLogger>;

export interface RequestLog {
  /** Correlation id for this request (from `x-request-id`, else generated). */
  readonly id: string;
  /** Attach facts learned mid-request; they appear on the completion line. */
  set(fields: Record<string, unknown>): void;
  /**
   * Record completion. The level is derived from `status` (5xx error, 4xx
   * warn, else info) unless `level` pins it — high-frequency success such as a
   * per-scene progress beacon belongs at `debug` so a healthy log stays calm.
   */
  done(status: number, fields?: Record<string, unknown>, level?: LogLevel): void;
  /** Record an unexpected failure (implies 500) with the error's stack. */
  fail(error: unknown, fields?: Record<string, unknown>): void;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function pathnameOf(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return request.url;
  }
}

function requestIdOf(request: Request): string {
  const incoming = request.headers.get('x-request-id')?.trim();
  if (incoming && incoming.length <= 64) return incoming;
  return randomUUID().slice(0, 8);
}

export function startRequestLog(
  logger: Logger,
  request: Request,
  initial: Record<string, unknown> = {},
): RequestLog {
  const startedAt = Date.now();
  const id = requestIdOf(request);
  const fields: Record<string, unknown> = { ...initial };
  const prefix = `${request.method} ${pathnameOf(request)}`;
  const line = (status: number | 'error') =>
    `${prefix} -> ${status} in ${Date.now() - startedAt}ms`;

  return {
    id,
    set(extra) {
      Object.assign(fields, extra);
    },
    done(status, extra, level) {
      const resolved = level ?? (status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info');
      logger[resolved](line(status), { req: id, ...fields, ...extra });
    },
    fail(error, extra) {
      logger.error(line('error'), error, { req: id, ...fields, ...extra });
    },
  };
}
