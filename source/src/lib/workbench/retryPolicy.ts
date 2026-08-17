export type RetryFailureClass =
  | "transient"
  | "timeout"
  | "rate_limit"
  | "provider_unavailable"
  | "auth"
  | "quota"
  | "policy"
  | "identity"
  | "containment"
  | "invalid_request"
  | "unsupported"
  | "cancelled"
  | "resource_exhausted"
  | "permanent"
  | "unknown";

export interface ExecutionFailure {
  failureClass: RetryFailureClass;
  message: string;
  retryAfterMs?: number;
}

export class DurableExecutionError extends Error {
  readonly failure: ExecutionFailure;

  constructor(failure: ExecutionFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "DurableExecutionError";
    this.failure = failure;
  }
}

export class AttemptTimeoutError extends DurableExecutionError {
  constructor(timeoutMs: number) {
    super({
      failureClass: "timeout",
      message: `Provider attempt exceeded its ${timeoutMs} ms timeout.`,
    });
    this.name = "AttemptTimeoutError";
  }
}

export interface ProviderRetryPolicy {
  maxAttempts: number;
  attemptTimeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  circuitFailureThreshold: number;
  circuitResetMs: number;
  halfOpenMaxAttempts: number;
}

const BASE_POLICY: Readonly<ProviderRetryPolicy> = Object.freeze({
  maxAttempts: 3,
  attemptTimeoutMs: 5 * 60 * 1_000,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
  circuitFailureThreshold: 3,
  circuitResetMs: 60_000,
  halfOpenMaxAttempts: 1,
});

export const DEFAULT_PROVIDER_RETRY_POLICIES: Readonly<Record<string, Readonly<ProviderRetryPolicy>>> = Object.freeze({
  codex: Object.freeze({ ...BASE_POLICY, attemptTimeoutMs: 10 * 60 * 1_000 }),
  claude: Object.freeze({ ...BASE_POLICY, attemptTimeoutMs: 10 * 60 * 1_000 }),
  hermes: Object.freeze({ ...BASE_POLICY, attemptTimeoutMs: 5 * 60 * 1_000 }),
  openclaw: Object.freeze({ ...BASE_POLICY, attemptTimeoutMs: 5 * 60 * 1_000 }),
  antigravity: Object.freeze({ ...BASE_POLICY, maxAttempts: 1 }),
});

export function retryPolicyForProvider(
  provider: string,
  policies: Readonly<Record<string, Readonly<ProviderRetryPolicy>>> = DEFAULT_PROVIDER_RETRY_POLICIES,
): Readonly<ProviderRetryPolicy> {
  return policies[provider] ?? BASE_POLICY;
}

export function classifyExecutionFailure(error: unknown): ExecutionFailure {
  if (error instanceof DurableExecutionError) return error.failure;
  if (error instanceof Error && error.name === "AbortError") {
    return { failureClass: "cancelled", message: "Provider attempt was cancelled." };
  }
  return {
    failureClass: "unknown",
    message: error instanceof Error && error.message ? error.message : "Unknown provider failure.",
  };
}

export function isRetryableFailure(failure: ExecutionFailure): boolean {
  return ["transient", "timeout", "rate_limit", "provider_unavailable"].includes(failure.failureClass);
}

export function failureCountsTowardCircuit(failure: ExecutionFailure): boolean {
  return ["transient", "timeout", "rate_limit", "provider_unavailable"].includes(failure.failureClass);
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number | null;
  reason: "retryable" | "attempt_cap" | "non_retryable";
}

export function retryDecision(
  policy: Readonly<ProviderRetryPolicy>,
  failure: ExecutionFailure,
  attempt: number,
  random: () => number = Math.random,
): RetryDecision {
  if (!isRetryableFailure(failure)) {
    return { retry: false, delayMs: null, reason: "non_retryable" };
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt >= policy.maxAttempts) {
    return { retry: false, delayMs: null, reason: "attempt_cap" };
  }

  const exponent = Math.min(30, attempt - 1);
  const exponentialDelay = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** exponent));
  const retryAfter = Number.isFinite(failure.retryAfterMs) && (failure.retryAfterMs ?? 0) >= 0
    ? Math.min(policy.maxDelayMs, Math.round(failure.retryAfterMs ?? 0))
    : 0;
  const boundedRandom = Math.max(0, Math.min(1, random()));
  const jitterMultiplier = 1 + ((boundedRandom * 2) - 1) * Math.max(0, Math.min(1, policy.jitterRatio));
  const jitteredExponentialDelay = Math.min(
    policy.maxDelayMs,
    Math.max(0, Math.round(exponentialDelay * jitterMultiplier)),
  );
  const delayMs = Math.max(jitteredExponentialDelay, retryAfter);
  return { retry: true, delayMs, reason: "retryable" };
}

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  openUntil: number | null;
  halfOpenAttempts: number;
}

