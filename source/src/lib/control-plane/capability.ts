export const EVIDENCE_LEVELS = [
  "static-contract",
  "fake-runtime",
  "live-runtime",
  "blocked",
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const CAPABILITY_CATEGORIES = [
  "invokable-tool",
  "mcp-server",
  "skill",
  "plugin-app-connector",
  "hook",
  "automation-scheduler-channel",
  "memory-goal-artifact",
  "model-gateway",
] as const;

export type CapabilityCategory = (typeof CAPABILITY_CATEGORIES)[number];

export const CAPABILITY_STAGES = [
  "available",
  "installed",
  "configured",
  "connected",
  "discovered",
  "invokable",
  "verified",
  "restricted",
  "setup-required",
  "unavailable",
] as const;

export type CapabilityStage = (typeof CAPABILITY_STAGES)[number];

export interface VerificationInputs {
  executableHash: string;
  runtimeHash: string;
  configHash: string;
  toolHash: string;
  credentialRevision: string;
  policyHash: string;
  manifestHash: string;
}

export interface CapabilityEvidence {
  level: EvidenceLevel;
  source: string;
  observedAt: string;
  validUntil: string;
  inputs: VerificationInputs;
  blockedReason: string | null;
}

export interface CapabilityStatus {
  id: string;
  category: CapabilityCategory;
  stage: CapabilityStage;
  securityCritical: boolean;
  preExecutionApprovalEnforced: boolean;
  evidence: CapabilityEvidence | null;
}

export type CapabilityVerificationState =
  | "current"
  | "unverified"
  | "stale"
  | "invalidated"
  | "blocked"
  | "restricted"
  | "unavailable";

export interface CapabilityAssessment {
  verification: CapabilityVerificationState;
  invokable: boolean;
  reason: string;
  changedInputs: (keyof VerificationInputs)[];
}

export class CapabilityContractError extends Error {
  readonly code = "invalid_capability_contract";

  constructor(message: string) {
    super(message);
    this.name = "CapabilityContractError";
  }
}

const INPUT_FIELDS = [
  "executableHash",
  "runtimeHash",
  "configHash",
  "toolHash",
  "credentialRevision",
  "policyHash",
  "manifestHash",
] as const satisfies readonly (keyof VerificationInputs)[];

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new CapabilityContractError(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new CapabilityContractError(`${field} is invalid.`);
  }
  return normalized;
}

function canonicalTimestamp(value: unknown, field: string): { iso: string; milliseconds: number } {
  const raw = requiredText(value, field);
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) throw new CapabilityContractError(`${field} is invalid.`);
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

export function createVerificationInputs(input: VerificationInputs): Readonly<VerificationInputs> {
  const normalized = Object.fromEntries(
    INPUT_FIELDS.map((field) => [field, requiredText(input?.[field], field)]),
  ) as unknown as VerificationInputs;
  return Object.freeze(normalized);
}

export function createCapabilityEvidence(input: CapabilityEvidence): Readonly<CapabilityEvidence> {
  if (!EVIDENCE_LEVELS.includes(input.level)) {
    throw new CapabilityContractError("evidence level is invalid.");
  }
  const observed = canonicalTimestamp(input.observedAt, "observedAt");
  const validUntil = canonicalTimestamp(input.validUntil, "validUntil");
  if (validUntil.milliseconds <= observed.milliseconds) {
    throw new CapabilityContractError("validUntil must be later than observedAt.");
  }
  const blockedReason = input.blockedReason === null
    ? null
    : requiredText(input.blockedReason, "blockedReason");
  if (input.level === "blocked" && !blockedReason) {
    throw new CapabilityContractError("blocked evidence requires blockedReason.");
  }
  if (input.level !== "blocked" && blockedReason) {
    throw new CapabilityContractError("Only blocked evidence may contain blockedReason.");
  }

  return Object.freeze({
    level: input.level,
    source: requiredText(input.source, "source"),
    observedAt: observed.iso,
    validUntil: validUntil.iso,
    inputs: createVerificationInputs(input.inputs),
    blockedReason,
  });
}

export function createCapabilityStatus(input: CapabilityStatus): Readonly<CapabilityStatus> {
  if (!CAPABILITY_CATEGORIES.includes(input.category)) {
    throw new CapabilityContractError("capability category is invalid.");
  }
  if (!CAPABILITY_STAGES.includes(input.stage)) {
    throw new CapabilityContractError("capability stage is invalid.");
  }
  return Object.freeze({
    id: requiredText(input.id, "id"),
    category: input.category,
    stage: input.stage,
    securityCritical: input.securityCritical === true,
    preExecutionApprovalEnforced: input.preExecutionApprovalEnforced === true,
    evidence: input.evidence ? createCapabilityEvidence(input.evidence) : null,
  });
}

export function changedVerificationInputs(
  observed: VerificationInputs,
  current: VerificationInputs,
): (keyof VerificationInputs)[] {
  const observedInputs = createVerificationInputs(observed);
  const currentInputs = createVerificationInputs(current);
  return INPUT_FIELDS.filter((field) => observedInputs[field] !== currentInputs[field]);
}

export function assessCapability(
  capability: CapabilityStatus,
  currentInputs: VerificationInputs,
  now = new Date(),
): CapabilityAssessment {
  const normalized = createCapabilityStatus(capability);
  const evidence = normalized.evidence;
  if (normalized.stage === "unavailable" || normalized.stage === "setup-required") {
    return assessment("unavailable", "Capability is not available.");
  }
  if (normalized.stage === "restricted") {
    return assessment("restricted", "Capability is restricted.");
  }
  if (!evidence) {
    return assessment("unverified", "Capability has no verification evidence.");
  }
  if (evidence.level === "blocked") {
    return assessment("blocked", "Capability verification is blocked.");
  }
  if (evidence.level !== "live-runtime") {
    return assessment("unverified", "Only live-runtime evidence can make a capability usable.");
  }

  const changedInputs = changedVerificationInputs(evidence.inputs, currentInputs);
  if (changedInputs.length > 0) {
    return {
      verification: "invalidated",
      invokable: false,
      reason: "Verification inputs changed.",
      changedInputs,
    };
  }
  if (Date.parse(evidence.validUntil) <= now.getTime()) {
    return assessment("stale", "Verification evidence is stale.");
  }
  if (normalized.stage !== "verified") {
    return assessment("unverified", "Capability stage is not verified.");
  }
  if (normalized.category !== "invokable-tool") {
    return assessment("current", "Capability is current but is not an invokable tool.");
  }
  if (!normalized.preExecutionApprovalEnforced) {
    return assessment("restricted", "Pre-execution approval is not enforceable.");
  }
  return {
    verification: "current",
    invokable: true,
    reason: "Live verification is current and pre-execution approval is enforceable.",
    changedInputs: [],
  };
}

function assessment(
  verification: CapabilityVerificationState,
  reason: string,
): CapabilityAssessment {
  return { verification, invokable: false, reason, changedInputs: [] };
}
