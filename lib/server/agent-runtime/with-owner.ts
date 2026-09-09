import { getTeacherSession } from '@/lib/server/teacher-auth';
import { resolveRequestOwnerId, TEACHER_OWNER_PREFIX, teacherOwnerId } from './owner';

/**
 * Resolve the request owner identity and run a handler with its response
 * headers.
 *
 * The owner is the teacher when a valid `openmaic_teacher` cookie rides the
 * request (agent sessions then partition under `teacher:<tid>`, and the
 * document-store seam resolves their courseware store); otherwise it falls
 * back to the anonymous cookie identity.
 *
 * The Set-Cookie minted by resolveRequestOwnerId must ride every response,
 * including 4xx and 5xx: a client that retries after an error keeps the same
 * owner partition, while a 500 that dropped the cookie would silently make
 * the retry a different anonymous owner.
 */
export async function withRequestOwnerId(
  req: Pick<Request, 'headers'>,
  handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
): Promise<Response> {
  const responseHeaders = new Headers();
  const teacher = getTeacherSession(req as Request);
  const ownerId = teacher
    ? teacherOwnerId(teacher.tid)
    : resolveRequestOwnerId(req, responseHeaders);
  try {
    return await handler(ownerId, responseHeaders);
  } catch (error) {
    console.error('[agent-runtime] request failed while resolving an owner', error);
    return new Response('Internal Server Error', { status: 500, headers: responseHeaders });
  }
}

export { TEACHER_OWNER_PREFIX };
