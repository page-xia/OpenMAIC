'use client';

/**
 * The deployment-wide default model picker (teacher surface only).
 *
 * Only server-managed LLM providers are offered. This value is resolved
 * server-side from server config, so a provider whose key lives only in the
 * teacher's browser would work for the teacher and silently fail for every
 * student — the picker therefore lists exactly the providers the server owns.
 *
 * Choosing an entry writes `serverDefaultModel` ("provider:model") to the
 * settings store. The teacher settings mirror pushes that to the server, and
 * `fetchServerProviders` hands it back to every client as its selected model;
 * `resolveModel` also consults it for server-side stages that never receive an
 * x-model.
 */
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ProviderId } from '@/lib/ai/providers';
import type { ModelInfo } from '@/lib/types/provider';

/**
 * Sentinel for "no deployment default" — the server drops the key and every
 * client falls back to its own provider-order resolution.
 */
export const FOLLOW_SYSTEM_VALUE = '__system__';

interface DefaultModelPickerProps {
  providers: Array<{ id: ProviderId; name: string; models: ModelInfo[] }>;
  /** Current `serverDefaultModel`; empty means "follow system". */
  value: string;
  onChange: (value: string) => void;
  t: (key: string) => string;
}

export function DefaultModelPicker({ providers, value, onChange, t }: DefaultModelPickerProps) {
  const options = providers.flatMap((provider) =>
    (provider.models ?? []).map((model) => ({
      value: `${provider.id}:${model.id}`,
      label: `${provider.name} / ${model.name || model.id}`,
    })),
  );

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-sm font-medium">{t('settings.activeModel')}</Label>
        <p className="mt-1 text-xs text-muted-foreground">{t('settings.activeModelDescription')}</p>
      </div>

      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('settings.noConfiguredProviders')}</p>
      ) : (
        <Select
          value={value || FOLLOW_SYSTEM_VALUE}
          onValueChange={(next) => onChange(next === FOLLOW_SYSTEM_VALUE ? '' : next)}
        >
          <SelectTrigger className="w-full" data-testid="settings-default-model">
            <SelectValue placeholder={t('settings.modelNotConfigured')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FOLLOW_SYSTEM_VALUE}>
              {t('settings.defaultModelFollowSystem')}
            </SelectItem>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <p className="text-xs text-muted-foreground">{t('settings.defaultModelServerHint')}</p>
    </div>
  );
}
