'use client';

/**
 * Student login / registration. Same card vocabulary as the teacher login
 * page (the system's one auth-page style: centered shadcn Card on a muted
 * backdrop, icon-in-circle, one accent button), with a Register tab that
 * carries the invite-code field. A spent invite refuses with a visible
 * message — codes are one-time by design.
 */
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { GraduationCap } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

function LoginCard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') || '/';
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Login fields
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Register fields
  const [regUsername, setRegUsername] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regDisplayName, setRegDisplayName] = useState('');
  const [inviteCode, setInviteCode] = useState('');

  function safeRedirect(target: string) {
    router.replace(target.startsWith('/') ? target : '/');
    router.refresh();
  }

  async function post(path: string, body: Record<string, string>) {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errBody = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(errBody?.error ?? '操作失败，请稍后重试');
        return;
      }
      safeRedirect(next);
    } catch {
      setError('网络错误，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <GraduationCap className="size-6 text-primary" />
          </div>
          <CardTitle className="text-xl">OpenMAIC 课堂</CardTitle>
          <CardDescription>登录后进入课程学习；没有账号？用邀请码注册</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="login">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login">登录</TabsTrigger>
              <TabsTrigger value="register">注册</TabsTrigger>
            </TabsList>

            <TabsContent value="login">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!submitting) void post('/api/student/auth/login', { username, password });
                }}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <Label htmlFor="login-username">用户名</Label>
                  <Input
                    id="login-username"
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="login-password">密码</Label>
                  <Input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                </div>
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? '登录中…' : '登录'}
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="register">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!submitting) {
                    void post('/api/student/auth/register', {
                      username: regUsername,
                      password: regPassword,
                      ...(regDisplayName.trim() ? { displayName: regDisplayName.trim() } : {}),
                      inviteCode: inviteCode.trim().toUpperCase(),
                    });
                  }
                }}
                className="space-y-4"
              >
                <div className="space-y-2">
                  <Label htmlFor="invite-code">邀请码</Label>
                  <Input
                    id="invite-code"
                    placeholder="例如：7K3M9X2Q"
                    value={inviteCode}
                    onChange={(event) => setInviteCode(event.target.value)}
                    autoComplete="off"
                    className="uppercase"
                    required
                  />
                  <p className="text-xs text-muted-foreground">邀请码由老师提供，注册成功后即失效。</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reg-username">用户名</Label>
                  <Input
                    id="reg-username"
                    autoComplete="username"
                    value={regUsername}
                    onChange={(event) => setRegUsername(event.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reg-display-name">昵称（可选）</Label>
                  <Input
                    id="reg-display-name"
                    value={regDisplayName}
                    onChange={(event) => setRegDisplayName(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reg-password">密码（至少 6 位）</Label>
                  <Input
                    id="reg-password"
                    type="password"
                    autoComplete="new-password"
                    value={regPassword}
                    onChange={(event) => setRegPassword(event.target.value)}
                    required
                  />
                </div>
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? '注册中…' : '注册并登录'}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

export default function StudentLoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-muted/40">
          <p className="text-sm text-muted-foreground">加载中…</p>
        </div>
      }
    >
      <LoginCard />
    </Suspense>
  );
}
