import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { execute } from '@/lib/server/db/pg';
import { startRequestLog } from '@/lib/server/request-log';
import {
  createStudentSessionToken,
  studentCookieOptions,
  verifyStudentCredentials,
} from '@/lib/server/student-auth';

const log = createLogger('StudentLogin');

export async function POST(request: NextRequest) {
  const reqLog = startRequestLog(log, request);
  let username = '';
  try {
    const body = (await request.json().catch(() => null)) as {
      username?: string;
      password?: string;
    } | null;
    username = body?.username?.trim() ?? '';
    const password = body?.password ?? '';
    if (!username || !password) {
      reqLog.done(400, { reason: 'missing_fields' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, '请输入用户名和密码');
    }

    const student = await verifyStudentCredentials(username, password);
    if (!student) {
      // The username is an identifier, never the password — logging it makes
      // repeated failures against one account visible as an attack.
      reqLog.done(401, { reason: 'bad_credentials', username });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 401, '用户名或密码不正确');
    }

    await execute('UPDATE students SET last_login_at = $1 WHERE id = $2', [Date.now(), student.id]);

    const { token, maxAge } = createStudentSessionToken(student);
    const response = apiSuccess({ student });
    response.cookies.set('openmaic_student', token, studentCookieOptions(maxAge));
    reqLog.done(200, { studentId: student.id, username: student.username });
    return response;
  } catch (error) {
    reqLog.fail(error, { username: username || undefined });
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, '登录失败，请稍后重试');
  }
}
