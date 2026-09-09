'use client';

/**
 * Teacher operations shell — the Pro workspace's rail, on teacher data.
 *
 * The left rail is `TeacherRail` (components/teacher/TeacherRail.tsx): the
 * WorkspaceRail's exact visual layer — `workspace-shell.css` tokens and
 * `ws-*` classes, imported here so both surfaces share one stylesheet scope —
 * fed by `/api/teacher/courses` instead of the workbench data layer. The
 * layout body sits on the same canvas gradient and grain the workspace paints.
 * Below `md` the rail hides and a text nav returns (the workbench rail does
 * the same via `hidden md:flex`).
 */
import '@/components/workbench/workspace-shell.css';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { TeacherRail, type TeacherRailCourse } from '@/components/teacher/TeacherRail';

interface MeResponse {
  success: boolean;
  teacher?: { id: string; username: string; displayName: string; role: 'admin' | 'teacher' };
}

interface CoursesResponse {
  success: boolean;
  courses?: {
    id: string;
    title: string;
    status: 'draft' | 'published' | 'archived';
    sceneCount: number;
  }[];
}

export default function TeacherProtectedLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<MeResponse['teacher'] | null>(null);
  const [checked, setChecked] = useState(false);
  const [courses, setCourses] = useState<TeacherRailCourse[] | null>(null);
  const [coursesState, setCoursesState] = useState<'loading' | 'ready' | 'error'>('loading');
  // One unmounted flag shared by the session check and course loads below.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/teacher/auth/me');
        if (!response.ok) {
          router.replace('/teacher/login');
          return;
        }
        const body = (await response.json()) as MeResponse;
        if (!cancelled) setMe(body.teacher ?? null);
      } catch {
        router.replace('/teacher/login');
      } finally {
        if (!cancelled) setChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const loadCourses = useCallback(async () => {
    setCoursesState('loading');
    try {
      const response = await fetch('/api/teacher/courses');
      const body = (await response.json()) as CoursesResponse;
      if (!response.ok || !body.success) throw new Error(String(response.status));
      if (!cancelledRef.current) {
        setCourses(
          (body.courses ?? []).map((course) => ({
            id: course.id,
            title: course.title,
            status: course.status,
            sceneCount: course.sceneCount,
            updatedAt: 0,
          })),
        );
        setCoursesState('ready');
      }
    } catch {
      if (!cancelledRef.current) setCoursesState('error');
    }
  }, []);

  useEffect(() => {
    void loadCourses();
  }, [loadCourses]);

  const handleLogout = useCallback(async () => {
    await fetch('/api/teacher/auth/logout', { method: 'POST' }).catch(() => undefined);
    router.replace('/teacher/login');
  }, [router]);

  if (!checked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/40">
        <p className="text-sm text-muted-foreground">正在验证登录状态…</p>
      </div>
    );
  }

  // The active course id, for the rail's `ws-row-active` treatment.
  const activeCourseId = pathname.match(/^\/teacher\/courses\/([^/]+)/)?.[1] ?? null;

  return (
    // Fixed viewport height, matching the workspace shell root: the rail is
    // `h-full`, which only resolves against a definite parent height — under
    // `min-h-screen` it collapsed to content height. Scrolling belongs to
    // `main`, not the page.
    <div
      className="ws-root teacher-console flex h-[100dvh] w-full overflow-hidden text-[color:var(--ws-ink)]"
      style={{
        backgroundImage:
          'linear-gradient(to bottom, var(--ws-canvas-top), var(--ws-canvas-bottom))',
      }}
    >
      <TeacherRail
        courses={courses ?? []}
        state={coursesState}
        activeCourseId={activeCourseId}
        onReload={() => void loadCourses()}
        teacherName={me?.displayName ?? me?.username ?? ''}
        isAdmin={me?.role === 'admin'}
        onLogout={() => void handleLogout()}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile-only top bar: the rail hides below md, so the destinations
            come back as plain text links, mirroring the workbench's own
            narrow-viewport fallback. */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[color:var(--ws-line)] bg-[color:var(--ws-rail)] px-4 md:hidden">
          <nav className="flex items-center gap-3">
            <Link
              href="/teacher/courses"
              className="text-sm text-[color:var(--ws-ink-mute)] hover:text-[color:var(--ws-ink)]"
            >
              课件管理
            </Link>
            {me?.role === 'admin' && (
              <Link
                href="/teacher/settings"
                className="text-sm text-[color:var(--ws-ink-mute)] hover:text-[color:var(--ws-ink)]"
              >
                系统设置
              </Link>
            )}
          </nav>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="text-sm text-[color:var(--ws-ink-mute)] hover:text-[color:var(--ws-ink)]"
          >
            退出登录
          </button>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
