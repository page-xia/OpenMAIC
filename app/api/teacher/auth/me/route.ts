import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { getTeacherSession } from '@/lib/server/teacher-auth';

export async function GET(request: NextRequest) {
  const session = getTeacherSession(request);
  if (!session) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 401, 'Not signed in');
  }
  return apiSuccess({
    teacher: {
      id: session.tid,
      username: session.username,
      displayName: session.displayName,
      role: session.role,
    },
    expiresAt: session.exp,
  });
}
