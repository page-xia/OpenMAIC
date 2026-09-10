'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ImageUp, Loader2, Pencil, Play, RefreshCw, Volume2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import type { GeneratedAgentConfig } from '@openmaic/dsl';
import type { AppScene } from '@/lib/types/stage';
import {
  firstCoverScene,
  generateAndStoreCourseCover,
  uploadCourseCover,
} from '@/lib/teacher/cover-image';
import { notifyTeacherLibraryChanged } from '@/lib/teacher/library-signal';

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
  /** Public URL of the cover image, or null when the course has none yet. */
  coverUrl: string | null;
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

const MAX_COVER_BYTES = 5 * 1024 * 1024;

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/**
 * The roster avatar as a picture. `GeneratedAgentConfig.avatar` is a path into
 * `public/avatars/` (see AGENT_DEFAULT_AVATARS) — rendering it as text printed
 * the file path at the reader's face. `AvatarDisplay` keeps the legacy glyph
 * form working too (a .maic.zip import may carry an emoji).
 */
function AgentAvatar({ agent }: { agent: GeneratedAgentConfig }) {
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full ring-1 ring-border"
      style={{ backgroundColor: `${agent.color}1a` }}
    >
      {agent.avatar ? (
        <AvatarDisplay src={agent.avatar} alt={agent.name} className="text-lg" />
      ) : (
        <span className="text-sm font-medium" style={{ color: agent.color }}>
          {agent.name.trim().charAt(0) || '师'}
        </span>
      )}
    </span>
  );
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

  // Cover state. `scenesRef` (not state) because the auto-cover job needs the
  // loaded document without making `load` depend on a value it just wrote —
  // that cycle would reload the course on every cover render.
  const scenesRef = useRef<AppScene[]>([]);
  const coverJobRef = useRef<string | null>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverNote, setCoverNote] = useState('');

  /** Rasterize page 1 into the cover slot. The default for a deck with no art. */
  const generateCover = useCallback(async () => {
    setCoverBusy(true);
    setCoverNote('正在用第一页生成封面…');
    const updated = await generateAndStoreCourseCover<CourseInfo>(courseId, scenesRef.current);
    setCoverBusy(false);
    if (updated) {
      setCourse(updated);
      setCoverNote('封面取自课件第一页，可随时上传替换。');
    } else {
      setCoverNote('未能从第一页生成封面（第一页为空或渲染失败），可直接上传一张图片。');
    }
  }, [courseId]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/teacher/courses/${courseId}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as {
        success: boolean;
        course?: CourseInfo;
        document?: {
          stage: { generatedAgentConfigs?: GeneratedAgentConfig[] };
          scenes?: AppScene[];
        };
      };
      if (body.success && body.course) {
        setCourse(body.course);
        setAgents(body.document?.stage.generatedAgentConfigs ?? []);
        scenesRef.current = body.document?.scenes ?? [];
        setTitle(body.course.title);
        setDescription(body.course.description ?? '');
        // A cover is expected, not optional: AI-generated decks carry no image
        // of their own, so the course would show a blank card in the student
        // library. Generate it from page 1 once per visit, best-effort — and
        // skip the attempt entirely when page 1 is still empty, so a freshly
        // created deck neither burns a render nor gets a blank white cover.
        if (!body.course.coverUrl && coverJobRef.current !== body.course.id) {
          coverJobRef.current = body.course.id;
          if (firstCoverScene(scenesRef.current)) {
            void generateCover();
          } else {
            setCoverNote('第一页还没有内容，暂未生成封面；可直接上传一张图片。');
          }
        }
      } else {
        setLoadError(true);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [courseId, generateCover]);

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
      const body = (await response.json()) as {
        success: boolean;
        course?: CourseInfo;
        error?: string;
      };
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

  async function uploadCover(file: File) {
    if (coverBusy) return;
    if (!file.type.startsWith('image/')) {
      toast.error('请选择图片文件（PNG / JPG / WebP）');
      return;
    }
    if (file.size > MAX_COVER_BYTES) {
      toast.error('封面图片不能超过 5 MB');
      return;
    }
    setCoverBusy(true);
    setCoverNote('正在上传封面…');
    const updated = await uploadCourseCover<CourseInfo>(courseId, file, file.name);
    setCoverBusy(false);
    if (updated) {
      setCourse(updated);
      setCoverNote('已使用上传的封面。');
      toast.success('封面已更新');
    } else {
      setCoverNote('封面上传失败，请重试。');
      toast.error('封面上传失败');
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
      notifyTeacherLibraryChanged();
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
            <Input
              id="course-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
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
          <CardTitle>课件封面</CardTitle>
          <CardDescription>
            学生端课程库用它作为卡片背景。默认自动取课件第一页；也可以上传一张图片覆盖。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            ref={coverInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void uploadCover(file);
            }}
          />
          <div className="relative aspect-video w-full max-w-sm overflow-hidden rounded-xl border bg-muted">
            {course.coverUrl ? (
              /* Asset URL, immutable-cached by the asset route. */
              <img
                src={course.coverUrl}
                alt=""
                className="size-full object-cover"
                draggable={false}
              />
            ) : (
              <div className="flex size-full items-center justify-center text-xs text-muted-foreground">
                {coverBusy ? '正在生成封面…' : '暂无封面'}
              </div>
            )}
            {coverBusy && course.coverUrl ? (
              <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={coverBusy}
              onClick={() => coverInputRef.current?.click()}
            >
              <ImageUp className="size-4" />
              上传封面
            </Button>
            <Button variant="ghost" disabled={coverBusy} onClick={() => void generateCover()}>
              <RefreshCw className="size-4" />
              用第一页生成
            </Button>
          </div>
          {coverNote ? <p className="text-xs text-muted-foreground">{coverNote}</p> : null}
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
            为全部讲稿预生成老师语音（使用系统配置的 TTS 服务与 AI
            老师的音色配置）。生成后重新发布，学生进入课堂即可直接播放，无需等待实时合成。
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
                  <AgentAvatar agent={agent} />
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
