'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { BookOpen, FilePlus2, Upload } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface CourseListItem {
  id: string;
  title: string;
  description: string | null;
  status: 'draft' | 'published' | 'archived';
  source: string;
  sceneCount: number;
  updatedAt: number;
  publishedAt: number | null;
}

const STATUS_LABEL: Record<CourseListItem['status'], string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已下架',
};

export default function TeacherDashboardPage() {
  const [courses, setCourses] = useState<CourseListItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/teacher/courses');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { success: boolean; courses?: CourseListItem[] };
        if (!cancelled && body.success) setCourses(body.courses ?? []);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const stats = useMemo(() => {
    const list = courses ?? [];
    return {
      total: list.length,
      draft: list.filter((course) => course.status === 'draft').length,
      published: list.filter((course) => course.status === 'published').length,
    };
  }, [courses]);

  const recent = useMemo(() => {
    const list = [...(courses ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
    return list;
  }, [courses]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">工作台</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          在这里创建课件、编辑课程内容，并发布给学生使用。
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">全部课件</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{stats.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">草稿</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{stats.draft}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">已发布</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{stats.published}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>快捷操作</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/teacher/courses/new">
              <FilePlus2 className="size-4" />
              新建课件
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/teacher/courses/new?mode=pptx">
              <Upload className="size-4" />
              上传 PPTX
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/teacher/courses">
              <BookOpen className="size-4" />
              管理全部课件
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>最近编辑</CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p className="text-sm text-destructive">课件列表加载失败，请确认数据库已启动。</p>
          ) : courses === null ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有课件，从「新建课件」开始吧。</p>
          ) : (
            <ul className="divide-y">
              {recent.map((course) => (
                <li key={course.id} className="flex items-center justify-between py-2.5">
                  <Link
                    href={`/teacher/courses/${course.id}`}
                    className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                  >
                    {course.title}
                  </Link>
                  <div className="ml-4 flex shrink-0 items-center gap-3">
                    <span className="text-xs text-muted-foreground">
                      {course.sceneCount} 个场景
                    </span>
                    <Badge variant={course.status === 'published' ? 'default' : 'secondary'}>
                      {STATUS_LABEL[course.status]}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
