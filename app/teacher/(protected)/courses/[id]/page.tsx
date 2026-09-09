'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Pencil, Play, Volume2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { GeneratedAgentConfig } from '@openmaic/dsl';

interface CourseInfo {
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
}

const STATUS_LABEL: Record<CourseInfo['status'], string> = {
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

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export default function CourseDetailPage() {
  const params = useParams<{ id: string }>();
  const courseId = params.id;

  const [course, setCourse] = useState<CourseInfo | null>(null);
  const [agents, setAgents] = useState<GeneratedAgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [generatingTts, setGeneratingTts] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/teacher/courses/${courseId}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as {
        success: boolean;
        course?: CourseInfo;
        document?: { stage: { generatedAgentConfigs?: GeneratedAgentConfig[] } };
      };
      if (body.success && body.course) {
        setCourse(body.course);
        setAgents(body.document?.stage.generatedAgentConfigs ?? []);
        setTitle(body.course.title);
        setDescription(body.course.description ?? '');
      } else {
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveMeta() {
    if (saving || !course) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/teacher/courses/${courseId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description }),
      });
      const body = (await response.json()) as { success: boolean; course?: CourseInfo; error?: string };
      if (!response.ok || !body.success) {
        toast.error(body.error ?? '保存失败');
        return;
      }
      toast.success('课件信息已保存');
      if (body.course) setCourse(body.course);
    } catch {
      toast.error('网络错误，请重试');
    } finally {
      setSaving(false);
    }
  }

  async function togglePublish() {
    if (publishing || !course) return;
    setPublishing(true);
    try {
      const response = await fetch(`/api/teacher/courses/${courseId}/publish`, {
        method: course.status === 'published' ? 'DELETE' : 'POST',
      });
      const body = (await response.json()) as { success: boolean; error?: string };
      if (!response.ok || !body.success) {
        toast.error(body.error ?? (course.status === 'published' ? '下架失败' : '发布失败'));
        return;
      }
      toast.success(
        course.status === 'published'
          ? '已下架，学生端不再可见'
          : `发布成功（版本 ${course.publishedVersion + 1}），学生端即可学习`,
      );
      await load();
    } catch {
      toast.error('网络错误，请重试');
    } finally {
      setPublishing(false);
    }
  }

  async function generateTts() {
    if (generatingTts) return;
    if (!window.confirm('为全部讲稿生成语音？使用系统配置的 TTS 服务，可能需要几分钟。')) return;
    setGeneratingTts(true);
    const toastId = toast.loading('正在生成语音，请勿关闭页面…');
    try {
      const response = await fetch(`/api/teacher/courses/${courseId}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: false }),
      });
      const body = (await response.json()) as {
        success: boolean;
        generated?: number;
        skipped?: number;
        failed?: string[];
        error?: string;
      };
      if (!response.ok || !body.success) {
        toast.error(body.error ?? '语音生成失败', { id: toastId, duration: 8000 });
        return;
      }
      const failedCount = body.failed?.length ?? 0;
      toast.success(
        `语音生成完成：新生成 ${body.generated ?? 0} 段、已有 ${body.skipped ?? 0} 段${
          failedCount > 0 ? `、失败 ${failedCount} 段（可重试）` : ''
        }。重新发布后学生端即可点播。`,
        { id: toastId, duration: 8000 },
      );
      await load();
    } catch {
      toast.error('网络错误，请重试', { id: toastId });
    } finally {
      setGeneratingTts(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">加载中…</p>;
  }
  if (loadError || !course) {
    return <p className="text-sm text-destructive">课件不存在或加载失败。</p>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link href="/teacher/courses" className="text-sm text-muted-foreground hover:underline">
            课件管理
          </Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="truncate text-xl font-semibold">{course.title}</h1>
          <Badge variant={course.status === 'published' ? 'default' : 'secondary'}>
            {STATUS_LABEL[course.status]}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link href={`/classroom/${course.id}`} target="_blank">
              <Play className="size-4" />
              预览课堂
            </Link>
          </Button>
          <Button asChild>
            <Link href={`/teacher/courses/${course.id}/edit`}>
              <Pencil className="size-4" />
              编辑课件
            </Link>
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>课件信息</CardTitle>
          <CardDescription>
            {SOURCE_LABEL[course.source] ?? course.source} · {course.sceneCount} 个场景 · 创建于{' '}
            {formatDateTime(course.createdAt)} · 更新于 {formatDateTime(course.updatedAt)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="course-title">标题</Label>
            <Input id="course-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="course-desc">简介</Label>
            <Textarea
              id="course-desc"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              placeholder="课件简介会显示在学生端课程库中"
            />
          </div>
          <Button onClick={() => void saveMeta()} disabled={saving || title.trim() === ''}>
            {saving ? '保存中…' : '保存信息'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>发布管理</CardTitle>
          <CardDescription>
            {course.status === 'published'
              ? `当前已发布版本 v${course.publishedVersion}（${course.publishedAt ? formatDateTime(course.publishedAt) : ''}）。发布后的编辑不会影响学生，直到再次发布新版本。`
              : '发布后学生端课程库即可看到此课件。发布时会冻结当前内容为快照，之后的草稿修改不影响已发布版本。'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant={course.status === 'published' ? 'secondary' : 'default'}
            disabled={publishing}
            onClick={() => void togglePublish()}
          >
            {publishing
              ? '处理中…'
              : course.status === 'published'
                ? '下架（学生端不可见）'
                : '发布到学生端'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>语音预生成</CardTitle>
          <CardDescription>
            为全部讲稿预生成老师语音（使用系统配置的 TTS 服务与 AI 老师的音色配置）。生成后重新发布，学生进入课堂即可直接播放，无需等待实时合成。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" disabled={generatingTts} onClick={() => void generateTts()}>
            <Volume2 className="size-4" />
            {generatingTts ? '生成中，可能需要几分钟…' : '生成全部语音'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AI 老师阵容</CardTitle>
          <CardDescription>
            课件内的虚拟教师团队（含语音配置）。在编辑器中可调整阵容与角色设定。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              尚未配置 AI 老师阵容，学生上课时将使用系统默认角色。
            </p>
          ) : (
            <ul className="space-y-2">
              {agents.map((agent) => (
                <li key={agent.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
                  <span className="text-xl" aria-hidden>
                    {agent.avatar}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {agent.name}
                      <span className="ml-2 text-xs text-muted-foreground">{agent.role}</span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{agent.persona}</p>
                  </div>
                  <span
                    className="size-3 shrink-0 rounded-full border"
                    style={{ backgroundColor: agent.color }}
                    aria-hidden
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
