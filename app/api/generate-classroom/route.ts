import { after, type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { createClassroomGenerationJob } from '@/lib/server/classroom-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { getStudentSession } from '@/lib/server/student-auth';
import { getTeacherSession } from '@/lib/server/teacher-auth';
import { createLogger } from '@/lib/logger';
import { startRequestLog } from '@/lib/server/request-log';

const log = createLogger('GenerateClassroom API');

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const reqLog = startRequestLog(log, req);
  let requirementSnippet: string | undefined;
  try {
    // Best-effort identity for the audit trail. Generation is not auth-gated,
    // so an anonymous caller is recorded as such rather than rejected.
    const teacher = getTeacherSession(req);
    const student = getStudentSession(req);
    const actor = teacher ? `teacher:${teacher.tid}` : student ? `student:${student.sid}` : 'anonymous';

    const rawBody = (await req.json()) as Partial<GenerateClassroomInput>;
    requirementSnippet = rawBody.requirement?.substring(0, 60);
    const body: GenerateClassroomInput = {
      requirement: rawBody.requirement || '',
      ...(rawBody.pdfContent ? { pdfContent: rawBody.pdfContent } : {}),

      ...(rawBody.enableWebSearch != null ? { enableWebSearch: rawBody.enableWebSearch } : {}),
      ...(rawBody.webSearchProviderId ? { webSearchProviderId: rawBody.webSearchProviderId } : {}),
      ...(rawBody.webSearchApiKey ? { webSearchApiKey: rawBody.webSearchApiKey } : {}),
      ...(rawBody.webSearchModelId ? { webSearchModelId: rawBody.webSearchModelId } : {}),
      ...(rawBody.baiduSubSources ? { baiduSubSources: rawBody.baiduSubSources } : {}),
      ...(rawBody.enableImageGeneration != null
        ? { enableImageGeneration: rawBody.enableImageGeneration }
        : {}),
      ...(rawBody.enableVideoGeneration != null
        ? { enableVideoGeneration: rawBody.enableVideoGeneration }
        : {}),
      ...(rawBody.enableTTS != null ? { enableTTS: rawBody.enableTTS } : {}),
      ...(rawBody.agentMode ? { agentMode: rawBody.agentMode } : {}),
    };
    const { requirement } = body;

    if (!requirement) {
      reqLog.done(400, { actor, reason: 'missing_requirement' });
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: requirement');
    }

    const baseUrl = buildRequestOrigin(req);
    const jobId = nanoid(10);
    const job = await createClassroomGenerationJob(jobId, body);
    const pollUrl = `${baseUrl}/api/generate-classroom/${jobId}`;

    reqLog.done(202, { actor, jobId, requirementChars: requirement.length });

    after(() => runClassroomGenerationJob(jobId, body, baseUrl, { requestId: reqLog.id, actor }));

    return apiSuccess(
      {
        jobId,
        status: job.status,
        step: job.step,
        message: job.message,
        pollUrl,
        pollIntervalMs: 5000,
      },
      202,
    );
  } catch (error) {
    reqLog.fail(error, { requirementPreview: requirementSnippet });
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to create classroom generation job',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
