'use client';

// Side-effect import MUST stay first: it swaps the document-storage seam onto
// the teacher persistence contract before any classroom module renders.
import '@/lib/persistence/teacher-bootstrap';

import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';

import { ClassroomSurface } from '@/components/classroom/ClassroomSurface';
import { EditorAssistantProvider } from '@/components/edit/editor-assistant-context';
import { preloadEditor } from '@/lib/edit/preload-editor';
import { useStageStore } from '@/lib/store/stage';
import {
  TeacherAssistantPanel,
  type AssistantSeed,
} from '@/components/teacher/TeacherAssistantPanel';

/**
 * Teacher course editor: the real classroom surface in edit mode, with saves
 * flowing into PostgreSQL through the teacher persistence bootstrap. The classroom
 * component is untouched — the same body a student plays, driven in edit mode
 * with the document seam swapped.
 *
 * Entering edit mode follows the Pro Switch sequence: the editor chunk
 * (fonts + slide/quiz surfaces) is preloaded and registered BEFORE the mode
 * flips, so EditShell resolves a real surface instead of the read-only NOOP
 * fallback.
 *
 * Beside the classroom sits the AI assistant panel (workbench agent chat
 * bound to this course): the title-area "AI 一键生成课程" button and free-form
 * chat both land there. It needs the agent runtime; when that is not
 * configured the panel and the button simply do not render.
 */
export default function EditCoursePage() {
  const params = useParams<{ id: string }>();
  const courseId = params.id;

  const loadedId = useStageStore((state) => state.stage?.id ?? null);
  const stageName = useStageStore((state) => state.stage?.name ?? '');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const seedRef = useRef<AssistantSeed | null>(null);

  // One probe: the assistant entry points exist only when the agent runtime
  // can serve requests (flag + DATABASE_URL, per /api/agent/runtime).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/agent/runtime')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { enabled?: boolean } | null) => {
        if (!cancelled) setRuntimeReady(body?.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setRuntimeReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Enter the editor once the classroom has loaded (mode is playback by
  // default on load; Stage dispatches on it).
  useEffect(() => {
    if (loadedId !== courseId) return;
    let cancelled = false;
    preloadEditor()
      .then(() => {
        if (!cancelled) useStageStore.getState().setMode('edit');
      })
      .catch((error) => {
        // Stay in playback so the failure surfaces instead of half-entering
        // a broken edit chrome.
        console.error('[TeacherEdit] editor preload failed', error);
      });
    return () => {
      cancelled = true;
    };
  }, [loadedId, courseId]);

  return (
    <EditorAssistantProvider
      value={{
        courseId,
        runtimeReady,
        openAssistant: (seed) => {
          if (seed?.requirement) seedRef.current = { requirement: seed.requirement };
          setAssistantOpen(true);
        },
      }}
    >
      <div className="-m-6 flex h-[calc(100vh-3.5rem)] flex-col">
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <ClassroomSurface classroomId={courseId} variant="page" />
          </div>
          {runtimeReady ? (
            <TeacherAssistantPanel
              courseId={courseId}
              courseTitle={stageName || courseId}
              open={assistantOpen}
              onOpenChange={setAssistantOpen}
              seedRef={seedRef}
            />
          ) : null}
        </div>
      </div>
    </EditorAssistantProvider>
  );
}
