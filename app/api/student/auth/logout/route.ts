import { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { startRequestLog } from '@/lib/server/request-log';
import { getStudentSession, STUDENT_COOKIE } from '@/lib/server/student-auth';

const log = createLogger('StudentLogout');

export async function POST(request: NextRequest) {
  const reqLog = startRequestLog(log, request);
  const session = getStudentSession(request);
  const response = apiSuccess({ ok: true });
  response.cookies.set(STUDENT_COOKIE, '', { path: '/', maxAge: 0 });
  reqLog.done(200, { studentId: session?.sid });
  return response;
}
