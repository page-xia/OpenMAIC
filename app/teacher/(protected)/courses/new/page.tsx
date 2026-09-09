'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileText, PackageOpen, Presentation, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

type CreationMode = 'blank' | 'pptx' | 'maic_zip' | 'ai';

const STEP_LABEL: Record<string, string> = {
  initializing: '初始化',
  researching: '检索资料',
  generating_outlines: '生成大纲',
  generating_scenes: '生成课件页面',
  generating_media: '生成配图/视频',
  generating_tts: '生成语音',
  persisting: '保存课件',
  completed: '完成',
};

interface GenerationJobStatus {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  step: string;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
  result?: { classroomId?: string };
  error?: string;
}

export default function NewCoursePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMode = (searchParams.get('mode') as CreationMode) || 'blank';

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [requirement, setRequirement] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // AI generation progress
  const [genProgress, setGenProgress] = useState<GenerationJobStatus | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const gotoCourse = useCallback(
    (courseId: string) => {
      router.push(`/teacher/courses/${courseId}`);
    },
    [router],
  );

  async function createBlank() {
    if (submitting) return;
    if (!title.trim()) {
      toast.error('请填写课件标题');
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch('/api/teacher/courses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim() || undefined, source: 'blank' }),
      });
      const body = (await response.json()) as { success: boolean; course?: { id: string }; error?: string };
      if (!response.ok || !body.success || !body.course) {
        toast.error(body.error ?? '创建失败');
        return;
      }
      toast.success('课件已创建，进入详情页继续编辑');
      gotoCourse(body.course.id);
    } catch {
      toast.error('网络错误，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadImport(kind: 'pptx' | 'maic_zip') {
    if (submitting) return;
    const allowedExts = kind === 'pptx' ? ['.pptx'] : ['.zip'];
    const nameOk =
      !!file && allowedExts.some((ext) => file.name.toLowerCase().endsWith(ext));
    if (!nameOk) {
      toast.error(kind === 'pptx' ? '请选择 .pptx 文件' : '请选择 .maic.zip 课件包');
      return;
    }
    setSubmitting(true);
    const toastId = toast.loading(kind === 'pptx' ? '正在解析 PPTX 并转换为课件…' : '正在解析课件包…');
    try {
      const form = new FormData();
      form.set('file', file);
      if (title.trim()) form.set('title', title.trim());
      const response = await fetch('/api/teacher/courses/import', { method: 'POST', body: form });
      const body = (await response.json()) as {
        success: boolean;
        course?: { id: string };
        courseId?: string;
        error?: string;
      };
      if (!response.ok || !body.success) {
        toast.error(body.error ?? '导入失败', { id: toastId });
        return;
      }
      toast.success('导入成功', { id: toastId });
      gotoCourse(body.course?.id ?? body.courseId ?? '');
    } catch {
      toast.error('网络错误或文件过大', { id: toastId });
    } finally {
      setSubmitting(false);
    }
  }

  const pollJob = useCallback(
    (jobId: string) => {
      const tick = async () => {
        try {
          const response = await fetch(`/api/generate-classroom/${jobId}`);
          const body = (await response.json()) as { success: boolean; jobId?: string } & Partial<GenerationJobStatus>;
          if (!body.success || !body.jobId) {
            setGenProgress(null);
            toast.error('生成任务查询失败');
            return;
          }
          const status = body as GenerationJobStatus;
          setGenProgress(status);
          if (status.status === 'succeeded') {
            const classroomId = status.result?.classroomId;
            if (!classroomId) {
              toast.error('生成完成但缺少课堂 id');
              return;
            }
            const claim = await fetch('/api/teacher/courses/from-classroom', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ classroomId }),
            });
            const claimBody = (await claim.json()) as { success: boolean; course?: { id: string }; error?: string };
            if (!claim.ok || !claimBody.success || !claimBody.course) {
              toast.error(claimBody.error ?? '课件入库失败');
              return;
            }
            toast.success('AI 课件生成完毕，已加入你的课件库');
            gotoCourse(claimBody.course.id);
            return;
          }
          if (status.status === 'failed') {
            toast.error(`生成失败：${status.error ?? status.message ?? '未知错误'}`);
            setGenProgress(null);
            return;
          }
          pollTimer.current = setTimeout(tick, 5000);
        } catch {
          pollTimer.current = setTimeout(tick, 8000);
        }
      };
      pollTimer.current = setTimeout(tick, 2000);
    },
    [gotoCourse],
  );

  async function startGeneration() {
    if (submitting) return;
    if (!requirement.trim()) {
      toast.error('请描述课程主题与要求');
      return;
    }
    setSubmitting(true);
    setGenProgress({ status: 'queued', step: 'initializing', progress: 0, message: '', scenesGenerated: 0 });
    try {
      const response = await fetch('/api/generate-classroom', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requirement: requirement.trim(),
          enableTTS: true,
          agentMode: 'generate',
        }),
      });
      const body = (await response.json()) as { success: boolean; jobId?: string; error?: string };
      if (!response.ok || !body.success || !body.jobId) {
        toast.error(body.error ?? '生成任务创建失败');
        setGenProgress(null);
        return;
      }
      toast.success('生成任务已提交，生成过程约需几分钟');
      pollJob(body.jobId);
    } catch {
      toast.error('网络错误，请重试');
      setGenProgress(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">新建课件</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          选择一种方式创建课件，创建后都可以在编辑器中继续完善。
        </p>
      </div>

      <Tabs defaultValue={initialMode}>
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="blank">
            <FileText className="size-4" />
            空白新建
          </TabsTrigger>
          <TabsTrigger value="pptx">
            <Presentation className="size-4" />
            上传 PPTX
          </TabsTrigger>
          <TabsTrigger value="maic_zip">
            <PackageOpen className="size-4" />
            导入课件包
          </TabsTrigger>
          <TabsTrigger value="ai">
            <Sparkles className="size-4" />
            AI 生成
          </TabsTrigger>
        </TabsList>

        <TabsContent value="blank">
          <Card>
            <CardHeader>
              <CardTitle>空白新建</CardTitle>
              <CardDescription>创建一个包含空白页面的课件，从零开始编辑。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="blank-title">课件标题</Label>
                <Input
                  id="blank-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="例如：高中物理 · 牛顿第一定律"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="blank-desc">课件简介（可选）</Label>
                <Textarea
                  id="blank-desc"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="面向谁、讲什么、达到什么目标"
                  rows={3}
                />
              </div>
              <Button onClick={() => void createBlank()} disabled={submitting}>
                {submitting ? '创建中…' : '创建课件'}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pptx">
          <Card>
            <CardHeader>
              <CardTitle>上传 PPTX 自动转换</CardTitle>
              <CardDescription>
                上传 PowerPoint 文件（≤100MB、≤150 页），自动转换为在线课件，保留版式与图片，转换后可继续编辑。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="pptx-file">PPTX 文件</Label>
                <Input
                  id="pptx-file"
                  type="file"
                  accept=".pptx"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pptx-title">课件标题（可选，默认取文件名）</Label>
                <Input
                  id="pptx-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <Button onClick={() => void uploadImport('pptx')} disabled={submitting}>
                {submitting ? '转换中，可能需要 1-2 分钟…' : '上传并转换'}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="maic_zip">
          <Card>
            <CardHeader>
              <CardTitle>导入 .maic.zip 课件包</CardTitle>
              <CardDescription>
                导入此前导出的课件压缩包，页面、脚本、语音与媒体会整体入库。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="zip-file">课件包文件</Label>
                <Input
                  id="zip-file"
                  type="file"
                  accept=".zip,.maic.zip"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zip-title">课件标题（可选，默认取包内标题）</Label>
                <Input
                  id="zip-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <Button onClick={() => void uploadImport('maic_zip')} disabled={submitting}>
                {submitting ? '导入中…' : '导入课件包'}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ai">
          <Card>
            <CardHeader>
              <CardTitle>AI 一键生成课程</CardTitle>
              <CardDescription>
                描述课程主题与要求，服务端自动生成大纲、课件页面、讲稿与语音（使用系统配置的模型，生成约需几分钟）。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="ai-requirement">课程要求</Label>
                <Textarea
                  id="ai-requirement"
                  value={requirement}
                  onChange={(event) => setRequirement(event.target.value)}
                  placeholder="例如：给初中二年级学生讲一节「光的折射」，45 分钟，包含生活实例、2 道随堂测验和课堂小结"
                  rows={5}
                />
              </div>
              <Button onClick={() => void startGeneration()} disabled={submitting || !!genProgress}>
                {genProgress ? '生成中…' : submitting ? '提交中…' : '开始生成'}
              </Button>
              {genProgress ? (
                <div className="rounded-md border bg-muted/40 px-4 py-3 text-sm">
                  <p className="font-medium">
                    {STEP_LABEL[genProgress.step] ?? genProgress.step} · {genProgress.progress}%
                    {genProgress.totalScenes
                      ? `（${genProgress.scenesGenerated}/${genProgress.totalScenes} 页）`
                      : genProgress.scenesGenerated > 0
                        ? `（已生成 ${genProgress.scenesGenerated} 页）`
                        : ''}
                  </p>
                  {genProgress.message ? (
                    <p className="mt-1 text-xs text-muted-foreground">{genProgress.message}</p>
                  ) : null}
                  <p className="mt-2 text-xs text-muted-foreground">
                    生成完成后会自动入库并跳转到课件详情。此页面可保持打开，也可以稍后在课件列表中查看结果。
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
