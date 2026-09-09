'use client';

/**
 * Student management — the one-page view of everything a teacher cares about.
 *
 * Layout: master-detail. The left column is the roster (search + activity
 * summary per student); selecting a student fills the right column with three
 * clearly separated sections — profile (account actions), per-course learning
 * progress (progress bar + last position), and the Q&A record from the
 * assistant chat. One page, three questions answered: who is here, how far
 * did they get, what did they ask.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  KeyRound,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Search,
  Trash2,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

interface StudentListItem {
  id: string;
  username: string;
  displayName: string;
  invitedByCode: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  coursesOpened: number;
  lastStudyAt: number | null;
  questionCount: number;
}

interface CourseProgressItem {
  courseId: string;
  courseTitle: string;
  courseStatus: string;
  sceneCount: number;
  maxSceneOrder: number;
  lastSceneOrder: number | null;
  openCount: number;
  lastOpenedAt: number;
}

interface StudentQuestionItem {
  id: string;
  question: string;
  answer: string | null;
  createdAt: number;
}

interface StudentDetail {
  profile: StudentListItem & { lastLoginAt: number | null };
  progress: CourseProgressItem[];
  questions: StudentQuestionItem[];
}

function formatTime(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** Relative phrasing for the roster's activity column. */
function relativeTime(ms: number | null): string {
  if (!ms) return '从未活跃';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export default function TeacherStudentsPage() {
  const [students, setStudents] = useState<StudentListItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StudentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StudentListItem | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const response = await fetch('/api/teacher/students');
      const body = (await response.json()) as { success: boolean; students?: StudentListItem[] };
      if (!response.ok || !body.success) throw new Error(String(response.status));
      setStudents(body.students ?? []);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/teacher/students/${id}`);
      const body = (await response.json()) as { success: boolean } & Partial<StudentDetail>;
      if (!response.ok || !body.success || !body.profile) {
        setDetail(null);
        return;
      }
      setDetail({
        profile: body.profile,
        progress: body.progress ?? [],
        questions: body.questions ?? [],
      });
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const filtered = useMemo(() => {
    const list = students ?? [];
    const q = keyword.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (student) =>
        student.displayName.toLowerCase().includes(q) ||
        student.username.toLowerCase().includes(q) ||
        (student.invitedByCode ?? '').toLowerCase().includes(q),
    );
  }, [students, keyword]);

  const stats = useMemo(() => {
    const list = students ?? [];
    const weekAgo = Date.now() - 7 * 86_400_000;
    return {
      total: list.length,
      activeThisWeek: list.filter(
        (student) =>
          (student.lastStudyAt ?? 0) > weekAgo || (student.lastLoginAt ?? 0) > weekAgo,
      ).length,
      questions: list.reduce((sum, student) => sum + student.questionCount, 0),
    };
  }, [students]);

  async function resetPassword(student: StudentListItem) {
    const response = await fetch(`/api/teacher/students/${student.id}`, { method: 'POST' });
    const body = (await response.json()) as { success: boolean; tempPassword?: string };
    if (!response.ok || !body.success || !body.tempPassword) {
      toast.error('重置失败');
      return;
    }
    await navigator.clipboard.writeText(body.tempPassword).catch(() => undefined);
    toast.success(`新密码 ${body.tempPassword}（已复制，请告知学生）`, { duration: 10000 });
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const response = await fetch(`/api/teacher/students/${deleteTarget.id}`, { method: 'DELETE' });
    const body = (await response.json()) as { success: boolean };
    if (!response.ok || !body.success) {
      toast.error('删除失败');
      return;
    }
    toast.success(`已删除学生 ${deleteTarget.displayName}`);
    setDeleteTarget(null);
    setSelectedId(null);
    setDetail(null);
    await load();
  }

  const selectedStudent = filtered.find((student) => student.id === selectedId) ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">学生管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            学生名单、每门课的学习进度和助教提问记录，都在这一页。
          </p>
        </div>
        <Button variant="outline" size="icon" aria-label="刷新" onClick={() => void load()}>
          <RefreshCw className="size-4" />
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: '学生总数', value: stats.total },
          { label: '本周活跃', value: stats.activeThisWeek },
          { label: '累计提问', value: stats.questions },
        ].map((item) => (
          <Card key={item.label}>
            <CardContent className="px-4 py-3">
              <p className="text-xs text-muted-foreground">{item.label}</p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums">{item.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Master-detail */}
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Roster */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="搜索昵称 / 用户名 / 邀请码"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </div>
          {loadError ? (
            <p className="py-8 text-center text-sm text-destructive">加载失败，请刷新重试。</p>
          ) : students === null ? (
            <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {students.length === 0 ? '还没有学生注册。' : '没有匹配的学生。'}
            </p>
          ) : (
            <div className="space-y-1.5" data-testid="student-roster">
              {filtered.map((student) => (
                <button
                  key={student.id}
                  type="button"
                  onClick={() => setSelectedId(student.id)}
                  className={cn(
                    'w-full rounded-lg border bg-card px-3 py-2.5 text-left transition-colors',
                    student.id === selectedId
                      ? 'border-primary/40 bg-primary/5 ring-1 ring-primary/30'
                      : 'hover:bg-muted/60',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {student.displayName}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {relativeTime(student.lastStudyAt ?? student.lastLoginAt)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span>{student.username}</span>
                    <span>{student.coursesOpened} 门课</span>
                    <span className="inline-flex items-center gap-0.5">
                      <MessageSquareText className="size-3" />
                      {student.questionCount}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Detail */}
        <div className="min-w-0 space-y-4">
          {!selectedId ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
                <UserRound className="size-8 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">从左侧选择一位学生查看详情。</p>
              </CardContent>
            </Card>
          ) : detailLoading || !detail ? (
            <Card>
              <CardContent className="flex items-center justify-center py-16">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Profile */}
              <Card>
                <CardContent className="space-y-3 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-base font-semibold">{detail.profile.displayName}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {detail.profile.username} · 邀请码{' '}
                        {detail.profile.invitedByCode ?? '—'}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void resetPassword(detail.profile)}
                      >
                        <KeyRound className="size-4" />
                        重置密码
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(selectedStudent ?? detail.profile)}
                      >
                        <Trash2 className="size-4" />
                        删除
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                    <span>注册于 {formatTime(detail.profile.createdAt)}</span>
                    <span>最近登录 {formatTime(detail.profile.lastLoginAt)}</span>
                    <span>{detail.progress.length} 门课有学习记录</span>
                  </div>
                </CardContent>
              </Card>

              {/* Learning progress */}
              <Card>
                <CardContent className="py-4">
                  <p className="mb-3 text-sm font-semibold">学习进度</p>
                  {detail.progress.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      还没有课堂学习记录。
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {detail.progress.map((item) => {
                        const percent =
                          item.sceneCount > 0
                            ? Math.min(100, Math.round((item.maxSceneOrder / item.sceneCount) * 100))
                            : 0;
                        return (
                          <div key={item.courseId} className="rounded-lg border p-3">
                            <div className="flex items-center gap-2">
                              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                {item.courseTitle}
                              </span>
                              <Badge variant={item.courseStatus === 'published' ? 'default' : 'secondary'}>
                                {item.courseStatus === 'published' ? '已发布' : '草稿'}
                              </Badge>
                              <span className="shrink-0 text-xs font-semibold tabular-nums">
                                {percent}%
                              </span>
                            </div>
                            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary transition-all"
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                            <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                              <span>
                                学到第 {item.lastSceneOrder ?? '—'} / {item.sceneCount} 页
                              </span>
                              <span>打开 {item.openCount} 次</span>
                              <span>最后学习 {formatTime(item.lastOpenedAt)}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Questions */}
              <Card>
                <CardContent className="py-4">
                  <p className="mb-3 flex items-center gap-1.5 text-sm font-semibold">
                    <MessageSquareText className="size-4" />
                    助教提问记录（{detail.questions.length}）
                  </p>
                  {detail.questions.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      还没有向 AI 助教提问。
                    </p>
                  ) : (
                    <div className="space-y-2.5">
                      {detail.questions.map((item) => (
                        <div key={item.id} className="rounded-lg border p-3">
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 shrink-0 text-xs font-medium text-primary">
                              问
                            </span>
                            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm">
                              {item.question}
                            </p>
                            <span className="shrink-0 text-[11px] text-muted-foreground">
                              {formatTime(item.createdAt)}
                            </span>
                          </div>
                          {item.answer ? (
                            <div className="mt-2 flex items-start gap-2 border-t pt-2">
                              <span className="mt-0.5 shrink-0 text-xs font-medium text-muted-foreground">
                                答
                              </span>
                              <p className="line-clamp-4 min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                                {item.answer}
                              </p>
                            </div>
                          ) : (
                            <p className="mt-2 text-xs text-muted-foreground/70">（未获得回答）</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除学生 {deleteTarget?.displayName}？</AlertDialogTitle>
            <AlertDialogDescription>
              学生的学习进度和提问记录会一并删除；其使用的邀请码保持已使用状态，无法再次注册。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void confirmDelete()}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
