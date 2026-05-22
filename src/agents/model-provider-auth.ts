import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "./agent-scope-config.js";
import {
  externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  listProfilesForProvider,
  type AuthProfileStore,
} from "./auth-profiles.js";
import { hasRuntimeAvailableProviderAuth } from "./model-auth.js";
import { loadModelCatalog } from "./model-catalog.js";
import { normalizeProviderId } from "./model-selection.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

// Prepared runtime fact: which providers have available auth given the
// current cfg + env. Populated explicitly at gateway startup and on config
// reload; consulted by hasAuthForModelProvider so every model-listing call
// (pickers, /models, status commands, CLI) skips the per-provider plugin
// discovery and external-CLI probing on the hot path.

type PreparedProviderAuthState = {
  agentId: string;
  configFingerprint: string;
  providers: ReadonlyMap<string, boolean>;
};

// One entry per configured agent, keyed by agentId. Populated by
// warmCurrentProviderAuthState at gateway startup / on reload; consulted by
// hasAuthForModelProvider on every model-listing call.
let currentProviderAuthStates: ReadonlyMap<string, PreparedProviderAuthState> | null = null;
const configFingerprintCache = new WeakMap<OpenClawConfig, string>();
// Generation counter guards against an in-flight warm publishing stale
// state after a subsequent warm or clear has invalidated it.
let currentProviderAuthStateGeneration = 0;

type WarmCurrentProviderAuthStateOptions = {
  isCancelled?: () => boolean;
  maxDurationMs?: number;
  providerIds?: Iterable<string>;
};

export function clearCurrentProviderAuthState(): void {
  currentProviderAuthStates = null;
  currentProviderAuthStateGeneration += 1;
}

function resolvePreparedStateForCaller(params: {
  states: ReadonlyMap<string, PreparedProviderAuthState> | null;
  cfg: OpenClawConfig | undefined;
  callerAgentId: string | undefined;
}): PreparedProviderAuthState | null {
  if (!params.states) {
    return null;
  }
  if (params.callerAgentId !== undefined) {
    return params.states.get(params.callerAgentId) ?? null;
  }
  // Caller didn't pass agentId: treat as a query against the default agent.
  if (!params.cfg) {
    return null;
  }
  return params.states.get(resolveDefaultAgentId(params.cfg)) ?? null;
}

function resolveProviderAuthConfigFingerprint(cfg: OpenClawConfig | undefined): string | null {
  if (!cfg) {
    return null;
  }
  const cached = configFingerprintCache.get(cfg);
  if (cached !== undefined) {
    return cached;
  }
  const fingerprint = hashRuntimeConfigValue(cfg);
  configFingerprintCache.set(cfg, fingerprint);
  return fingerprint;
}

