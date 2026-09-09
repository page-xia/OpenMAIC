import { NextRequest } from 'next/server';
import { z } from 'zod';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import {
  createInviteBatch,
  INVITE_BATCH_MAX,
  listInvites,
} from '@/lib/server/courseware/student-invites';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';

const log = createLogger('TeacherInvites');

const createSchema = z.object({
  count: z.number().int().min(1).max(INVITE_BATCH_MAX),
  note: z.string().trim().max(100).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const session = await requireTeacher(request);
    const status = request.nextUrl.searchParams.get('status');
    const invites = await listInvites({
      status: status === 'unused' || status === 'used' ? status : undefined,
      teacherId: session.tid,
    });
    return apiSuccess({ invites });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('List invites failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to list invites');
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireTeacher(request);
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, '数量需为 1-200');
    }
    const { batchId, codes } = await createInviteBatch({
      teacherId: session.tid,
      count: parsed.data.count,
      note: parsed.data.note,
    });
    return apiSuccess({ batchId, codes }, 201);
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Create invite batch failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to create invites');
  }
}
