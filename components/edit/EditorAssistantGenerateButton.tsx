'use client';

/**
 * The "AI 一键生成课程" affordance that rides beside the edit CommandBar's
 * title. Rendered only where the editor page provided the assistant context
 * (the teacher course editor) AND the agent runtime probe succeeded — every
 * other chrome host sees nothing.
 *
 * Click → a small popover collecting the course requirement →
 * `openAssistant({ requirement })`, which opens the embedded assistant panel
 * and sends the generate instruction as the conversation's first message.
 */
import { useState } from 'react';
import { Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { useEditorAssistant } from '@/components/edit/editor-assistant-context';
import { useI18n } from '@/lib/hooks/use-i18n';

export function EditorAssistantGenerateButton() {
  const { t } = useI18n();
  const assistant = useEditorAssistant();
  const [open, setOpen] = useState(false);
  const [requirement, setRequirement] = useState('');

  if (!assistant?.runtimeReady) return null;

  const submit = () => {
    const text = requirement.trim();
    if (!text) return;
    setRequirement('');
    setOpen(false);
    assistant.openAssistant({ requirement: text });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="editor-assistant-generate"
          title={t('edit.assistant.assistantGenerateHint')}
          className="ml-2 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-violet-200/70 bg-violet-50/70 px-2.5 text-xs font-semibold text-violet-600 transition-colors hover:bg-violet-100/80 dark:border-violet-400/40 dark:bg-violet-500/10 dark:text-violet-300 dark:hover:bg-violet-500/20"
        >
          <Sparkles className="size-3.5" aria-hidden />
          {t('edit.assistant.assistantGenerate')}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-96">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-sm font-semibold">{t('edit.assistant.assistantGenerate')}</p>
            <p className="text-xs text-muted-foreground">
              {t('edit.assistant.assistantGenerateHint')}
            </p>
          </div>
          <Textarea
            value={requirement}
            onChange={(event) => setRequirement(event.target.value)}
            placeholder={t('edit.assistant.assistantRequirementPlaceholder')}
            rows={4}
            autoFocus
          />
          <div className="flex justify-end">
            <Button size="sm" disabled={requirement.trim() === ''} onClick={submit}>
              {t('edit.assistant.assistantSubmit')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
