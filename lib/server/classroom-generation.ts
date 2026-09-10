import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
  generateSceneActions,
  generateSceneContent,
  PBLGenerationError,
  withGenerationRetry,
  type AICallFn,
  type AgentInfo,
  type SceneOutline,
} from '@openmaic/generation';
import { createSceneWithActions } from '@/lib/server/scene-generation';
import { generatePBLV2Project } from '@/lib/pbl/v2/agents/planner';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { createLogger } from '@/lib/logger';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import { resolveClassroomWebSearchConfig } from '@/lib/server/web-search-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { getStageModel, type LlmStage } from '@/lib/server/model-routes';
import { getParallelSceneConcurrency } from '@/lib/server/provider-config';
import { lazyBoundedMap } from '@/lib/utils/concurrency';
import type { LanguageModel } from 'ai';
import type { ThinkingConfig } from '@/lib/types/provider';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { buildSearchQuery } from '@/lib/server/search-query-builder';
import { formatSearchResultsAsContext, searchWeb } from '@/lib/web-search';
import type { BaiduSubSources, WebSearchProviderId } from '@/lib/web-search/types';
import { persistClassroom } from '@/lib/server/classroom-storage';
import {
  generateMediaForClassroom,
  replaceMediaPlaceholders,
  generateTTSForClassroom,
} from '@/lib/server/classroom-media-generation';
import { buildVideoManifestFromOutlines } from '@/lib/media/video-manifest';
import type { UserRequirements } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';
import { AGENT_COLOR_PALETTE, AGENT_DEFAULT_AVATARS } from '@/lib/constants/agent-defaults';

const log = createLogger('Classroom');

export function containPBLGenerationError(error: unknown, sceneTitle: string): null {
  if (!(error instanceof PBLGenerationError)) throw error;
  log.warn(`PBL generation failed for scene "${sceneTitle}": ${error.message}`);
  return null;
}

export interface GenerateClassroomInput {
  requirement: string;
  pdfContent?: { text: string; images: string[] };
  enableWebSearch?: boolean;
  webSearchProviderId?: WebSearchProviderId;
  webSearchApiKey?: string;
  webSearchModelId?: string;
  baiduSubSources?: BaiduSubSources;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableTTS?: boolean;
  agentMode?: 'default' | 'generate';
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'researching'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
  | 'generating_tts'
  | 'persisting'
  | 'completed';

export interface ClassroomGenerationProgress {
  step: ClassroomGenerationStep;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
}

export interface GenerateClassroomResult {
  id: string;
  url: string;
  stage: Stage;
  scenes: Scene[];
  scenesCount: number;
  createdAt: string;
}

/**
 * The resumable portion of a classroom generation run: everything produced up
 * to the point a run stopped.
 *
 * Generation spend is dominated by the outline call plus one content + one
 * action call per page, and scene content is the largest of those. Persisting
 * this snapshot after the plan is fixed and after every page completes means a
 * run that dies at page 9 of 11 can be resumed without re-spending a token on
 * the outline, the agents, or pages 1-8.
 *
 * The `input` the run was started with (and the `baseUrl`) live in the
 * checkpoint FILE, not here, so a resume call supplies its own — this type is
 * purely the pipeline's own state.
 */
export interface ClassroomGenerationState {
  languageDirective: string;
  outlines: SceneOutline[];
  agents: AgentInfo[];
  agentMode: 'default' | 'generate';
  /** The stage the run created; its id keeps the classroom id stable across resume. */
  stage: Stage;
  /** Pages completed so far, in store order, with their ids/actions intact. */
  scenes: Scene[];
}

export interface GenerateClassroomOptions {
  baseUrl: string;
  onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
  /**
   * Called after the plan is fixed and after every page completes, with the
   * cumulative state. Consumers persist it so a later resume can skip the work
   * already reflected here.
   */
  onCheckpoint?: (state: ClassroomGenerationState) => Promise<void> | void;
  /** When set, resume from this state instead of starting from scratch. */
  resume?: ClassroomGenerationState;
}

/**
 * True when a value has the shape of a resumable snapshot.
 *
 * A checkpoint is JSON read back from disk, so a truncated/corrupt file would
 * otherwise be trusted as valid and crash deep inside the pipeline with an
 * opaque TypeError. Callers validate instead and fall back to a fresh run.
 */
export function isResumableGenerationState(value: unknown): value is ClassroomGenerationState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<ClassroomGenerationState>;
  return (
    typeof state.languageDirective === 'string' &&
    Array.isArray(state.outlines) &&
    state.outlines.length > 0 &&
    Array.isArray(state.agents) &&
    Array.isArray(state.scenes) &&
    !!state.stage &&
    typeof state.stage === 'object' &&
    typeof (state.stage as { id?: unknown }).id === 'string'
  );
}

