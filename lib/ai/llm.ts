/**
 * Unified LLM Call Layer
 *
 * All LLM interactions should go through callLLM / streamLLM.
 */

import { generateText, streamText } from 'ai';
import type { GenerateTextResult, JSONValue, LanguageModel, StreamTextResult } from 'ai';
import { createLogger } from '@/lib/logger';
import { PROVIDERS } from './providers';
import { thinkingContext } from './thinking-context';
import { getModelMetadataKey } from './model-metadata';
import { getCanonicalModelId } from './model-aliases';
import type { ThinkingCapability, ThinkingConfig } from '@/lib/types/provider';
import {
  getThinkingMode,
  pickThinkingBudget,
  pickThinkingEffort,
  pickThinkingLevel,
} from '@/lib/ai/thinking-config';
const log = createLogger('LLM');

// Re-export for external use
export type { ThinkingConfig } from '@/lib/types/provider';

// Re-export the parameter types accepted by AI SDK
type GenerateTextParams = Parameters<typeof generateText>[0];
type StreamTextParams = Parameters<typeof streamText>[0];

function _extractRequestInfo(params: GenerateTextParams | StreamTextParams) {
  const tools = params.tools ? Object.keys(params.tools as Record<string, unknown>) : undefined;

  const p = params as Record<string, unknown>;
  return {
    system: p.system as string | undefined,
    prompt: p.prompt as string | undefined,
    messages: p.messages as unknown[] | undefined,
    tools,
    maxOutputTokens: p.maxOutputTokens as number | undefined,
  };
}

function getModelId(params: GenerateTextParams | StreamTextParams): string {
  const m = params.model;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object' && 'modelId' in m) return (m as { modelId: string }).modelId;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Thinking / Reasoning Adapter
//
// Builds a lookup table from PROVIDERS at module load time, then uses it to
// map a unified ThinkingConfig into provider-specific providerOptions.
// Native providers (OpenAI/Anthropic/Google) are mapped to providerOptions.
// OpenAI-compatible providers are injected by the providers.ts fetch wrapper.
// ---------------------------------------------------------------------------

interface ModelThinkingInfo {
  thinking?: ThinkingCapability;
}

/** Provider/model → thinking capability (built once at module load) */
const MODEL_THINKING_MAP: Map<string, ModelThinkingInfo> = (() => {
  const map = new Map<string, ModelThinkingInfo>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      map.set(getModelMetadataKey(provider.id, model.id), {
        thinking: model.capabilities?.thinking,
      });
    }
  }
  return map;
})();

/** Model ID → thinking capability for IDs that are unique across providers. */
const UNIQUE_MODEL_THINKING_MAP: Map<string, ModelThinkingInfo> = (() => {
  const counts = new Map<string, number>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
    }
  }

  const map = new Map<string, ModelThinkingInfo>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      if (counts.get(model.id) === 1) {
        map.set(model.id, {
          thinking: model.capabilities?.thinking,
        });
      }
    }
  }
  return map;
})();

/** Global thinking override from environment variable */
function getGlobalThinkingConfig(): ThinkingConfig | undefined {
  if (process.env.LLM_THINKING_DISABLED === 'true') {
    return { mode: 'disabled', enabled: false };
  }
  return undefined;
}

type ProviderOptions = Record<string, Record<string, JSONValue | undefined>>;

function getAnthropicEffort(
  thinking: ThinkingCapability,
  config: ThinkingConfig,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  const effort = pickThinkingEffort(thinking, config);
  if (!effort || effort === 'none' || effort === 'minimal') return undefined;
  return effort;
}

function normalizeProviderId(
  provider: string | undefined,
  modelId: string | undefined,
): string | undefined {
  if (!provider) return undefined;
  if (provider === 'anthropic.messages' && modelId?.startsWith('MiniMax-')) return 'minimax';
  if (provider === 'amazon-bedrock') return 'bedrock';
  if (provider in PROVIDERS) return provider;
  const prefix = provider.split('.')[0];
  return prefix in PROVIDERS ? prefix : undefined;
}

function getModelProviderId(params: GenerateTextParams | StreamTextParams): string | undefined {
  const m = params.model;
  if (!m || typeof m !== 'object' || !('provider' in m)) return undefined;
  const provider = (m as { provider?: string }).provider;
  const modelId = 'modelId' in m ? (m as { modelId?: string }).modelId : undefined;
  return normalizeProviderId(provider, modelId);
}

