import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentProviderAuthState,
  warmCurrentProviderAuthState,
} from "../agents/model-provider-auth.js";
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/run-state.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { getTotalQueueSize } from "../process/command-queue.js";

const STARTUP_PROVIDER_AUTH_WARM_MAX_DURATION_MS = 3_000;
const REWARM_PROVIDER_AUTH_WARM_MAX_DURATION_MS = 5_000;
const ACTIVE_WORK_RETRY_DELAY_MS = 1_000;

type ProviderAuthWarmLog = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

type ProviderAuthWarmReason = "startup" | "auth-profile-failure" | "reload" | "logout" | string;

type ProviderAuthWarmRequest = {
  id: number;
  reason: ProviderAuthWarmReason;
  getConfig: () => OpenClawConfig;
  log: ProviderAuthWarmLog;
  maxDurationMs: number;
  waitForIdle: boolean;
  cancelled: boolean;
};

export type ProviderAuthWarmRequestHandle = {
  cancel: () => void;
};

let nextRequestId = 1;
let warmInFlight: Promise<void> | undefined;
let queuedWarmRequest: ProviderAuthWarmRequest | undefined;
let pendingWarmRequest: ProviderAuthWarmRequest | undefined;
let pendingWarmTimer: ReturnType<typeof setTimeout> | undefined;

function resolveDefaultMaxDurationMs(reason: ProviderAuthWarmReason): number {
  return reason === "startup"
    ? STARTUP_PROVIDER_AUTH_WARM_MAX_DURATION_MS
    : REWARM_PROVIDER_AUTH_WARM_MAX_DURATION_MS;
}

function hasActiveGatewayWork(): boolean {
  return getActiveEmbeddedRunCount() + getTotalPendingReplies() + getTotalQueueSize() > 0;
}

function clearPendingTimer(): void {
  if (pendingWarmTimer) {
    clearTimeout(pendingWarmTimer);
    pendingWarmTimer = undefined;
  }
  pendingWarmRequest = undefined;
}

function formatWarmSuccess(reason: ProviderAuthWarmReason, elapsedMs: number): string {
  return reason === "startup"
    ? `provider auth state pre-warmed in ${elapsedMs}ms`
    : `provider auth state re-warmed (${reason}) in ${elapsedMs}ms`;
}

function formatWarmFailure(reason: ProviderAuthWarmReason, error: unknown): string {
  return reason === "startup"
    ? `provider auth state pre-warm failed: ${String(error)}`
    : `provider auth state rewarm failed: ${String(error)}`;
}

function scheduleWarmAttempt(request: ProviderAuthWarmRequest, delayMs: number): void {
  if (request.cancelled) {
    return;
  }
  if (warmInFlight) {
    queuedWarmRequest = request;
    clearPendingTimer();
    return;
  }
  clearPendingTimer();
  if (delayMs <= 0) {
    runWarmAttempt(request);
    return;
  }
  pendingWarmRequest = request;
  pendingWarmTimer = setTimeout(() => {
    pendingWarmTimer = undefined;
    pendingWarmRequest = undefined;
    runWarmAttempt(request);
  }, delayMs);
  pendingWarmTimer.unref?.();
}

function runWarmAttempt(request: ProviderAuthWarmRequest): void {
  if (request.cancelled) {
    return;
  }
  if (warmInFlight) {
    queuedWarmRequest = request;
    return;
  }
  if (request.waitForIdle && hasActiveGatewayWork()) {
    scheduleWarmAttempt(request, ACTIVE_WORK_RETRY_DELAY_MS);
    return;
  }

  const startMs = Date.now();
  let cfg: OpenClawConfig;
  try {
    cfg = request.getConfig();
  } catch (error) {
    request.log.warn(formatWarmFailure(request.reason, error));
    return;
  }

  warmInFlight = warmCurrentProviderAuthState(cfg, {
    maxDurationMs: request.maxDurationMs,
    isCancelled: () => request.cancelled,
  })
    .then(() => {
      if (!request.cancelled) {
        request.log.info(formatWarmSuccess(request.reason, Date.now() - startMs));
      }
    })
    .catch((error) => {
      request.log.warn(formatWarmFailure(request.reason, error));
    })
    .finally(() => {
      warmInFlight = undefined;
      const next = queuedWarmRequest;
      queuedWarmRequest = undefined;
      if (next && !next.cancelled) {
        runWarmAttempt(next);
      }
    });
}

export function requestProviderAuthStateWarm(params: {
  cfg?: OpenClawConfig;
  getConfig?: () => OpenClawConfig;
  reason: ProviderAuthWarmReason;
  log: ProviderAuthWarmLog;
  delayMs?: number;
  maxDurationMs?: number;
  waitForIdle?: boolean;
}): ProviderAuthWarmRequestHandle {
  const request: ProviderAuthWarmRequest = {
    id: nextRequestId,
    reason: params.reason,
    getConfig: params.getConfig ?? (() => params.cfg as OpenClawConfig),
    log: params.log,
    maxDurationMs: params.maxDurationMs ?? resolveDefaultMaxDurationMs(params.reason),
    waitForIdle: params.waitForIdle ?? true,
    cancelled: false,
  };
  nextRequestId += 1;
  scheduleWarmAttempt(request, Math.max(0, params.delayMs ?? 0));
  return {
    cancel: () => {
      request.cancelled = true;
      if (pendingWarmRequest?.id === request.id) {
        clearPendingTimer();
      }
      if (queuedWarmRequest?.id === request.id) {
        queuedWarmRequest = undefined;
      }
    },
  };
}

export function clearAndRequestProviderAuthStateWarm(
  params: Parameters<typeof requestProviderAuthStateWarm>[0],
): ProviderAuthWarmRequestHandle {
  clearCurrentProviderAuthState();
  return requestProviderAuthStateWarm(params);
}

export const testing = {
  resetProviderAuthStateWarmSchedulerForTest(): void {
    clearPendingTimer();
    queuedWarmRequest = undefined;
    warmInFlight = undefined;
    nextRequestId = 1;
  },
};
