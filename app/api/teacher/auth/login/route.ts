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

const log = createLogger('TeacherAuth');

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

export async function POST(request: NextRequest) {
  try {
    const parsed = loginSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid login request');
    }

    const result = await authenticateTeacher(parsed.data.username, parsed.data.password);
    if ('error' in result) {
      if (result.error === 'locked') {
        return apiError(
          API_ERROR_CODES.RATE_LIMITED,
          429,
          'Too many failed attempts; try again in 15 minutes',
        );
      }
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
    return response;
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Teacher login failed:', error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Login failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
