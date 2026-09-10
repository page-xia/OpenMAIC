import { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import {
  authenticateTeacher,
  createTeacherSessionToken,
  TEACHER_COOKIE,
  sessionCookieOptions,
  TeacherAuthError,
} from '@/lib/server/teacher-auth';
import { createLogger } from '@/lib/logger';
import { startRequestLog } from '@/lib/server/request-log';

const log = createLogger('TeacherAuth');

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

export async function POST(request: NextRequest) {
  const reqLog = startRequestLog(log, request);
  let username = '';
  try {
    const parsed = loginSchema.safeParse(await request.json());
    if (!parsed.success) {
      reqLog.done(400, { reason: 'invalid_payload' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid login request');
    }
    username = parsed.data.username;

    const result = await authenticateTeacher(parsed.data.username, parsed.data.password);
    if ('error' in result) {
      if (result.error === 'locked') {
        reqLog.done(429, { reason: 'locked_out', username });
        return apiError(
          API_ERROR_CODES.RATE_LIMITED,
          429,
          'Too many failed attempts; try again in 15 minutes',
        );
      }
      reqLog.done(401, { reason: 'bad_credentials', username });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 401, 'Incorrect username or password');
    }

    const { token, maxAge } = createTeacherSessionToken(result.teacher);
    const response = apiSuccess({
      teacher: {
        username: result.teacher.username,
        displayName: result.teacher.displayName,
        role: result.teacher.role,
      },
    });
    response.cookies.set(TEACHER_COOKIE, token, sessionCookieOptions(maxAge));
    reqLog.done(200, { teacherId: result.teacher.id, username, role: result.teacher.role });
    return response;
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      reqLog.done(error.status, { username, reason: 'auth_error' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    reqLog.fail(error, { username: username || undefined });
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Login failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
