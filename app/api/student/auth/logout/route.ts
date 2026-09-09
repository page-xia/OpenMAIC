import { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { STUDENT_COOKIE } from '@/lib/server/student-auth';

export async function POST(_request: NextRequest) {
  const response = apiSuccess({ ok: true });
  response.cookies.set(STUDENT_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