/**
 * Map a unified ThinkingConfig to provider-specific providerOptions.
 */
function buildThinkingProviderOptions(
  providerId: string | undefined,
  modelId: string,
  config: ThinkingConfig,
): ProviderOptions | undefined {
  const lookupModelId = providerId ? getCanonicalModelId(providerId, modelId) : modelId;
  const info = providerId
    ? MODEL_THINKING_MAP.get(getModelMetadataKey(providerId, lookupModelId))
    : UNIQUE_MODEL_THINKING_MAP.get(lookupModelId);
  if (!info?.thinking) return undefined; // model has no thinking capability
  const thinking = info.thinking;
  if (thinking.control === 'none') return undefined;

  const mode = getThinkingMode(config);

  switch (thinking.requestAdapter) {
    case 'openai': {
      const effort = pickThinkingEffort(thinking, config);
      return effort ? { openai: { reasoningEffort: effort } } : undefined;
    }

    case 'anthropic': {
      const buildAnthropicOptions = (
        options: Record<string, JSONValue | undefined>,
      ): ProviderOptions => ({
        anthropic: options,
      });

      if (mode === 'disabled' && thinking.toggleable !== false) {
        return buildAnthropicOptions({ thinking: { type: 'disabled' } });
      }

      if (thinking.control === 'toggle-budget' || thinking.control === 'budget-only') {
        const budget = pickThinkingBudget(thinking, config);
        return budget === undefined
          ? undefined
          : buildAnthropicOptions({ thinking: { type: 'enabled', budgetTokens: budget } });
      }

      const effort = getAnthropicEffort(thinking, config);
      if (!effort) return undefined;

      if (thinking.anthropicThinking?.type === 'adaptive') {
        return buildAnthropicOptions({
          thinking: { type: 'adaptive' },
          effort,
        });
      }

      const manualEffort = effort === 'xhigh' ? 'max' : effort;
      const budget = thinking.anthropicThinking?.budgetByEffort?.[manualEffort];
      if (!budget) return undefined;
      return buildAnthropicOptions({
        thinking: { type: 'enabled', budgetTokens: budget },
        effort: manualEffort,
      });
    }

    case 'google': {
      if (thinking.control === 'level') {
        const level = pickThinkingLevel(thinking, config);
        return level ? { google: { thinkingConfig: { thinkingLevel: level } } } : undefined;
      }

      const budget = pickThinkingBudget(thinking, config);
      if (budget === undefined) return undefined;
      return { google: { thinkingConfig: { thinkingBudget: budget } } };
    }

    default:
      // OpenAI-compatible providers are injected in providers.ts fetch wrapper.
      return undefined;
  }
}

/**
 * Resolve providerOptions the way callLLM / streamLLM resolve them internally.
 *
 * There are no production callers left: every server-side call goes through the
 * wrappers (a lint rule enforces it), and they inject provider options
 * themselves. Kept exported because it is the only way to inspect that mapping
 * from the outside, which the SDK-integration tests do.
 */
export function resolveThinkingProviderOptions(
  model: LanguageModel,
  thinkingConfig?: ThinkingConfig,
): ProviderOptions | undefined {
  if (!thinkingConfig) return undefined;
  if (typeof model !== 'object' || !('modelId' in model)) return undefined;
  const modelId = (model as { modelId?: string }).modelId ?? 'unknown';
  const provider = 'provider' in model ? (model as { provider?: string }).provider : undefined;
  return buildThinkingProviderOptions(
    normalizeProviderId(provider, modelId),
    modelId,
    thinkingConfig,
  );
}

/**
 * Inject provider-specific thinking options into LLM call params.
 *
 * For native providers (OpenAI/Anthropic/Google), this sets providerOptions.
 * For OpenAI-compatible providers, providerOptions won't work (stripped by
 * zod schema) — those are handled by the custom fetch wrapper via thinkingContext.
 *
 * Priority: caller's providerOptions > ThinkingConfig
 */
function injectProviderOptions<T extends GenerateTextParams | StreamTextParams>(
  params: T,
  thinking?: ThinkingConfig,
): T {
  if ((params as Record<string, unknown>).providerOptions) return params; // caller explicitly set providerOptions

  const modelId = getModelId(params);
  const providerId = getModelProviderId(params);

  if (thinking) {
    const opts = buildThinkingProviderOptions(providerId, modelId, thinking);
    if (opts) return { ...params, providerOptions: opts };
  }

  return params;
}

