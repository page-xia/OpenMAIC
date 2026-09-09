import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ enabled: false }));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((href: string) => {
    throw new Error(`redirect:${href}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('not-found');
  }),
}));
/** The one cookie `resolveExitHref` reads — its value decides the exit target. */
const teacherCookie = vi.hoisted(() => ({ value: undefined as string | undefined }));
const workspaceEntry = vi.hoisted(() => vi.fn(() => null));

vi.mock('next/navigation', () => navigation);
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      teacherCookie.value === undefined ? undefined : { name, value: teacherCookie.value },
  }),
}));
vi.mock('@/lib/workbench/entry-gate', () => ({
  isWorkbenchEntryEnabled: () => state.enabled,
}));
vi.mock('@/lib/server/teacher-auth', () => ({
  TEACHER_COOKIE: 'openmaic_teacher',
  verifyTeacherSessionToken: (token: string | undefined) =>
    token === 'signed-token' ? { tid: 't1' } : null,
}));
vi.mock('@/components/workbench/WorkspaceEntry', () => ({
  WorkspaceEntry: workspaceEntry,
}));
vi.mock('@/app/workbench/new/client', () => ({
  WorkbenchLaunchBridge: () => null,
}));

import WorkbenchNewCompatibilityPage from '@/app/workbench/new/page';
import WorkspacePage from '@/app/workspace/page';
import { WorkspaceEntry } from '@/components/workbench/WorkspaceEntry';
import type { ReactElement } from 'react';

/** The page's Suspense boundary wraps the one WorkspaceEntry element. */
async function workspaceEntryElement(): Promise<ReactElement> {
  const tree = (await WorkspacePage()) as ReactElement<{ children?: ReactElement }>;
  const child = tree.props.children;
  expect(child).toBeTruthy();
  expect(child!.type).toBe(WorkspaceEntry);
  return child!;
}

describe('workbench entry routes', () => {
  beforeEach(() => {
    state.enabled = false;
    teacherCookie.value = undefined;
    navigation.redirect.mockClear();
    navigation.notFound.mockClear();
    workspaceEntry.mockClear();
  });

  it('redirects the workspace home instead of rendering a broken shell when disabled', async () => {
    await expect(WorkspacePage()).rejects.toThrow('redirect:/');
    expect(navigation.redirect).toHaveBeenCalledWith('/');
  });

  it('does not expose the legacy launch bridge when disabled', () => {
    expect(() => WorkbenchNewCompatibilityPage()).toThrow('not-found');
    expect(navigation.notFound).toHaveBeenCalledOnce();
  });

  it('renders both entry routes when the shared gate is enabled', async () => {
    state.enabled = true;
    expect(await WorkspacePage()).toBeTruthy();
    expect(WorkbenchNewCompatibilityPage()).toBeTruthy();
    expect(navigation.redirect).not.toHaveBeenCalled();
    expect(navigation.notFound).not.toHaveBeenCalled();
  });

  it('exits Pro to the teacher backend for a verified teacher session, the student home otherwise', async () => {
    state.enabled = true;

    // The teacher session cookie is httpOnly, so the destination is resolved
    // here on the server — where the signed token can actually be read. The
    // page returns the element tree; the destination rides on the
    // WorkspaceEntry element's props.
    teacherCookie.value = 'signed-token';
    const teacherExit = await workspaceEntryElement();
    expect(teacherExit.props).toEqual({ exitHref: '/teacher/courses' });

    teacherCookie.value = 'stale-or-forged';
    const studentExit = await workspaceEntryElement();
    expect(studentExit.props).toEqual({ exitHref: '/' });
  });
});
