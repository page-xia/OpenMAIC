import { NextRequest } from 'next/server';

import { apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import { streamLLM } from '@/lib/ai/llm';
import { getServerProviders } from '@/lib/server/provider-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { getStudentSession } from '@/lib/server/student-auth';
import { recordQuestion, saveQuestionAnswer } from '@/lib/server/courseware/student-progress';
import { createLogger } from '@/lib/logger';
import { startRequestLog } from '@/lib/server/request-log';

const log = createLogger('StudentChat');

export const maxDuration = 60;

const SYSTEM_PROMPT = [
  '你是 OpenMAIC 课堂的 AI 学习助教，面向学生提供帮助。',
  '你可以解答学科问题、讲解概念、给出学习建议，也可以介绍如何在课程库中选择课程学习。',
  '回答使用与学生相同的语言，简洁、准确、友好；涉及知识性内容时给出关键推理步骤。',
  '如果学生的问题与某门已发布课程相关，可以建议他们进入该课程与课堂里的 AI 老师深入互动。',
].join('\n');

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Course-free assistant chat for the student home: the server-configured
 * default model answers, so students need no keys or settings. The stream is
 * piped from the model's full stream so a mid-stream provider failure reaches
 * the user as a visible message instead of a silently empty 200.
 */
export async function POST(request: NextRequest) {
  const reqLog = startRequestLog(log, request);
  const studentSession = getStudentSession(request);
  reqLog.set({ studentId: studentSession?.sid });
  try {
    const body = (await request.json()) as { messages?: ChatMessage[] };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const recent = messages
      .filter(
        (message) =>
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string' &&
          message.content.trim() !== '',
      )
      .slice(-20);
    if (recent.length === 0 || recent[recent.length - 1]!.role !== 'user') {
      reqLog.done(400, { reason: 'no_user_message' });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, '缺少有效的用户消息');
    }

    // Zero-config default: DEFAULT_MODEL (or a MODEL_ROUTES entry) wins;
    // otherwise fall back to the first server-configured provider's first
    // model so the assistant works as soon as any provider is configured.
    const configured = getServerProviders();
    const firstConfigured = Object.entries(configured).find(
      ([, entry]) => (entry.models?.length ?? 0) > 0,
    );
    const fallbackModel = firstConfigured
      ? `${firstConfigured[0]}:${firstConfigured[1].models![0]}`
      : undefined;

    let model;
    try {
      model = (
        await resolveModel({
          stage: 'chat-adapter',
          ...(fallbackModel ? { modelString: fallbackModel } : {}),
        })
      ).model;
    } catch (error) {
      reqLog.done(503, { reason: 'no_model' }, 'warn');
      log.warn('Student chat has no model configured:', error);
      return apiError(
        API_ERROR_CODES.MISSING_API_KEY,
        503,
        '管理员尚未配置 AI 模型，暂时无法使用助教聊天',
      );
    }

    const result = streamLLM(
      {
        model,
        system: SYSTEM_PROMPT,
        messages: recent.map((message) => ({ role: message.role, content: message.content })),
      },
      'student-assistant-chat',
    );

    // Signed-in students get their Q&A recorded for the teacher console. The
    // question row lands at ask time; the answer is patched in when the
    // stream finishes (partial answers are kept, so a mid-stream failure
    // still shows what was asked and how far it got).
    const questionText = recent[recent.length - 1]!.content;
    const questionId = studentSession
      ? await recordQuestion({ studentId: studentSession.sid, question: questionText }).catch(() => null)
      : null;

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        let answer = '';
        const safeEnqueue = (text: string) => {
          if (!closed) controller.enqueue(encoder.encode(text));
        };
        try {
          for await (const chunk of result.fullStream) {
            if (chunk.type === 'text-delta') {
              answer += chunk.text;
              safeEnqueue(chunk.text);
            } else if (chunk.type === 'error') throw chunk.error;
          }
        } catch (error) {
          log.error('Assistant stream failed:', error);
          safeEnqueue('\n[助教暂时无法回答，请稍后重试]');
        } finally {
          if (questionId) {
            await saveQuestionAnswer(questionId, answer).catch(() => undefined);
          }
          closed = true;
          controller.close();
          reqLog.done(200, {
            questionId,
            questionChars: questionText.length,
            answerChars: answer.length,
          });
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      },
    });
  } catch (error) {
    reqLog.fail(error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      '聊天失败，请稍后重试',
      error instanceof Error ? error.message : String(error),
    );
  }
}