/**
 * Options for LLM call retry on validation failure.
 * This is separate from the AI SDK's built-in maxRetries (which handles network/5xx errors).
 */
export interface LLMRetryOptions {
  /** Max retry attempts when validate() fails or the response is empty (default: 0 = no retry) */
  retries?: number;
  /** Custom validation function. Return true to accept the result, false to retry.
   *  Default: checks that response text is non-empty. */
  validate?: (text: string) => boolean;
}

const DEFAULT_VALIDATE = (text: string) => text.trim().length > 0;

/**
 * Wall-clock ceiling for a single `generateText` attempt (milliseconds).
 *
 * The AI SDK's built-in retry only reacts to *errors*; a provider that accepts
 * the connection and then never sends a byte is not an error, it is a hang, and
 * `await generateText(...)` simply never settles. That is what stranded
 * classroom generation jobs mid-pipeline (progress frozen at a step, neither
 * succeeded nor failed) — the job file stayed `running` until the 30-minute
 * stale sweep. A deadline turns the hang into a TimeoutError, which the retry
 * layer already classifies as retryable.
 *
 * Override with LLM_REQUEST_TIMEOUT_MS; a value of 0 disables the deadline.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

function resolveRequestTimeoutMs(): number | undefined {
  const raw = process.env.LLM_REQUEST_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_REQUEST_TIMEOUT_MS;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed === 0 ? undefined : parsed;
  }
  log.warn(`Ignoring invalid LLM_REQUEST_TIMEOUT_MS="${raw}" (expected milliseconds).`);
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Shape a timed-out attempt so the app-level retry layer retries it.
 * `name: 'TimeoutError'` is what `isRetryableGenerationError` keys on; a bare
 * AbortError would be read as a caller cancellation and never retried.
 */
function buildRequestTimeoutError(source: string, timeoutMs: number, cause: unknown): Error {
  const seconds = Math.round(timeoutMs / 1000);
  const error = new Error(
    `[${source}] Model provider did not respond within ${seconds}s; request aborted.`,
  );
  error.name = 'TimeoutError';
  if (cause instanceof Error) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

/**
 * Build the per-attempt abort signal. `AbortSignal.timeout`/`.any` need a modern
 * runtime (Node >= 20.3); on anything older we simply skip the deadline rather
 * than crash, since a missing deadline is the status quo, not a regression.
 */
function buildAttemptSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (timeoutMs == null || typeof AbortSignal.timeout !== 'function') return callerSignal;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSignal;
  if (typeof AbortSignal.any !== 'function') return timeoutSignal;
  return AbortSignal.any([callerSignal, timeoutSignal]);
}

// ---------------------------------------------------------------------------
// Usage capture
//
// Every server-side LLM call funnels through callLLM/streamLLM, so usage is
// recorded here in one place. Fire-and-forget: failures never affect generation.
// The fs-backed storage is imported dynamically so llm.ts stays safe to bundle
// wherever it's transitively imported.
// ---------------------------------------------------------------------------

function buildUsageMeta(params: GenerateTextParams | StreamTextParams, source: string) {
  const rawModelId = getModelId(params);
  const providerId = getModelProviderId(params) ?? 'unknown';
  const modelId = getCanonicalModelId(providerId, rawModelId);
  return { source, providerId, modelId, modelString: `${providerId}:${modelId}` };
}

/** Record one call's usage. Never throws. */
function recordUsageSafe(
  rawUsage: unknown,
  meta: { source: string; providerId: string; modelId: string; modelString: string },
): void {
  void (async () => {
    try {
      const { normalizeUsage } = await import('@/lib/usage/normalize');
      const { recordUsage } = await import('@/lib/server/usage-storage');
      await recordUsage({
        kind: 'llm',
        source: meta.source,
        providerId: meta.providerId,
        modelId: meta.modelId,
        modelString: meta.modelString,
        usage: normalizeUsage(rawUsage as never),
      });
    } catch (err) {
      log.warn('Usage capture failed (ignored):', err);
    }
  })();
}

/**
 * Unified wrapper around `generateText`.
 *
 * @param params - Same parameters as AI SDK's `generateText`
 * @param source - A short label for log grouping (e.g. 'scene-stream', 'pbl-chat')
 * @param retryOptions - Optional retry-on-validation-failure settings
 * @param thinking - Optional per-call thinking config (overrides global LLM_THINKING_DISABLED)
 */
