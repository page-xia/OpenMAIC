import type { RequestListener } from 'node:http';

import { createDocumentHttpHandler } from '@openmaic/storage/server';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { runNodeRequestHandler } from '@/lib/server/node-http-bridge';
import { CoursewareDocumentStore } from '@/lib/server/courseware/document-store';
import { getTeacherSession } from '@/lib/server/teacher-auth';

export const runtime = 'nodejs';

const ROUTE_PREFIX = '/api/teacher/persistence';

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * Owner-scoped handlers, one per teacher. The teacher id comes from the
 * verified session cookie, never from the request path or body.
 */
const handlerByTeacher = new Map<string, Promise<RequestListener>>();

function getHandlerFor(teacherId: string, username: string): Promise<RequestListener> {
  const existing = handlerByTeacher.get(teacherId);
  if (existing) return existing;
  const created = Promise.resolve(
    createDocumentHttpHandler(
      new CoursewareDocumentStore({
        ownerId: teacherId,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
      }),
      {
        // The session is verified before the handler runs; the principal only
        // carries the learner-key-compatible identity the contract expects.
        authenticate: async () => ({ learnerKey: username }),
        authorizeDocuments: async () => true,
        validateScene: validateAppScene,
        validateStage: validateAppStage,
      },
    ),
  );
  handlerByTeacher.set(teacherId, created);
  return created;
}

async function handle(request: Request): Promise<Response> {
  const session = getTeacherSession(request);
  if (!session) {
    return jsonError(401, 'UNAUTHENTICATED', 'teacher session required');
  }
  const handler = await getHandlerFor(session.tid, session.username);
  try {
    return await runNodeRequestHandler(handler, request, ROUTE_PREFIX);
  } catch (error) {
    console.error('[teacher-persistence] Handler failed:', error);
    return jsonError(500, 'INTERNAL_ERROR', 'teacher persistence request failed');
  }
}

export const GET = (request: Request) => handle(request);
export const PUT = (request: Request) => handle(request);
export const POST = (request: Request) => handle(request);
export const DELETE = (request: Request) => handle(request);
