import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { INVITE_CODE_RE, deleteUnusedInvite } from '@/lib/server/courseware/student-invites';
import { TeacherAuthError, requireTeacher } from '@/lib/server/teacher-auth';

const log = createLogger('TeacherInviteDelete');

/** Delete one UNUSED invite. Used codes are records of who joined — kept. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  try {
    const session = await requireTeacher(request);
    const { code } = await params;
    if (!INVITE_CODE_RE.test(code.toUpperCase())) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, '邀请码格式不正确');
    }
    const deleted = await deleteUnusedInvite(code.toUpperCase(), session.tid);
    if (!deleted) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, '邀请码不存在或已被使用');
    }
    return apiSuccess({ deleted: true });
  } catch (error) {
    if (error instanceof TeacherAuthError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, error.status, error.message);
    }
    log.error('Delete invite failed:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to delete invite');
  }
}
