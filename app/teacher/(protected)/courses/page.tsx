'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FilePlus2, Search } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { notifyTeacherLibraryChanged } from '@/lib/teacher/library-signal';

interface CourseListItem {
  id: string;
  title: string;
  description: string | null;
  status: 'draft' | 'published' | 'archived';
  source: string;
  sceneCount: number;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  publishedVersion: number;
  /** Cover image URL (page 1 by default, or the teacher's upload); null if unset. */
  coverUrl: string | null;
}

const STATUS_TABS = [
  { value: 'all', label: '全部' },
  { value: 'draft', label: '草稿' },
  { value: 'published', label: '已发布' },
] as const;

const STATUS_LABEL: Record<CourseListItem['status'], string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已下架',
};

const SOURCE_LABEL: Record<string, string> = {
  blank: '空白创建',
  pptx: 'PPTX 导入',
  maic_zip: '课件包导入',
  ai_generation: 'AI 生成',
};

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export default function TeacherCoursesPage() {
  const router = useRouter();
  const [courses, setCourses] = useState<CourseListItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [keyword, setKeyword] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (keyword.trim()) params.set('q', keyword.trim());
      const response = await fetch(`/api/teacher/courses?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { success: boolean; courses?: CourseListItem[] };
      if (body.success) {
        setCourses(body.courses ?? []);
        setLoadError(false);
      }
    } catch {
      setLoadError(true);
    }
  }, [statusFilter, keyword]);

  useEffect(() => {
    const timer = setTimeout(() => void reload(), keyword ? 300 : 0);
    return () => clearTimeout(timer);
  }, [reload, keyword]);

  const counts = useMemo(() => {
    const list = courses ?? [];
    return {
      total: list.length,
      draft: list.filter((course) => course.status === 'draft').length,
      published: list.filter((course) => course.status === 'published').length,
    };
  }, [courses]);

  async function togglePublish(course: CourseListItem) {
    if (busyId) return;
    setBusyId(course.id);
    try {
      const response = await fetch(`/api/teacher/courses/${course.id}/publish`, {
        method: course.status === 'published' ? 'DELETE' : 'POST',
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        toast.error(body?.error ?? (course.status === 'published' ? '下架失败' : '发布失败'));
        return;
      }
      toast.success(
        course.status === 'published' ? '已下架，学生端不再可见' : '发布成功，学生端可见',
      );
      notifyTeacherLibraryChanged();
      await reload();
    } catch {
      toast.error('网络错误，请重试');
    } finally {
      setBusyId(null);
    }
  }

  async function removeCourse(course: CourseListItem) {
    if (busyId) return;
    if (!window.confirm(`确定删除课件「${course.title}」？该操作不可恢复。`)) return;
    setBusyId(course.id);
    try {
      const response = await fetch(`/api/teacher/courses/${course.id}`, { method: 'DELETE' });
      if (!response.ok) {
        toast.error('删除失败');
        return;
      }
      toast.success('课件已删除');
      notifyTeacherLibraryChanged();
      await reload();
    } catch {
      toast.error('网络错误，请重试');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">课件管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {counts.total} 个课件 · 草稿 {counts.draft} · 已发布 {counts.published}
          </p>
        </div>
        <Button onClick={() => router.push('/teacher/courses/new')}>
          <FilePlus2 className="size-4" />
          新建课件
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_TABS.map((tab) => (
              <SelectItem key={tab.value} value={tab.value}>
                {tab.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="搜索课件标题…"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </div>
      </div>

      {loadError ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-destructive">
            课件列表加载失败，请确认数据库已启动后刷新重试。
          </CardContent>
        </Card>
      ) : courses === null ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            加载中…
          </CardContent>
        </Card>
      ) : courses.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-14">
            <p className="text-sm text-muted-foreground">
              {keyword || statusFilter !== 'all'
                ? '没有符合条件的课件'
                : '还没有课件，点击「新建课件」开始创建'}
            </p>
            {!keyword && statusFilter === 'all' ? (
              <Button asChild variant="outline">
                <Link href="/teacher/courses/new">创建第一个课件</Link>
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {courses.map((course) => (
            <Card key={course.id} className="py-0">
              <CardContent className="flex flex-wrap items-center gap-3 px-4 py-3">
                {/* Cover preview — the same image the student library card shows,
                    so a missing cover is visible here instead of only to students. */}
                <div className="h-12 w-20 shrink-0 overflow-hidden rounded-md border bg-muted">
                  {course.coverUrl ? (
                    <img
                      src={course.coverUrl}
                      alt=""
                      loading="lazy"
                      draggable={false}
                      className="size-full object-cover"
                    />
                  ) : (
                    <div className="flex size-full items-center justify-center text-[10px] text-muted-foreground">
                      无封面
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/teacher/courses/${course.id}`}
                      className="truncate text-sm font-medium hover:underline"
                    >
                      {course.title}
                    </Link>
                    <Badge variant={course.status === 'published' ? 'default' : 'secondary'}>
                      {STATUS_LABEL[course.status]}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {SOURCE_LABEL[course.source] ?? course.source} · {course.sceneCount} 个场景 ·
                    更新于 {formatDate(course.updatedAt)}
                    {course.publishedAt ? ` · 发布于 ${formatDate(course.publishedAt)}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/teacher/courses/${course.id}/edit`}>编辑</Link>
                  </Button>
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/classroom/${course.id}`} target="_blank">
                      预览
                    </Link>
                  </Button>
                  <Button
                    size="sm"
                    variant={course.status === 'published' ? 'secondary' : 'default'}
                    disabled={busyId === course.id}
                    onClick={() => void togglePublish(course)}
                  >
                    {course.status === 'published' ? '下架' : '发布'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={busyId === course.id}
                    onClick={() => void removeCourse(course)}
                  >
                    删除
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