interface MutableCircuitState extends CircuitSnapshot {}

function initialCircuitState(): MutableCircuitState {
  return {
    state: "closed",
    consecutiveFailures: 0,
    openUntil: null,
    halfOpenAttempts: 0,
  };
}

/** In-process policy state. Persist snapshots when circuit state must survive restart. */
export class ProviderCircuitBreaker {
  private readonly states = new Map<string, MutableCircuitState>();
  private readonly policies: Readonly<Record<string, Readonly<ProviderRetryPolicy>>>;

  constructor(policies: Readonly<Record<string, Readonly<ProviderRetryPolicy>>> = DEFAULT_PROVIDER_RETRY_POLICIES) {
    this.policies = policies;
  }

  beforeAttempt(provider: string, nowMs: number): { allowed: true } | { allowed: false; retryAt: number } {
    const state = this.stateFor(provider);
    const policy = retryPolicyForProvider(provider, this.policies);
    if (state.state === "open") {
      if (state.openUntil !== null && nowMs < state.openUntil) {
        return { allowed: false, retryAt: state.openUntil };
      }
      state.state = "half_open";
      state.openUntil = null;
      state.halfOpenAttempts = 0;
    }
    if (state.state === "half_open") {
      if (state.halfOpenAttempts >= policy.halfOpenMaxAttempts) {
        return { allowed: false, retryAt: nowMs + policy.circuitResetMs };
      }
      state.halfOpenAttempts += 1;
    }
    return { allowed: true };
  }

  recordSuccess(provider: string): void {
    this.states.set(provider, initialCircuitState());
  }

  recordFailure(provider: string, failure: ExecutionFailure, nowMs: number): void {
    const state = this.stateFor(provider);
    const policy = retryPolicyForProvider(provider, this.policies);
    if (!failureCountsTowardCircuit(failure)) {
      if (state.state === "half_open") state.halfOpenAttempts = Math.max(0, state.halfOpenAttempts - 1);
      return;
    }
    if (state.state === "half_open") {
      this.open(state, nowMs, policy);
      return;
    }
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= policy.circuitFailureThreshold) this.open(state, nowMs, policy);
  }

  snapshot(provider: string): CircuitSnapshot {
    return { ...this.stateFor(provider) };
  }

  private stateFor(provider: string): MutableCircuitState {
    let state = this.states.get(provider);
    if (!state) {
      state = initialCircuitState();
      this.states.set(provider, state);
    }
    return state;
  }

  private open(state: MutableCircuitState, nowMs: number, policy: Readonly<ProviderRetryPolicy>): void {
    state.state = "open";
    state.openUntil = nowMs + policy.circuitResetMs;
    state.halfOpenAttempts = 0;
  }
}

/**
 * Adds a hard deadline and an AbortSignal. Callers must still terminate and
 * verify the provider process tree before rescheduling a timed-out command.
 */
export async function runWithAttemptTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer.");
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeParentListener: (() => void) | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(new AttemptTimeoutError(timeoutMs));
      reject(new AttemptTimeoutError(timeoutMs));
    }, timeoutMs);
    if (parentSignal) {
      const abort = () => {
        controller.abort(parentSignal.reason);
        reject(new DurableExecutionError({
          failureClass: "cancelled",
          message: "Provider attempt was cancelled.",
        }));
      };
      if (parentSignal.aborted) abort();
      else {
        parentSignal.addEventListener("abort", abort, { once: true });
        removeParentListener = () => parentSignal.removeEventListener("abort", abort);
      }
    }
  });

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    removeParentListener?.();
  }
}
