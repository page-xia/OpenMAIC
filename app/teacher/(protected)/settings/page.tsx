'use client';

// Side-effect import MUST stay first: mirrors the (unchanged) settings store
// into the teacher backend's system_settings overlay.
import '@/lib/persistence/teacher-settings-mirror';

import { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SettingsDialog } from '@/components/settings';
import { startTeacherSettingsMirror } from '@/lib/persistence/teacher-settings-mirror';

/**
 * Teacher system settings: the ORIGINAL settings dialog, mounted as-is.
 * Every panel (models, TTS, ASR, image/video, PDF, web search, usage …)
 * works exactly as before — the only difference is where saves land: a
 * mirror projects the store into the server's `system_settings` overlay, so
 * what the teacher configures here serves every student without any client
 * setup. The student surface hides the settings entry entirely.
 */
export default function TeacherSettingsPage() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    startTeacherSettingsMirror();
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">系统设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          与原版设置弹框完全一致；在此配置的模型与语音能力会保存到服务端，学生端零配置即可使用。
        </p>
      </div>
      <div className="flex justify-center py-16">
        <Button size="lg" onClick={() => setOpen(true)}>
          <Settings className="size-4" />
          打开系统设置
        </Button>
      </div>
      <SettingsDialog open={open} onOpenChange={setOpen} surface="teacher" />
    </div>
  );
}
