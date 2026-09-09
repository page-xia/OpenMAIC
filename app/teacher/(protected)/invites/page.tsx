'use client';

/**
 * Student invite-code management: batch-mint one-time codes, browse them with
 * a status filter, copy the fresh batch, and delete unused codes. Used codes
 * are records of who joined (code → student), so they cannot be deleted.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Loader2, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface InviteItem {
  code: string;
  batchId: string | null;
  note: string | null;
  createdAt: number;
  usedByUsername: string | null;
  usedAt: number | null;
}

const STATUS_TABS = [
  { value: 'all', label: '全部' },
  { value: 'unused', label: '未使用' },
  { value: 'used', label: '已使用' },
] as const;

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export default function TeacherInvitesPage() {
  const [invites, setInvites] = useState<InviteItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'unused' | 'used'>('all');
  const [keyword, setKeyword] = useState('');
  const [count, setCount] = useState('10');
  const [note, setNote] = useState('');
  const [minting, setMinting] = useState(false);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [deletingCode, setDeletingCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const response = await fetch('/api/teacher/invites');
      const body = (await response.json()) as { success: boolean; invites?: InviteItem[] };
      if (!response.ok || !body.success) throw new Error(String(response.status));
      setInvites(body.invites ?? []);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function mint() {
    const parsed = Number(count);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
      toast.error('数量需为 1-200');
      return;
    }
    setMinting(true);
    try {
      const response = await fetch('/api/teacher/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count: parsed, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const body = (await response.json()) as { success: boolean; codes?: string[]; error?: string };
      if (!response.ok || !body.success || !body.codes) {
        toast.error(body.error ?? '生成失败');
        return;
      }
      setFreshCodes(body.codes);
      setCopied(false);
      setNote('');
      toast.success(`已生成 ${body.codes.length} 个邀请码`);
      await load();
    } catch {
      toast.error('网络错误，请重试');
    } finally {
      setMinting(false);
    }
  }

  async function remove(code: string) {
    setDeletingCode(code);
    try {
      const response = await fetch(`/api/teacher/invites/${code}`, { method: 'DELETE' });
      const body = (await response.json()) as { success: boolean; error?: string };
      if (!response.ok || !body.success) {
        toast.error(body.error ?? '删除失败');
        return;
      }
      setInvites((current) => current?.filter((item) => item.code !== code) ?? current);
      toast.success('已删除');
    } catch {
      toast.error('网络错误，请重试');
    } finally {
      setDeletingCode(null);
    }
  }

  async function copyAll(codes: string[]) {
    await navigator.clipboard.writeText(codes.join('\n')).catch(() => undefined);
    setCopied(true);
    toast.success('已复制全部邀请码');
    setTimeout(() => setCopied(false), 2000);
  }

  const filtered = useMemo(() => {
    const list = invites ?? [];
    const q = keyword.trim().toLowerCase();
    return list.filter((item) => {
      if (statusFilter === 'unused' && item.usedByUsername) return false;
      if (statusFilter === 'used' && !item.usedByUsername) return false;
      return (
        !q ||
        item.code.toLowerCase().includes(q) ||
        (item.usedByUsername ?? '').toLowerCase().includes(q) ||
        (item.note ?? '').toLowerCase().includes(q)
      );
    });
  }, [invites, statusFilter, keyword]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">邀请码管理</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          学生注册需要邀请码；每个邀请码验证成功后即失效，只能注册一个学生账号。
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="invite-count">生成数量</Label>
              <Input
                id="invite-count"
                type="number"
                min={1}
                max={200}
                value={count}
                onChange={(event) => setCount(event.target.value)}
                className="w-24"
              />
            </div>
            <div className="min-w-48 flex-1 space-y-1.5">
              <Label htmlFor="invite-note">备注（可选）</Label>
              <Input
                id="invite-note"
                placeholder="例如：初二（3）班"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <Button onClick={() => void mint()} disabled={minting}>
              {minting ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              批量生成
            </Button>
          </div>
          {freshCodes ? (
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium">刚生成的 {freshCodes.length} 个邀请码</p>
                <Button variant="outline" size="sm" onClick={() => void copyAll(freshCodes)}>
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                  复制全部
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {freshCodes.map((code) => (
                  <code
                    key={code}
                    className="rounded bg-background px-2 py-1 font-mono text-sm tracking-widest"
                  >
                    {code}
                  </code>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                关闭此页后不再集中展示本次生成的码，请先复制保存。
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}>
          <SelectTrigger className="w-28">
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
        <div className="relative min-w-48 flex-1">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="搜索邀请码 / 学生 / 备注"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </div>
        <Button variant="outline" size="icon" aria-label="刷新" onClick={() => void load()}>
          <RefreshCw className="size-4" />
        </Button>
      </div>

      {loadError ? (
        <p className="py-12 text-center text-sm text-destructive">邀请码加载失败，请刷新重试。</p>
      ) : invites === null ? (
        <p className="py-12 text-center text-sm text-muted-foreground">加载中…</p>
      ) : filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {invites.length === 0 ? '还没有邀请码，先用上方按钮生成一批。' : '没有匹配的邀请码。'}
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((item) => {
            const used = item.usedByUsername !== null;
            return (
              <Card key={item.code}>
                <CardContent className="flex items-center gap-3 py-3">
                  <code className="w-32 shrink-0 font-mono text-sm font-semibold tracking-widest">
                    {item.code}
                  </code>
                  <Badge variant={used ? 'secondary' : 'default'}>
                    {used ? '已使用' : '未使用'}
                  </Badge>
                  <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {used ? (
                      <span>
                        学生 {item.usedByUsername} · 注册于 {formatTime(item.usedAt ?? 0)}
                      </span>
                    ) : (
                      <span className="truncate">
                        生成于 {formatTime(item.createdAt)}
                        {item.note ? ` · ${item.note}` : ''}
                      </span>
                    )}
                  </div>
                  {!used ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`删除邀请码 ${item.code}`}
                      title="删除"
                      disabled={deletingCode === item.code}
                      onClick={() => void remove(item.code)}
                    >
                      {deletingCode === item.code ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4 text-muted-foreground" />
                      )}
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
