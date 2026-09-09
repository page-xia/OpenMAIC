import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { execute } from '@/lib/server/db/pg';
import {
  createStudentSessionToken,
  studentCookieOptions,
  verifyStudentCredentials,
} from '@/lib/server/student-auth';

const log = createLogger('StudentLogin');

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as {
      username?: string;
      password?: string;
    } | null;
    const username = body?.username?.trim() ?? '';
    const password = body?.password ?? '';
    if (!username || !password) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, '请输入用户名和密码');
    }

    const student = await verifyStudentCredentials(username, password);
    if (!student) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 401, '用户名或密码不正确');
    }

    await execute('UPDATE students SET last_login_at = $1 WHERE id = $2', [Date.now(), student.id]);

    const { token, maxAge } = createStudentSessionToken(student);
    const response = apiSuccess({ student });
    response.cookies.set('openmaic_student', token, studentCookieOptions(maxAge));
    return response;
  } catch (error) {
    log.error('Student login failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, '登录失败，请稍后重试');
  }
}
