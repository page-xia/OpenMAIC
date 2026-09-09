'use client';

/**
 * Bridge the browser settings store onto the teacher backend's
 * `system_settings` (`server_providers` overlay) so the ORIGINAL SettingsDialog
 * — mounted as-is on the teacher settings page — saves where the server can
 * consume it, instead of only into localStorage.
 *
 * The dialog keeps reading/writing the zustand store untouched. This module
 * subscribes to the store and mirrors a projection of it (LLM / TTS / ASR /
 * PDF / image / video / web-search entries with apiKey / baseUrl / models)
 * into PostgreSQL through `/api/teacher/settings`. The provider-config module
 * layers that overlay over env/yml within its TTL, so a key configured on the
 * teacher page serves every student within seconds.
 */
import { useSettingsStore } from '@/lib/store/settings';

interface OverlayEntry {
  apiKey?: string;
  baseUrl?: string;
  models?: string[];
}

type Overlay = Partial<
  Record<
    'providers' | 'tts' | 'asr' | 'pdf' | 'image' | 'video' | 'web-search',
    Record<string, OverlayEntry>
  >
>;

const LLM_SECTION: Record<string, string> = {
  // The settings store lists built-in LLM providers with display-ish ids;
  // the server provider registry expects these canonical ids. Any id not
  // mapped here passes through unchanged (custom providers).
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  azure: 'azure',
  deepseek: 'deepseek',
  qwen: 'qwen',
  glm: 'glm',
  'openai-compatible': 'openai-compatible',
};

function projectOverlay(): Overlay {
  const s = useSettingsStore.getState();
  const overlay: Overlay = {};

  const providers: Record<string, OverlayEntry> = {};
  for (const [id, cfg] of Object.entries(s.providersConfig ?? {})) {
    // Only entries carrying real operator intent (key / base URL) are pushed.
    // The store also holds the built-in model catalogs for every provider;
    // mirroring those as models-only overlay entries would mark the providers
    // server-managed with an empty key and shadow any client-side key.
    if (!cfg?.apiKey && !cfg?.baseUrl) continue;
    const models = (cfg.models ?? []).map((m) => m.id).filter(Boolean);
    const entry: OverlayEntry = {
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(models.length > 0 ? { models } : {}),
    };
    if (entry.apiKey || entry.baseUrl) {
      providers[LLM_SECTION[id] ?? id] = entry;
    }
  }
  if (Object.keys(providers).length > 0) overlay.providers = providers;

  const projectAudio = (
    config: Record<string, { apiKey?: string; baseUrl?: string; enabled?: boolean }>,
  ): Record<string, OverlayEntry> | undefined => {
    const out: Record<string, OverlayEntry> = {};
    for (const [id, cfg] of Object.entries(config ?? {})) {
      if (!cfg?.apiKey && !cfg?.baseUrl) continue;
      if (cfg.enabled === false) continue;
      out[id] = {
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const tts = projectAudio(s.ttsProvidersConfig);
  if (tts) overlay.tts = tts;
  const asr = projectAudio(s.asrProvidersConfig);
  if (asr) overlay.asr = asr;

  const projectSimple = (
    config: Record<string, { apiKey?: string; baseUrl?: string }>,
  ): Record<string, OverlayEntry> | undefined => {
    const out: Record<string, OverlayEntry> = {};
    for (const [id, cfg] of Object.entries(config ?? {})) {
      if (!cfg?.apiKey && !cfg?.baseUrl) continue;
      out[id] = {
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      };
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const pdf = projectSimple(s.pdfProvidersConfig);
  if (pdf) overlay.pdf = pdf;
  const image = projectSimple(s.imageProvidersConfig);
  if (image) overlay.image = image;
  const video = projectSimple(s.videoProvidersConfig);
  if (video) overlay.video = video;
  const webSearch = projectSimple(s.webSearchProvidersConfig);
  if (webSearch) overlay['web-search'] = webSearch;

  return overlay;
}

let started = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastProjected = '';

/**
 * Start mirroring the settings store into the teacher backend. Debounced (2s)
 * so a batch of dialog edits produces one save; failures retry on the next
 * change rather than blocking the UI. Imported for its side effect from the
 * teacher settings page only.
 *
 * Push rules: the initial sync only fires when something is actually
 * configured locally (a fresh teacher browser must not wipe the server-side
 * config), while any later projection change — including a change back to
 * empty when the teacher clears a key — is pushed as-is.
 */
export function startTeacherSettingsMirror(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  lastProjected = JSON.stringify(projectOverlay());

  const push = async () => {
    const serialized = JSON.stringify(projectOverlay());
    lastProjected = serialized;
    try {
      const response = await fetch('/api/teacher/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: serialized,
      });
      if (!response.ok) {
        lastProjected = ''; // retry on the next change
        console.warn('[teacher-settings] 保存系统设置失败:', response.status);
      }
    } catch {
      lastProjected = '';
    }
  };

  useSettingsStore.subscribe(() => {
    const next = JSON.stringify(projectOverlay());
    if (next === lastProjected) return; // unrelated store change (volume, theme, …)
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void push(), 2000);
  });
  // Initial sync: only when this browser already has something configured.
  if (lastProjected !== '{}') {
    saveTimer = setTimeout(() => void push(), 4000);
  }
}