export async function callLLM<T extends GenerateTextParams>(
  params: T,
  source: string,
  retryOptions?: LLMRetryOptions,
  thinking?: ThinkingConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<GenerateTextResult<any, any>> {
  const maxAttempts = (retryOptions?.retries ?? 0) + 1;
  const validate = retryOptions?.validate ?? (maxAttempts > 1 ? DEFAULT_VALIDATE : undefined);
  const timeoutMs = resolveRequestTimeoutMs();
  const callerSignal = (params as { abortSignal?: AbortSignal }).abortSignal;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastResult: GenerateTextResult<any, any> | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptSignal = buildAttemptSignal(callerSignal, timeoutMs);
    try {
      // Resolve effective thinking config: per-call > global env > undefined
      const effectiveThinking = thinking ?? getGlobalThinkingConfig();
      const injectedParams = injectProviderOptions(params, effectiveThinking);

      // Bound the attempt so a provider that never responds cannot hang the
      // caller forever. `AbortSignal.timeout` is unref'd in Node, so the pending
      // timer never keeps the process alive.
      const attemptParams = attemptSignal
        ? { ...injectedParams, abortSignal: attemptSignal }
        : injectedParams;

      // Wrap in thinkingContext so the custom fetch wrapper in providers.ts
      // can read the config and inject vendor-specific body params for
      // OpenAI-compatible providers.
      const result = await thinkingContext.run(effectiveThinking, () =>
        generateText(attemptParams),
      );

      // Record before validating: every attempt that got this far was billed,
      // including one that fails validation below and one that is handed back
      // after the retries are exhausted. Recording on the success path only
      // would drop both.
      //
      // `usage` is the LAST step only; on a multi-step tool run (`stopWhen`)
      // every earlier step would go unaccounted. `totalUsage` aggregates across
      // steps and equals `usage` for a single-step call. Mirrors streamLLM,
      // which already prefers the aggregate.
      recordUsageSafe(result.totalUsage ?? result.usage, buildUsageMeta(params, source));

      // Validate result (only when retries are configured)
      if (validate && !validate(result.text)) {
        log.warn(
          `[${source}] Validation failed (attempt ${attempt}/${maxAttempts}), ${attempt < maxAttempts ? 'retrying...' : 'giving up'}`,
        );
        lastResult = result;
        continue;
      }

      return result;
    } catch (error) {
      // Our deadline firing is an upstream stall, not a caller cancellation:
      // surface it as a retryable TimeoutError instead of the raw AbortError.
      const timedOut =
        timeoutMs != null &&
        callerSignal?.aborted !== true &&
        attemptSignal?.aborted === true;
      lastError =
        timedOut && timeoutMs != null
          ? buildRequestTimeoutError(source, timeoutMs, error)
          : error;

      if (attempt < maxAttempts) {
        log.warn(`[${source}] Call failed (attempt ${attempt}/${maxAttempts}), retrying...`, error);
        continue;
      }
    }
  }

  // All attempts exhausted — return last result or throw last error
  if (lastResult) return lastResult;
  throw lastError;
}

/**
 * Unified wrapper around `streamText`.
 *
 * Returns the same StreamTextResult.
 *
 * @param params - Same parameters as AI SDK's `streamText`
 * @param source - A short label for log grouping
 * @param thinking - Optional per-call thinking config (overrides global LLM_THINKING_DISABLED)
 */
export function streamLLM<T extends StreamTextParams>(
  params: T,
  source: string,
  thinking?: ThinkingConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): StreamTextResult<any, any> {
  // Resolve effective thinking config and wrap in thinkingContext
  const effectiveThinking = thinking ?? getGlobalThinkingConfig();

  // Wrap onFinish to capture usage when the stream completes, preserving any
  // caller-supplied onFinish. totalUsage aggregates across steps.
  const usageMeta = buildUsageMeta(params, source);
  const callerOnFinish = (params as Record<string, unknown>).onFinish as
    | ((event: { totalUsage?: unknown; usage?: unknown }) => void | Promise<void>)
    | undefined;
  const wrappedParams = {
    ...params,
    onFinish: async (event: { totalUsage?: unknown; usage?: unknown }) => {
      recordUsageSafe(event.totalUsage ?? event.usage, usageMeta);
      if (callerOnFinish) await callerOnFinish(event);
    },
  } as T;

  const injectedParams = injectProviderOptions(wrappedParams, effectiveThinking);
  const result = thinkingContext.run(effectiveThinking, () => streamText(injectedParams));

  return result;
}
