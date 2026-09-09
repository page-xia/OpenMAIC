'use client';

/**
 * Student entry gate for the standalone classroom route.
 *
 * The server enforces the same boundary (`GET /api/classroom` answers 401 for
 * a published course without a student or teacher session); this gate makes
 * the UX a redirect to the login page instead of a dead error screen. A
 * teacher session passes — teacher previews of published courses are a
 * supported flow.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

interface GateState {
  readonly checked: boolean;
  readonly allow: boolean;
}

export function StudentGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<GateState>({ checked: false, allow: false });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const studentResponse = await fetch('/api/student/auth/me');
        const studentBody = (await studentResponse.json()) as { student?: unknown };
        if (studentBody.student) {
          if (!cancelled) setState({ checked: true, allow: true });
          return;
        }
        const teacherResponse = await fetch('/api/teacher/auth/me');
        if (!cancelled) setState({ checked: true, allow: teacherResponse.ok });
      } catch {
        if (!cancelled) setState({ checked: true, allow: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!state.checked) return;
    if (state.allow) return;
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    router.replace(`/login?next=${next}`);
  }, [state, router]);

  if (!state.checked || !state.allow) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/40">
        <p className="text-sm text-muted-foreground">正在验证登录状态…</p>
      </div>
    );
  }
  return <>{children}</>;
}