export async function hasAuthForModelProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  store?: AuthProfileStore;
  allowPluginSyntheticAuth?: boolean;
  discoverExternalCliAuth?: boolean;
}): Promise<boolean> {
  const provider = normalizeProviderId(params.provider);
  // The prepared map is built by warmCurrentProviderAuthState — one entry per
  // configured agent, keyed by agentId. Only consult it when the caller's
  // full auth context matches the warmed scope; otherwise fall through to
  // compute so callers that narrow the scope — e.g. gateway `models.list`
  // with `runtimeAuthDiscovery: false`, or callers with a non-warmed
  // workspaceDir — get the answer they asked for.
  const preparedStates = currentProviderAuthStates;
  const workspaceDir = params.workspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const configFingerprint = resolveProviderAuthConfigFingerprint(params.cfg);
  const preparedState = resolvePreparedStateForCaller({
    states: preparedStates,
    cfg: params.cfg,
    callerAgentId: params.agentId,
  });
  // workspaceDir is a pure function of (cfg, agentId), so we recompute the
  // warmer's expected value at read time rather than storing it. Caller can
  // still override workspaceDir explicitly — that forces a mismatch and
  // falls through to the compute path.
  const expectedWorkspaceDir =
    preparedState !== null && params.cfg
      ? resolveAgentWorkspaceDir(params.cfg, preparedState.agentId)
      : null;
  const matchesWarmedScope =
    preparedState !== null &&
    configFingerprint === preparedState.configFingerprint &&
    workspaceDir === expectedWorkspaceDir &&
    params.discoverExternalCliAuth !== false &&
    params.allowPluginSyntheticAuth !== false &&
    params.env === undefined &&
    params.store === undefined;
  if (matchesWarmedScope) {
    const preparedAnswer = preparedState.providers.get(provider);
    if (preparedAnswer !== undefined) {
      return preparedAnswer;
    }
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (
    hasRuntimeAvailableProviderAuth({
      provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      env: params.env,
      allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
    })
  ) {
    return true;
  }
  const slowPathAgentDir =
    params.agentId && params.cfg ? resolveAgentDir(params.cfg, params.agentId) : undefined;
  const store =
    params.store ??
    (params.discoverExternalCliAuth === false
      ? ensureAuthProfileStoreWithoutExternalProfiles(slowPathAgentDir, {
          allowKeychainPrompt: false,
        })
      : ensureAuthProfileStore(slowPathAgentDir, {
          externalCli: externalCliDiscoveryForProviderAuth({ cfg: params.cfg, provider }),
        }));
  if (listProfilesForProvider(store, provider).length > 0) {
    return true;
  }
  return false;
}

export function createProviderAuthChecker(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  allowPluginSyntheticAuth?: boolean;
  discoverExternalCliAuth?: boolean;
}): (provider: string) => Promise<boolean> {
  const authCache = new Map<string, boolean>();
  return async (provider: string) => {
    const key = normalizeProviderId(provider);
    const cached = authCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = await hasAuthForModelProvider({
      provider: key,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentId: params.agentId,
      env: params.env,
      allowPluginSyntheticAuth: params.allowPluginSyntheticAuth,
      discoverExternalCliAuth: params.discoverExternalCliAuth,
    });
    authCache.set(key, value);
    return value;
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function addProviderId(out: Set<string>, value: string | undefined): void {
  const raw = value?.trim();
  if (!raw) {
    return;
  }
  const normalized = normalizeProviderId(raw);
  if (normalized) {
    out.add(normalized);
  }
}

function addProviderFromModelRef(out: Set<string>, value: string | undefined): void {
  const raw = value?.trim();
  if (!raw) {
    return;
  }
  const slash = raw.indexOf("/");
  if (slash <= 0) {
    return;
  }
  addProviderId(out, raw.slice(0, slash));
}

function addProviderFromModelConfig(
  out: Set<string>,
  model: Parameters<typeof resolveAgentModelPrimaryValue>[0],
): void {
  addProviderFromModelRef(out, resolveAgentModelPrimaryValue(model));
  for (const fallback of resolveAgentModelFallbackValues(model)) {
    addProviderFromModelRef(out, fallback);
  }
}

function addProvidersFromModelMap(out: Set<string>, models: unknown): void {
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    return;
  }
  for (const key of Object.keys(models)) {
    addProviderFromModelRef(out, key);
  }
}

function resolveProviderIdsFromConfig(cfg: OpenClawConfig): string[] {
  const out = new Set<string>();
  for (const id of Object.keys(cfg.models?.providers ?? {})) {
    addProviderId(out, id);
  }
  for (const profile of Object.values(cfg.auth?.profiles ?? {})) {
    addProviderId(out, profile?.provider);
  }
  for (const provider of Object.keys(cfg.auth?.order ?? {})) {
    addProviderId(out, provider);
  }

  const defaults = cfg.agents?.defaults;
  addProviderFromModelConfig(out, defaults?.model);
  addProviderFromModelConfig(out, defaults?.imageModel);
  addProviderFromModelConfig(out, defaults?.imageGenerationModel);
  addProviderFromModelConfig(out, defaults?.videoGenerationModel);
  addProviderFromModelConfig(out, defaults?.musicGenerationModel);
  addProviderFromModelConfig(out, defaults?.pdfModel);
  addProvidersFromModelMap(out, defaults?.models);

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of agents) {
    addProviderFromModelConfig(out, agent?.model);
    addProviderFromModelConfig(out, agent?.subagents?.model);
    addProvidersFromModelMap(out, agent?.models);
  }
  return [...out];
}

