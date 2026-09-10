import { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { startRequestLog } from '@/lib/server/request-log';
import {
  INVITE_CODE_RE,
  registerStudentWithInvite,
} from '@/lib/server/courseware/student-invites';
import {
  createStudentSessionToken,
  studentCookieOptions,
} from '@/lib/server/student-auth';

const log = createLogger('StudentRegister');

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

const registerSchema = z.object({
  username: z.string().trim().regex(USERNAME_RE, '用户名需为 3-32 位字母、数字、- 或 _'),
  password: z.string().min(6).max(128),
  displayName: z.string().trim().min(1).max(32).optional(),
  inviteCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(INVITE_CODE_RE, '邀请码格式不正确'),
});

/**
 * Student registration, gated by a one-time invite code ("验证成功即失效"):
 * the guarded UPDATE that spends the code and the student INSERT share one
 * transaction, so a code can never seat two students. Success signs the
 * student session cookie immediately.
 */
export async function POST(request: NextRequest) {
  const reqLog = startRequestLog(log, request);
  let username: string | undefined;
  try {
    const parsed = registerSchema.safeParse(await request.json());
    if (!parsed.success) {
      reqLog.done(400, { reason: 'invalid_payload' });
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        parsed.error.issues[0]?.message ?? '参数不正确',
      );
    }
    username = parsed.data.username;
    const { password, inviteCode } = parsed.data;
    const displayName = parsed.data.displayName || username;

    const result = await registerStudentWithInvite({
      username,
      password,
      displayName,
      inviteCode,
    });
    if (!result.ok) {
      reqLog.done(400, { reason: result.reason, username });
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        result.reason === 'username' ? '用户名已被注册' : '邀请码无效或已被使用',
      );
    }

    const { token, maxAge } = createStudentSessionToken(result.student!);
    const response = apiSuccess({ student: result.student }, 201);
    response.cookies.set('openmaic_student', token, studentCookieOptions(maxAge));
    reqLog.done(201, { studentId: result.student!.id, username });
    return response;
  } catch (error) {
    reqLog.fail(error, { username });
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, '注册失败，请稍后重试');
  }
}
