'use client';

/**
 * Teacher AI assistant panel — the editor-embedded workbench chat.
 *
 * Reuses `WorkbenchChat` (the Pro workbench conversation surface) inside the
 * teacher course editor: the first message lazily mints an agent session
 * bound to the open course (`startConversationWithFirstMessage`), every
 * message carries the course ref so the agent always knows its editing
 * target, and `useWorkbenchStream` attaches the SSE event log.
 *
 * While the panel is open, `useStageFreshnessSync(courseId)` keeps the stage
 * store converging with the agent's writes: the manifest/scenes routes this
 * sync reads are owner-resolved, and on the teacher editor the owner resolves
 * to the courseware scope — the same database hand edits save into.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { PanelRightClose, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { WorkbenchChat } from '@/components/workbench/WorkbenchChat';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { makeCourseRef } from '@/lib/workbench/course-refs';
import { startConversationWithFirstMessage } from '@/lib/workbench/first-message-session';
import { useStageFreshnessSync, useWorkbenchStream } from '@/lib/workbench/use-workbench-session';
import {
  WorkbenchCourseNavigationProvider,
  WorkbenchDraftConversationProvider,
} from '@/lib/workbench/panel-context';
import { useStageStore } from '@/lib/store/stage';
import { useWorkbenchStore } from '@/lib/workbench/session-store';
import type { CourseRef } from '@/lib/workbench/course-refs';
import type { WorkbenchMaterial } from '@/lib/workbench/session-store';
import type { ElementRef } from '@/lib/workbench/element-refs';

const PANEL_WIDTH_PX = 400;
const COLLAPSED_WIDTH_PX = 44;

export interface AssistantSeed {
  /** A generate-course requirement to send as the first message. */
  readonly requirement?: string;
}

interface TeacherAssistantPanelProps {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Signals that a generate request should be sent (consumed once). */
  readonly seedRef: { current: AssistantSeed | null };
}

export function TeacherAssistantPanel({
  courseId,
  courseTitle,
  open,
  onOpenChange,
  seedRef,
}: TeacherAssistantPanelProps) {
  const { t } = useI18n();
  const sessionId = useWorkbenchStore((s) => s.sessionId);
  const attach = useWorkbenchStore((s) => s.attach);
  const detach = useWorkbenchStore((s) => s.detach);
  const stageName = useStageStore((s) => s.stage?.name ?? null);
  const effectiveTitle = stageName ?? courseTitle;
  const startingRef = useRef(false);

  // The teacher editor's classroom load owns the initial store fill; the sync
  // then keeps the deck fresh as the agent writes (see module doc).
  useStageFreshnessSync(open ? courseId : null);
  useWorkbenchStream(sessionId);

  const start = useCallback(
    async (message: {
      readonly text: string;
      readonly materials: readonly WorkbenchMaterial[];
      readonly elementRefs: readonly ElementRef[];
      readonly courseRefs: readonly CourseRef[];
    }) => {
      if (startingRef.current) {
        return { accepted: false, elementRefsAccepted: false, courseRefsAccepted: false };
      }
      startingRef.current = true;
      try {
        const result = await startConversationWithFirstMessage({
          stageId: courseId,
          text: message.text,
          materials: message.materials,
          elementRefs: message.elementRefs,
          courseRefs: message.courseRefs,
        });
        attach(result.sessionId, courseId);
        return {
          accepted: true,
          elementRefsAccepted: result.elementRefsAccepted,
          courseRefsAccepted: result.courseRefsAccepted,
        };
      } catch (error) {
        console.error('[TeacherAssistant] failed to start conversation', error);
        toast.error(t('edit.assistant.assistantUnavailable'));
        return { accepted: false, elementRefsAccepted: false, courseRefsAccepted: false };
      } finally {
        startingRef.current = false;
      }
    },
    [attach, courseId, t],
  );

  const draft = useMemo(
    () => ({ ownerKey: `teacher-course:${courseId}`, start }),
    [courseId, start],
  );

  // Detach when the panel closes for good (unmount), so a later visit starts
  // from the same lazy-first-message rule instead of a half-attached fold.
  useEffect(
    () => () => {
      detach();
    },
    [detach],
  );

  // The generate-course button (CommandBar title area) seeds a first message.
  useEffect(() => {
    if (!open) return;
    const seed = seedRef.current;
    if (!seed?.requirement) return;
    seedRef.current = null;
    const ref = makeCourseRef(courseId, effectiveTitle);
    void start({
      text: buildGeneratePrompt(seed.requirement),
      materials: [],
      elementRefs: [],
      courseRefs: ref ? [ref] : [],
    });
  }, [open, seedRef, start, courseId, effectiveTitle]);

  const navigation = useMemo(
    () => ({
      openCourse: () => onOpenChange(true),
      activeCourseId: courseId,
      lookupCourse: (id: string) =>
        id === courseId ? { id, name: effectiveTitle, pageCount: null } : null,
      courseOptions: [{ id: courseId, name: effectiveTitle }],
    }),
    [courseId, effectiveTitle, onOpenChange],
  );

  return (
    <aside
      data-testid="teacher-assistant-panel"
      data-open={open}
      className="flex h-full shrink-0 flex-col overflow-hidden border-l border-zinc-200/60 bg-white/90 backdrop-blur-xl dark:border-zinc-800/60 dark:bg-zinc-900/90"
      style={{ width: open ? PANEL_WIDTH_PX : COLLAPSED_WIDTH_PX }}
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-zinc-200/60 px-2 dark:border-zinc-800/60">
        <div className="flex min-w-0 items-center gap-2 px-1">
          <Sparkles className="size-4 shrink-0 text-violet-500" aria-hidden />
          {open ? (
            <span className="truncate text-sm font-semibold text-zinc-700 dark:text-zinc-200">
              {t('edit.assistant.assistantPanel')}
            </span>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 shrink-0"
          aria-label={
            open
              ? t('edit.assistant.assistantPanelCollapse')
              : t('edit.assistant.assistantPanelExpand')
          }
          title={
            open
              ? t('edit.assistant.assistantPanelCollapse')
              : t('edit.assistant.assistantPanelExpand')
          }
          onClick={() => onOpenChange(!open)}
        >
          <PanelRightClose
            className={cn('size-4 transition-transform', !open && 'rotate-180')}
            aria-hidden
          />
        </Button>
      </div>

      {open ? (
        <div className="relative min-h-0 flex-1">
          <WorkbenchCourseNavigationProvider navigation={navigation}>
            <WorkbenchDraftConversationProvider draft={draft}>
              <WorkbenchChat hosted adjacentPanelOpen={false} />
            </WorkbenchDraftConversationProvider>
          </WorkbenchCourseNavigationProvider>
        </div>
      ) : null}
    </aside>
  );
}

/** The instruction sent for the "AI 一键生成课程" button. */
export function buildGeneratePrompt(requirement: string): string {
  return [
    '请为当前课件一键生成完整课程内容。课程要求：',
    requirement,
    '',
    '你可以按需要改写已有页面、新增页面（幻灯片/测验）或删除空页面，并为每页生成讲稿；完成后请汇报你做了哪些调整。',
  ].join('\n');
}