function normalizeProviderScope(values: Iterable<string> | undefined): string[] {
  if (!values) {
    return [];
  }
  const out = new Set<string>();
  for (const value of values) {
    addProviderId(out, value);
  }
  return [...out];
}

async function resolveProviderWarmScope(
  cfg: OpenClawConfig,
  options: WarmCurrentProviderAuthStateOptions,
  isStaleOrCancelled: () => boolean,
  isDeadlineExceeded: () => boolean,
): Promise<string[]> {
  const explicitScope = normalizeProviderScope(options.providerIds);
  if (explicitScope.length > 0) {
    return explicitScope;
  }
  const configScope = resolveProviderIdsFromConfig(cfg);
  if (configScope.length > 0) {
    return configScope;
  }
  if (isStaleOrCancelled() || isDeadlineExceeded()) {
    return [];
  }
  const catalog = await loadModelCatalog({ config: cfg });
  if (isStaleOrCancelled() || isDeadlineExceeded()) {
    return [];
  }
  const providers = new Set<string>();
  for (const entry of catalog) {
    addProviderId(providers, entry.provider);
  }
  return [...providers];
}

export async function warmCurrentProviderAuthState(
  cfg: OpenClawConfig,
  options: WarmCurrentProviderAuthStateOptions = {},
): Promise<void> {
  // Claim a fresh generation; any concurrent warm or clear bumps this and
  // turns our published state stale.
  currentProviderAuthStateGeneration += 1;
  const ownGeneration = currentProviderAuthStateGeneration;
  const deadlineAt =
    typeof options.maxDurationMs === "number" &&
    Number.isFinite(options.maxDurationMs) &&
    options.maxDurationMs >= 0
      ? Date.now() + Math.floor(options.maxDurationMs)
      : undefined;
  const isStaleOrCancelled = () =>
    options.isCancelled?.() === true || ownGeneration !== currentProviderAuthStateGeneration;
  const isDeadlineExceeded = () => deadlineAt !== undefined && Date.now() >= deadlineAt;
  if (isStaleOrCancelled()) {
    return;
  }
  const providerList = await resolveProviderWarmScope(
    cfg,
    options,
    isStaleOrCancelled,
    isDeadlineExceeded,
  );
  if (isStaleOrCancelled() || providerList.length === 0) {
    return;
  }
  const configFingerprint = resolveProviderAuthConfigFingerprint(cfg) ?? "";
  const states = new Map<string, PreparedProviderAuthState>();
  // Warm one entry per configured agent so callers hit the prepared map for
  // any agentId. The catalog above is shared across agents; the per-agent
  // work is the auth-discovery sweep against that agent's store.
  for (const agentId of listAgentIds(cfg)) {
    if (isStaleOrCancelled() || isDeadlineExceeded()) {
      return;
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = resolveAgentDir(cfg, agentId);
    await yieldToEventLoop();
    if (isStaleOrCancelled() || isDeadlineExceeded()) {
      return;
    }
    // Keep background warm side-effect-free and non-blocking: external CLI
    // discovery can synchronously stall the gateway long after our warm budget.
    // Hot-path callers still fall through to full discovery for missing entries.
    const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
      allowKeychainPrompt: false,
    });
    const state = new Map<string, boolean>();
    for (const provider of providerList) {
      if (isStaleOrCancelled()) {
        return;
      }
      if (isDeadlineExceeded()) {
        break;
      }
      await yieldToEventLoop();
      if (isStaleOrCancelled() || isDeadlineExceeded()) {
        break;
      }
      const value = await hasAuthForModelProvider({
        provider,
        cfg,
        workspaceDir,
        agentId,
        store,
      });
      if (isStaleOrCancelled()) {
        return;
      }
      state.set(provider, value);
    }
    if (state.size > 0) {
      states.set(agentId, {
        agentId,
        configFingerprint,
        providers: state,
      });
    }
    if (isDeadlineExceeded()) {
      break;
    }
  }
  if (isStaleOrCancelled()) {
    // A newer warm or clear ran while we were building; skip publication so
    // the newer answer wins.
    return;
  }
  currentProviderAuthStates = states;
}