function createInMemoryStore(stage: Stage, initialScenes: Scene[] = []): StageStore {
  let state = {
    stage: stage as Stage | null,
    scenes: [...initialScenes],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
  };

  const listeners: Array<(s: typeof state, prev: typeof state) => void> = [];

  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state, prev));
    },
    subscribe: (listener: (s: typeof state, prev: typeof state) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

async function generateAgentProfiles(
  requirement: string,
  languageDirective: string,
  aiCall: AICallFn,
): Promise<AgentInfo[]> {
  const systemPrompt =
    'You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. Return ONLY valid JSON, no markdown or explanation.';

  const userPrompt = `Generate agent profiles for a course with this requirement:
${requirement}

Requirements:
- Decide the appropriate number of agents based on the course content (typically 3-5)
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Each agent needs: name, role, persona (2-3 sentences describing personality and teaching/learning style)
- Language directive for this course: ${languageDirective}
  Agent names and personas must follow this language directive.

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)"
    }
  ]
}`;

  const response = await aiCall(systemPrompt, userPrompt);
  const rawText = stripCodeFences(response);
  const parsed = JSON.parse(rawText) as {
    agents: Array<{ name: string; role: string; persona: string }>;
  };

  if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    throw new Error(`Expected at least 2 agents, got ${parsed.agents?.length ?? 0}`);
  }

  const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
  if (teacherCount !== 1) {
    throw new Error(`Expected exactly 1 teacher, got ${teacherCount}`);
  }

  return parsed.agents.map((a, i) => ({
    id: `gen-server-${i}`,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}

export async function generateClassroom(
  input: GenerateClassroomInput,
  options: GenerateClassroomOptions,
): Promise<GenerateClassroomResult> {
  const { requirement, pdfContent } = input;
  // Validate the snapshot before trusting it: a corrupt checkpoint must degrade
  // to a fresh run, not crash the pipeline reading `.length` off undefined.
  const resume = isResumableGenerationState(options.resume) ? options.resume : undefined;
  if (options.resume && !resume) {
    log.warn('Ignoring a malformed resume checkpoint; starting a fresh run.');
  }

  const pipelineStartedAt = Date.now();
  log.info(resume ? 'Classroom generation resumed' : 'Classroom generation started', {
    ...(resume ? { resumedScenes: resume.scenes.length, totalOutlines: resume.outlines.length } : {}),
    requirementChars: requirement.length,
    hasPdf: !!pdfContent,
    pdfTextChars: pdfContent?.text.length ?? 0,
    pdfImages: pdfContent?.images.length ?? 0,
    webSearch: input.enableWebSearch ?? false,
    imageGen: input.enableImageGeneration ?? false,
    videoGen: input.enableVideoGeneration ?? false,
    tts: input.enableTTS ?? false,
    agentMode: input.agentMode ?? 'default',
  });

  await options.onProgress?.({
    step: 'initializing',
    progress: 5,
    message: 'Initializing classroom generation',
    scenesGenerated: 0,
  });

  const {
    model: languageModel,
    modelInfo,
    modelString,
    providerId,
    apiKey,
    thinkingConfig: classroomThinking,
  } = await resolveModel({ stage: 'generate-classroom' });
  log.info(`Using server-configured model: ${modelString}`);

  // Fail fast if the resolved provider has no API key configured
  if (isProviderKeyRequired(providerId) && !apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set the appropriate key in .env.local or server-providers.yml (e.g. ${providerId.toUpperCase()}_API_KEY).`,
    );
  }

  // The web-search query rewrite is a light, separable stage operators may route
  // to a cheaper model. It defaults to the classroom model and is only
  // re-resolved lazily (inside the web-search branch, and only when a route is
  // configured). This keeps a misconfigured optional route from aborting all
  // classroom generation, and skips the extra resolution when web search is off.
  let searchQueryModel = languageModel;
  let searchQueryThinking = classroomThinking;

  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: modelInfo?.outputWindow,
      },
      'generate-classroom',
      undefined,
      classroomThinking,
    );
    return result.text;
  };

  // Outline generation is the single point of failure for the whole job: every
  // scene depends on it, and it is one long, thinking-heavy call most likely to
  // meet a transient upstream hiccup (429/5xx/"overloaded"). The scene stages
  // already retry; without this an overloaded provider killed the job at ~15%
  // with nothing generated. Retry here (inside the closure) rather than around
  // `generateSceneOutlinesFromRequirements`, because that helper flattens the
  // error into a string and would erase the status code the classifier needs.
  const outlineAiCall: AICallFn = async (systemPrompt, userPrompt, images) => {
    return withGenerationRetry(() => aiCall(systemPrompt, userPrompt, images), {
      label: 'scene outlines',
      onRetry: async (event) => {
        const nextAttempt = Math.min(event.attempt + 1, event.maxAttempts);
        log.warn(`Retrying outline generation (${nextAttempt}/${event.maxAttempts}): ${event.reason}`);
        await options.onProgress?.({
          step: 'generating_outlines',
          progress: 15,
          message: `Retrying outline generation (${nextAttempt}/${event.maxAttempts}): ${event.reason}`,
          scenesGenerated: 0,
        });
      },
    });
  };

  // Per-stage model resolution for the scene pipeline. The classroom used to
  // bind a single `languageModel` (from the `generate-classroom` stage) into one
  // `sceneAiCall` closure shared by scene-content and scene-actions. That made
  // every `MODEL_ROUTES` entry for `scene-content` / `scene-content:<type>` /
  // `scene-actions` a no-op on this path — the browser UI already routes each
  // stage independently via /api/generate/*, but the one-shot skill API did not.
  //
  // Each stage is resolved lazily and only when a route is actually configured
  // (getStageModel returns undefined), so unrouted deployments pay zero extra
  // cost and reuse the classroom model. Resolution failure (e.g. an unknown
  // provider in the route) degrades to the classroom model with a warn, mirroring
  // the existing web-search-query-rewrite handling below — a misconfigured
  // optional route never aborts classroom generation.
  const stageModelCache = new Map<
    LlmStage,
    {
      model: LanguageModel;
      outputWindow?: number;
      thinking: ThinkingConfig | undefined;
    }
  >();

  const resolveStageModel = async (
    stage: LlmStage,
  ): Promise<{
    model: LanguageModel;
    outputWindow?: number;
    thinking: ThinkingConfig | undefined;
  }> => {
    const cached = stageModelCache.get(stage);
    if (cached) return cached;

    // No route configured → reuse the classroom model, no extra resolution.
    if (!getStageModel(stage)) {
      const fallback = {
        model: languageModel,
        outputWindow: modelInfo?.outputWindow,
        thinking: classroomThinking,
      };
      stageModelCache.set(stage, fallback);
      return fallback;
    }

    try {
      const resolved = await resolveModel({ stage });
      const entry = {
        model: resolved.model,
        outputWindow: resolved.modelInfo?.outputWindow,
        thinking: resolved.thinkingConfig,
      };
      log.info(`Stage "${stage}" routed to model: ${resolved.modelString}`);
      stageModelCache.set(stage, entry);
      return entry;
    } catch (err) {
      log.warn(
        `Stage "${stage}" route "${getStageModel(stage)}" could not be resolved; ` +
          `falling back to the generate-classroom model.`,
        err,
      );
      const fallback = {
        model: languageModel,
        outputWindow: modelInfo?.outputWindow,
        thinking: classroomThinking,
      };
      stageModelCache.set(stage, fallback);
      return fallback;
    }
  };

  // scene-content routes per outline type via the composite key
  // `scene-content:<type>` (slide/quiz/interactive/pbl), falling back to the
  // base `scene-content` route — same resolution the browser UI uses at
  // /api/generate/scene-content. Returns the aiCall plus the resolved model
  // and thinking config, because PBL scene generation drives its own LLM
  // calls through the model object (generatePBLSceneContent) rather than the
  // aiCall closure, and consumes the route's thinking config separately.
  const resolveSceneContentCall = async (outlineType?: string) => {
    const stage = (outlineType ? `scene-content:${outlineType}` : 'scene-content') as LlmStage;
    const { model, outputWindow, thinking } = await resolveStageModel(stage);
    const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
      const result = await callLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: outputWindow,
          maxRetries: 0,
        },
        'generate-classroom-scene',
        undefined,
        thinking,
      );
      return result.text;
    };
    return { aiCall, model, thinking };
  };

  // agent-profiles routes via the `agent-profiles` stage (matches the browser
  // UI's /api/generate/agent-profiles). Lazy + cached like the scene stages.
  let agentProfilesAiCall: AICallFn | undefined;
  const getAgentProfilesAiCall = async (): Promise<AICallFn> => {
    if (agentProfilesAiCall) return agentProfilesAiCall;
    const { model, outputWindow, thinking } = await resolveStageModel('agent-profiles');
    agentProfilesAiCall = async (systemPrompt, userPrompt, _images) => {
      const result = await callLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: outputWindow,
        },
        'generate-classroom',
        undefined,
        thinking,
      );
      return result.text;
    };
    return agentProfilesAiCall;
  };

  // scene-actions routes via the `scene-actions` stage.
  let sceneActionsAiCall: AICallFn | undefined;
  const getSceneActionsAiCall = async (): Promise<AICallFn> => {
    if (sceneActionsAiCall) return sceneActionsAiCall;
    const { model, outputWindow, thinking } = await resolveStageModel('scene-actions');
    sceneActionsAiCall = async (systemPrompt, userPrompt, _images) => {
      const result = await callLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: outputWindow,
          maxRetries: 0,
        },
        'generate-classroom-scene',
        undefined,
        thinking,
      );
      return result.text;
    };
    return sceneActionsAiCall;
  };

  const searchQueryAiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: searchQueryModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        maxOutputTokens: 256,
      },
      'web-search-query-rewrite',
      undefined,
      searchQueryThinking,
    );
    return result.text;
  };

  const requirements: UserRequirements = {
    requirement,
  };
  const vocationalActive = resolveVocationalActive(requirements);
  const pdfText = pdfContent?.text || undefined;

  await options.onProgress?.({
    step: 'researching',
    progress: 10,
    message: 'Researching topic',
    scenesGenerated: 0,
  });

  // Web search (optional, graceful degradation)
  let researchContext: string | undefined;
  if (input.enableWebSearch) {
    const webSearchConfig = resolveClassroomWebSearchConfig(input);
    if (webSearchConfig) {
      // Re-resolve the query-rewrite model only when explicitly routed. If
      // resolution itself fails (e.g. unknown provider in the route), fall back
      // to the classroom model here; a route with a missing key resolves fine
      // and surfaces only later in callLLM, which the outer try/catch below
      // degrades gracefully — either way the pipeline still works.
      const rewriteRoute = getStageModel('web-search-query-rewrite');
      if (rewriteRoute) {
        try {
          const rewriteResolved = await resolveModel({ stage: 'web-search-query-rewrite' });
          searchQueryModel = rewriteResolved.model;
          searchQueryThinking = rewriteResolved.thinkingConfig;
        } catch (err) {
          log.warn(
            `web-search-query-rewrite route "${rewriteRoute}" unavailable; using classroom model for query rewrite`,
            err,
          );
        }
      }
      try {
        const searchQuery = await buildSearchQuery(requirement, pdfText, searchQueryAiCall);

        log.info('Running web search for classroom generation', {
          hasPdfContext: searchQuery.hasPdfContext,
          rawRequirementLength: searchQuery.rawRequirementLength,
          rewriteAttempted: searchQuery.rewriteAttempted,
          finalQueryLength: searchQuery.finalQueryLength,
        });

        const searchResult = await searchWeb({
          providerId: webSearchConfig.providerId,
          query: searchQuery.query,
          apiKey: webSearchConfig.apiKey,
          baseUrl: webSearchConfig.baseUrl,
          baiduSubSources: webSearchConfig.baiduSubSources,
          claudeModelId: webSearchConfig.claudeModelId,
        });
        researchContext = formatSearchResultsAsContext(searchResult);
        if (researchContext) {
          log.info(`Web search returned ${searchResult.sources.length} sources`);
        }
      } catch (e) {
        log.warn('Web search failed, continuing without search context:', e);
      }
    } else {
      log.warn('enableWebSearch is true but no web search API key configured, skipping web search');
    }
  }

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 15,
    message: 'Generating scene outlines',
    scenesGenerated: 0,
  });

  // The plan is the expensive, shared spine of the run: languageDirective,
  // outlines, agents, and the stage. On a resume it is taken verbatim from the
  // checkpoint; only the part after it is re-run.
  let languageDirective: string;
  let courseTitle: string | undefined;
  let outlines: SceneOutline[];
  let agents: AgentInfo[];
  let agentMode: 'default' | 'generate';
  let stage: Stage;

  if (resume) {
    ({ languageDirective, outlines, agents, agentMode, stage } = resume);
    courseTitle = stage.name;
    log.info(
      `Resuming: ${resume.scenes.length}/${resume.outlines.length} pages already generated`,
    );
  } else {
    const outlinesResult = await generateSceneOutlinesFromRequirements(
      requirements,
      pdfText,
      undefined,
      outlineAiCall,
      {
        imageGenerationEnabled: input.enableImageGeneration,
        videoGenerationEnabled: input.enableVideoGeneration,
        researchContext,
        // NO teacherContext — agents haven't been generated yet
      },
    );

    if (!outlinesResult.success || !outlinesResult.data) {
      log.error('Failed to generate outlines:', outlinesResult.error);
      throw new Error(outlinesResult.error || 'Failed to generate scene outlines');
    }

    ({ languageDirective, courseTitle, outlines } = outlinesResult.data);
    log.info(
      `Generated ${outlines.length} scene outlines (languageDirective: ${languageDirective}, courseTitle: ${courseTitle ?? 'n/a'})`,
    );

    // Resolve agents based on agentMode — now AFTER outlines so we can use languageDirective
    agentMode = input.agentMode || 'default';
    if (agentMode === 'generate') {
      log.info('Generating custom agent profiles via LLM...');
      try {
        const agentProfilesCall = await getAgentProfilesAiCall();
        agents = await generateAgentProfiles(requirement, languageDirective, agentProfilesCall);
        log.info(`Generated ${agents.length} agent profiles`);
      } catch (e) {
        log.warn('Agent profile generation failed, falling back to defaults:', e);
        agents = getDefaultAgents();
      }
    } else {
      agents = getDefaultAgents();
    }

    stage = {
      id: nanoid(10),
      name: courseTitle || outlines[0]?.title || requirement.slice(0, 50),
      description: undefined,
      languageDirective,
      videoManifest: buildVideoManifestFromOutlines(outlines),
      style: 'interactive',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // For LLM-generated agents, embed full configs so the client can
      // hydrate the agent registry without prior IndexedDB data.
      // For default agents, just record IDs — the client already has them.
      ...(agentMode === 'generate'
        ? {
            generatedAgentConfigs: agents.map((a, i) => ({
              id: a.id,
              name: a.name,
              role: a.role,
              persona: a.persona || '',
              avatar: AGENT_DEFAULT_AVATARS[i % AGENT_DEFAULT_AVATARS.length],
              color: AGENT_COLOR_PALETTE[i % AGENT_COLOR_PALETTE.length],
              priority: a.role === 'teacher' ? 10 : a.role === 'assistant' ? 7 : 5,
            })),
          }
        : {
            agentIds: agents.map((a) => a.id),
          }),
    };
  }

  const stageId = stage.id;

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 30,
    message: `Generated ${outlines.length} scene outlines`,
    scenesGenerated: resume?.scenes.length ?? 0,
    totalScenes: outlines.length,
  });

  // The plan is durable from here on: checkpoint it before the per-page work so
  // a crash this early still resumes without re-running outlines/agents (this
  // first snapshot carries whatever pages a prior run had already produced).
  const checkpoint = async (scenes: Scene[]) => {
    await options.onCheckpoint?.({
      languageDirective,
      outlines,
      agents,
      agentMode,
      stage,
      scenes,
    });
  };
  await checkpoint(resume?.scenes ?? []);

  // Seed the store with any scenes a prior run already produced: scene
  // creation appends, and the loop below skips completed orders, so the final
  // store holds the resumed scenes plus the newly generated remainder in order.
  const store = createInMemoryStore(stage, resume?.scenes ?? []);
  const api = createStageAPI(store);

  log.info('Stage 2: Generating scene content and actions...');
  let generatedScenes = resume?.scenes.length ?? 0;

  // Scene *content* has no cross-scene dependency (each page is generated from
  // its own outline), so it can be fetched ahead of the consumption point. When
  // the operator opts into parallelism, pre-warm content with bounded
  // concurrency but CONSUME the results in order in the loop below — there is no
  // barrier, so the first page still paints after content(1)+actions(1) exactly
  // as in the serial path, while later pages' content generation overlaps the
  // earlier pages' actions. Actions stay strictly serial (they thread
  // previousSpeeches), as does scene creation (it assigns store order).
  //
  // Opt-in and clamped (PARALLEL_SCENE_CONCURRENCY, default 0) because many
  // deployments use API keys with low per-key concurrency quotas, where a
  // bursty default would surface as 429s.
  const parallelConcurrency = getParallelSceneConcurrency();
  const useParallelContent = parallelConcurrency > 1 && outlines.length > 1;

  const generateSceneContentFor = async (index: number, safeOutline: SceneOutline) => {
    const contentCall = await resolveSceneContentCall(safeOutline.type);
    try {
      return await withGenerationRetry(
        () =>
          generateSceneContent(safeOutline, contentCall.aiCall, {
            agents,
            languageDirective,
            allowProceduralSkill: vocationalActive,
            ...(safeOutline.type === 'pbl'
              ? {
                  pblLoopFallback: (input) =>
                    generatePBLV2Project(
                      input,
                      contentCall.model,
                      callLLM,
                      { logger: log },
                      contentCall.thinking,
                    ),
                }
              : {}),
          }),
        {
          label: `scene ${index + 1}/${outlines.length} content`,
          shouldRetryResult: (result) => result === null,
          onRetry: (event) => reportSceneRetryFor(index, safeOutline, 'content', event),
        },
      );
    } catch (error) {
      return containPBLGenerationError(error, safeOutline.title);
    }
  };

  // Retry/progress reporting keyed by outline rather than by loop position: a
  // pre-warmed content fetch that retries while the loop is on an earlier scene
  // must still name its own page, not the loop's current one.
  const reportSceneRetryFor = async (
    index: number,
    safeOutline: SceneOutline,
    phase: 'content' | 'actions',
    event: { attempt: number; maxAttempts: number; reason: string },
  ) => {
    const nextAttempt = Math.min(event.attempt + 1, event.maxAttempts);
    const progressStart = 30 + Math.floor((index / Math.max(outlines.length, 1)) * 60);
    const message = `Retrying scene ${index + 1}/${outlines.length} ${phase} (${nextAttempt}/${event.maxAttempts}): ${safeOutline.title}`;
    log.warn(`${message} — ${event.reason}`);
    await options.onProgress?.({
      step: 'generating_scenes',
      progress: Math.max(progressStart, 31),
      message,
      scenesGenerated: generatedScenes,
      totalScenes: outlines.length,
    });
  };

  // On a resume, pages a prior run already produced are skipped entirely — no
  // content call, no actions call, no tokens. A completed page is identified by
  // its outline order (the resume snapshot preserves the order each scene was
  // created with).
  const completedOrders = new Set((resume?.scenes ?? []).map((scene) => scene.order));
  const pendingOutlines = outlines
    .map((outline, index) => ({ outline, index }))
    .filter(({ outline }) => !completedOrders.has(outline.order));

  // Each pre-warmed entry is settled into a result object rather than left as a
  // bare promise: a rejected fetch whose page is never reached (because an
  // earlier page aborted the loop) would otherwise sit unawaited as an
  // unhandled rejection. Settling here marks the rejection handled, and the
  // consumer re-throws it at exactly the point the serial path would have.
  type SettledContent =
    | { ok: true; value: Awaited<ReturnType<typeof generateSceneContentFor>> }
    | { ok: false; error: unknown };
  const contentPromises: Map<string, Promise<SettledContent>> | null = useParallelContent
    ? new Map(
        lazyBoundedMap(
          pendingOutlines,
          parallelConcurrency,
          async ({ outline, index }): Promise<SettledContent> => {
            const safeOutline = applyOutlineFallbacks(outline, true, {
              allowProceduralSkill: vocationalActive,
            });
            return { ok: true, value: await generateSceneContentFor(index, safeOutline) };
          },
          // Every pending outline is pre-warmed with no early-stop, so the
          // `undefined` the primitive reserves for a skipped item never occurs.
          { shouldContinue: () => true },
        ).map((promise, position) => [
          pendingOutlines[position].outline.id,
          promise.then(
            (settled): SettledContent => settled ?? { ok: true, value: null },
            (error): SettledContent => ({ ok: false, error }),
          ),
        ] as const),
      )
    : null;
  if (contentPromises) {
    log.info(
      `Scene content parallelism enabled: up to ${parallelConcurrency} concurrent fetches across ${pendingOutlines.length} pending pages`,
    );
  }

  for (const [index, outline] of outlines.entries()) {
    if (completedOrders.has(outline.order)) continue;
    const safeOutline = applyOutlineFallbacks(outline, true, {
      allowProceduralSkill: vocationalActive,
    });
    const progressStart = 30 + Math.floor((index / Math.max(outlines.length, 1)) * 60);

    await options.onProgress?.({
      step: 'generating_scenes',
      progress: Math.max(progressStart, 31),
      message: `Generating scene ${index + 1}/${outlines.length}: ${safeOutline.title}`,
      scenesGenerated: generatedScenes,
      totalScenes: outlines.length,
    });

    // Content: consume this page's pre-warmed fetch when parallelism is on
    // (which usually resolved while the previous page's actions ran), or
    // generate it inline on the serial path. Both routes share the same retry
    // and PBL-fallback behavior; a pre-warmed rejection is re-thrown here so it
    // behaves exactly as it would have on the serial path.
    let content: Awaited<ReturnType<typeof generateSceneContentFor>>;
    if (contentPromises) {
      const settled = await contentPromises.get(outline.id);
      if (!settled) content = null;
      else if (settled.ok) content = settled.value;
      else throw settled.error;
    } else {
      content = await generateSceneContentFor(index, safeOutline);
    }
    if (!content) {
      log.warn(`Skipping scene "${safeOutline.title}" — content generation failed`);
      continue;
    }

    const actionsAiCall = await getSceneActionsAiCall();
    const actions = await withGenerationRetry(
      () =>
        generateSceneActions(safeOutline, content, actionsAiCall, {
          agents,
          languageDirective,
        }),
      {
        label: `scene ${index + 1}/${outlines.length} actions`,
        onRetry: (event) => reportSceneRetryFor(index, safeOutline, 'actions', event),
      },
    );
    log.info(`Scene "${safeOutline.title}": ${actions.length} actions`);

    const sceneId = createSceneWithActions(safeOutline, content, actions, api);
    if (!sceneId) {
      log.warn(`Skipping scene "${safeOutline.title}" — scene creation failed`);
      continue;
    }

    generatedScenes += 1;
    // Persist progress after every page: this is the checkpoint a resume reads
    // to skip everything already produced.
    await checkpoint(store.getState().scenes);
    const progressEnd = 30 + Math.floor(((index + 1) / Math.max(outlines.length, 1)) * 60);
    await options.onProgress?.({
      step: 'generating_scenes',
      progress: Math.min(progressEnd, 90),
      message: `Generated ${generatedScenes}/${outlines.length} scenes`,
      scenesGenerated: generatedScenes,
      totalScenes: outlines.length,
    });
  }

  const scenes = store.getState().scenes;
  log.info(`Pipeline complete: ${scenes.length} scenes generated`);

  if (scenes.length === 0) {
    throw new Error('No scenes were generated');
  }

  // Phase: Media generation (after all scenes generated)
  if (input.enableImageGeneration || input.enableVideoGeneration) {
    await options.onProgress?.({
      step: 'generating_media',
      progress: 90,
      message: 'Generating media files',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    try {
      const mediaMap = await generateMediaForClassroom(outlines, stageId, options.baseUrl);
      replaceMediaPlaceholders(scenes, mediaMap);
      log.info(`Media generation complete: ${Object.keys(mediaMap).length} files`);
    } catch (err) {
      log.warn('Media generation phase failed, continuing:', err);
    }
  }

  // Phase: TTS generation
  if (input.enableTTS) {
    await options.onProgress?.({
      step: 'generating_tts',
      progress: 94,
      message: 'Generating TTS audio',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    try {
      await generateTTSForClassroom(scenes, stageId, options.baseUrl);
      log.info('TTS generation complete');
    } catch (err) {
      log.warn('TTS generation phase failed, continuing:', err);
    }
  }

  await options.onProgress?.({
    step: 'persisting',
    progress: 98,
    message: 'Persisting classroom data',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  const persisted = await persistClassroom(
    {
      id: stageId,
      stage,
      scenes,
    },
    options.baseUrl,
  );

  log.info(`Classroom persisted: ${persisted.id}, URL: ${persisted.url}`);

  await options.onProgress?.({
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  log.info(`Classroom generation finished in ${Date.now() - pipelineStartedAt}ms`, {
    classroomId: persisted.id,
    scenes: scenes.length,
    mediaGenerated: input.enableImageGeneration || input.enableVideoGeneration,
    ttsGenerated: !!input.enableTTS,
  });

  return {
    id: persisted.id,
    url: persisted.url,
    stage,
    scenes,
    scenesCount: scenes.length,
    createdAt: persisted.createdAt,
  };
}
