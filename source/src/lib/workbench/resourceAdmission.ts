/**
 * Provisional Wave 2 admission limits. They are deliberately explicit so a
 * deployment can replace them after measuring the Wave 0 reference machine.
 */
export interface ResourceBudget {
  cpuTimeMs: number;
  residentMemoryBytes: number;
  diskBytes: number;
  processCount: number;
  outputBytes: number;
}

export interface AdmissionPolicy {
  maxActiveRuns: number;
  maxQueuedRuns: number;
  perRun: Readonly<ResourceBudget>;
  aggregate: Readonly<ResourceBudget>;
}

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

export const DEFAULT_PER_RUN_RESOURCE_BUDGET: Readonly<ResourceBudget> = Object.freeze({
  cpuTimeMs: 30 * 60 * 1_000,
  residentMemoryBytes: GIBIBYTE,
  diskBytes: GIBIBYTE,
  processCount: 16,
  outputBytes: 64 * MEBIBYTE,
});

export const DEFAULT_AGGREGATE_RESOURCE_BUDGET: Readonly<ResourceBudget> = Object.freeze({
  cpuTimeMs: DEFAULT_PER_RUN_RESOURCE_BUDGET.cpuTimeMs * 5,
  residentMemoryBytes: DEFAULT_PER_RUN_RESOURCE_BUDGET.residentMemoryBytes * 5,
  diskBytes: DEFAULT_PER_RUN_RESOURCE_BUDGET.diskBytes * 5,
  processCount: DEFAULT_PER_RUN_RESOURCE_BUDGET.processCount * 5,
  outputBytes: DEFAULT_PER_RUN_RESOURCE_BUDGET.outputBytes * 5,
});

export const DEFAULT_ADMISSION_POLICY: Readonly<AdmissionPolicy> = Object.freeze({
  maxActiveRuns: 5,
  maxQueuedRuns: 100,
  perRun: DEFAULT_PER_RUN_RESOURCE_BUDGET,
  aggregate: DEFAULT_AGGREGATE_RESOURCE_BUDGET,
});

export const DEFAULT_RESOURCE_REQUEST: Readonly<ResourceBudget> = Object.freeze({
  ...DEFAULT_PER_RUN_RESOURCE_BUDGET,
});

export interface AdmissionSnapshot {
  activeRuns: number;
  queuedRuns: number;
  reserved: ResourceBudget;
}

export type ResourceBudgetField = keyof ResourceBudget;

export type AdmissionDecision =
  | { accepted: true }
  | {
      accepted: false;
      code: "invalid_admission_state" | "queue_full" | "active_limit" | "per_run_budget_exceeded" | "aggregate_budget_exceeded";
      detail: string;
      resource?: ResourceBudgetField;
    };

const RESOURCE_FIELDS: readonly ResourceBudgetField[] = [
  "cpuTimeMs",
  "residentMemoryBytes",
  "diskBytes",
  "processCount",
  "outputBytes",
];

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateBudget(budget: ResourceBudget, label: string): AdmissionDecision {
  for (const field of RESOURCE_FIELDS) {
    if (!isNonNegativeSafeInteger(budget[field])) {
      return {
        accepted: false,
        code: "invalid_admission_state",
        detail: `${label}.${field} must be a non-negative safe integer.`,
        resource: field,
      };
    }
  }
  return { accepted: true };
}

function validateInputs(
  snapshot: AdmissionSnapshot,
  request: ResourceBudget,
  policy: Readonly<AdmissionPolicy>,
): AdmissionDecision {
  if (
    !isNonNegativeSafeInteger(snapshot.activeRuns)
    || !isNonNegativeSafeInteger(snapshot.queuedRuns)
    || !isNonNegativeSafeInteger(policy.maxActiveRuns)
    || !isNonNegativeSafeInteger(policy.maxQueuedRuns)
  ) {
    return {
      accepted: false,
      code: "invalid_admission_state",
      detail: "Run counts and admission limits must be non-negative safe integers.",
    };
  }

  for (const [budget, label] of [
    [snapshot.reserved, "snapshot.reserved"],
    [request, "request"],
    [policy.perRun, "policy.perRun"],
    [policy.aggregate, "policy.aggregate"],
  ] as const) {
    const decision = validateBudget(budget, label);
    if (!decision.accepted) return decision;
  }
  return { accepted: true };
}

function checkPerRunBudget(
  request: ResourceBudget,
  policy: Readonly<AdmissionPolicy>,
): AdmissionDecision {
  for (const field of RESOURCE_FIELDS) {
    if (request[field] > policy.perRun[field]) {
      return {
        accepted: false,
        code: "per_run_budget_exceeded",
        detail: `${field} request exceeds the per-run budget.`,
        resource: field,
      };
    }
  }
  return { accepted: true };
}

/** Validate durable enqueue admission. Queued work reserves no runtime budget. */
export function evaluateQueueAdmission(
  snapshot: AdmissionSnapshot,
  request: ResourceBudget,
  policy: Readonly<AdmissionPolicy> = DEFAULT_ADMISSION_POLICY,
): AdmissionDecision {
  const validity = validateInputs(snapshot, request, policy);
  if (!validity.accepted) return validity;
  const perRun = checkPerRunBudget(request, policy);
  if (!perRun.accepted) return perRun;
  if (snapshot.queuedRuns >= policy.maxQueuedRuns) {
    return {
      accepted: false,
      code: "queue_full",
      detail: `Queue limit ${policy.maxQueuedRuns} reached.`,
    };
  }
  return { accepted: true };
}

/**
 * Validate activation. The repository must run this check in the same
 * transaction that claims a command and reserves its resources.
 */
export function evaluateClaimAdmission(
  snapshot: AdmissionSnapshot,
  request: ResourceBudget,
  policy: Readonly<AdmissionPolicy> = DEFAULT_ADMISSION_POLICY,
): AdmissionDecision {
  const queued = evaluateQueueAdmission(
    { ...snapshot, queuedRuns: Math.max(0, snapshot.queuedRuns - 1) },
    request,
    policy,
  );
  if (!queued.accepted && queued.code !== "queue_full") return queued;
  if (snapshot.activeRuns >= policy.maxActiveRuns) {
    return {
      accepted: false,
      code: "active_limit",
      detail: `Active-run limit ${policy.maxActiveRuns} reached.`,
    };
  }
  for (const field of RESOURCE_FIELDS) {
    if (snapshot.reserved[field] + request[field] > policy.aggregate[field]) {
      return {
        accepted: false,
        code: "aggregate_budget_exceeded",
        detail: `${field} reservation would exceed the aggregate budget.`,
        resource: field,
      };
    }
  }
  return { accepted: true };
}
