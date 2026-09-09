'use client';

/**
 * Editor AI assistant context — the seam between the teacher course editor
 * page and the edit chrome (CommandBar title area).
 *
 * The chrome components (`EditShell`, `EditChromeRoot`) are shared by every
 * entry point (standalone classroom, workbench panel, teacher editor). A
 * "AI 一键生成课程" affordance next to the title only makes sense on the
 * teacher editor page, where a course is open for authoring and the teacher
 * is signed in. Rather than threading props through the whole chrome, the
 * page provides this context and the chrome consumes it: no provider → no
 * button, and every other surface stays untouched.
 */

import { createContext, useContext } from 'react';

export interface EditorAssistantApi {
  /** The course the editor has open (the agent session's stage binding). */
  readonly courseId: string;
  /** Whether the agent runtime probe has succeeded (entry points render only then). */
  readonly runtimeReady: boolean;
  /** Open the assistant panel (optionally seeded with a generate request). */
  readonly openAssistant: (seed?: { readonly requirement?: string }) => void;
}

const EditorAssistantContext = createContext<EditorAssistantApi | null>(null);

export const EditorAssistantProvider = EditorAssistantContext.Provider;

/** The editor-page-provided assistant capability, or null outside that page. */
export function useEditorAssistant(): EditorAssistantApi | null {
  return useContext(EditorAssistantContext);
}
