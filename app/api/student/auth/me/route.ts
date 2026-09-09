import { NextRequest } from 'next/server';

import { apiSuccess } from '@/lib/server/api-response';
import { getStudentSession } from '@/lib/server/student-auth';

/** Who the browser is, student-wise. Null student = not signed in. */
export async function GET(request: NextRequest) {
  const session = getStudentSession(request);
  return apiSuccess({
    student: session
      ? { id: session.sid, username: session.username, displayName: session.displayName }
      : null,
  });
}
