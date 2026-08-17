import type { ControlPlaneIdentity } from "./identity";

export const POLICY_OPERATIONS = [
  "start",
  "resume",
  "steer",
  "cancel",
  "tool.invoke",
  "approval.resolve",
  "artifact.persist",
] as const;

export type PolicyOperation = (typeof POLICY_OPERATIONS)[number];
export type PolicyEffect = "allow" | "deny";

export interface ExecutionGuardState {
  identityVerified: boolean;
  containmentVerified: boolean;
  secretControlsVerified: boolean;
  approvalEnforced: boolean;
  executableVerified: boolean;
  capabilityVerified: boolean;
}

export interface PolicyContext {
  operation: PolicyOperation;
  identity: ControlPlaneIdentity;
  guards: ExecutionGuardState;
  risk: "low" | "medium" | "high" | "critical";
  toolId?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface PolicyRule {
  id: string;
  effect: PolicyEffect;
  operations?: readonly PolicyOperation[];
  matches(context: Readonly<PolicyContext>): boolean;
}

export type PolicyDecisionCode =
  | "allowed"
  | "default_deny"
  | "explicit_deny"
  | "guard_missing"
  | "invalid_identity"
  | "invalid_operation"
  | "policy_error";

export interface PolicyDecision {
  allowed: boolean;
  code: PolicyDecisionCode;
  reason: string;
  matchedRuleIds: string[];
  missingGuards: (keyof ExecutionGuardState)[];
}

const POLICY_PROVIDERS = new Set(["codex", "claude", "hermes", "openclaw", "antigravity"]);
const FULL_EXECUTION_GUARDS: readonly (keyof ExecutionGuardState)[] = [
  "identityVerified",
  "containmentVerified",
  "secretControlsVerified",
  "approvalEnforced",
  "executableVerified",
  "capabilityVerified",
];
const REQUIRED_GUARDS_BY_OPERATION: Readonly<Record<PolicyOperation, readonly (keyof ExecutionGuardState)[]>> = {
  start: FULL_EXECUTION_GUARDS,
  resume: FULL_EXECUTION_GUARDS,
  steer: FULL_EXECUTION_GUARDS,
  "tool.invoke": FULL_EXECUTION_GUARDS,
  cancel: ["identityVerified"],
  "approval.resolve": ["identityVerified", "secretControlsVerified", "approvalEnforced"],
  "artifact.persist": ["identityVerified", "secretControlsVerified"],
};

function validRuleId(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value);
}

function validIdentityText(value: unknown): value is string {
  return typeof value === "string"
    && value === value.trim()
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validPolicyIdentity(value: unknown): value is ControlPlaneIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Partial<ControlPlaneIdentity>;
  return validIdentityText(identity.callerSessionId)
    && validIdentityText(identity.actorId)
    && validIdentityText(identity.projectId)
    && validIdentityText(identity.worktreeId)
    && validIdentityText(identity.runId)
    && typeof identity.provider === "string"
    && POLICY_PROVIDERS.has(identity.provider)
    && (identity.profileId === null || validIdentityText(identity.profileId))
    && (identity.nativeSessionId === null || validIdentityText(identity.nativeSessionId));
}

export class FailClosedPolicyEngine {
  private readonly rules: readonly PolicyRule[];

  constructor(rules: readonly PolicyRule[] = []) {
    const seen = new Set<string>();
    const normalized: PolicyRule[] = [];
    for (const rule of rules) {
      if (!validRuleId(rule.id)) throw new Error("Policy rule id is invalid.");
      if (seen.has(rule.id)) throw new Error(`Duplicate policy rule id: ${rule.id}.`);
      if (rule.effect !== "allow" && rule.effect !== "deny") {
        throw new Error(`Policy rule ${rule.id} has an invalid effect.`);
      }
      if (typeof rule.matches !== "function") {
        throw new Error(`Policy rule ${rule.id} has no matcher.`);
      }
      if (rule.operations?.some((operation) => !POLICY_OPERATIONS.includes(operation))) {
        throw new Error(`Policy rule ${rule.id} has an invalid operation.`);
      }
      seen.add(rule.id);
      normalized.push(Object.freeze({
        id: rule.id,
        effect: rule.effect,
        operations: rule.operations ? Object.freeze([...rule.operations]) : undefined,
        matches: rule.matches,
      }));
    }
    this.rules = Object.freeze(normalized);
  }

  decide(context: Readonly<PolicyContext> | unknown): PolicyDecision {
    try {
      return this.evaluate(context);
    } catch {
      return this.deny("policy_error", "Policy evaluation failed closed.");
    }
  }

  private evaluate(context: Readonly<PolicyContext> | unknown): PolicyDecision {
    if (!context || typeof context !== "object") {
      return this.deny("invalid_identity", "Operation identity is invalid.");
    }
    const policyContext = context as Readonly<PolicyContext>;
    if (!POLICY_OPERATIONS.includes(policyContext.operation)) {
      return this.deny("invalid_operation", "Operation is not recognized.");
    }

    if (!validPolicyIdentity(policyContext.identity)) {
      return this.deny("invalid_identity", "Operation identity is invalid.");
    }

    const missingGuards = REQUIRED_GUARDS_BY_OPERATION[policyContext.operation].filter(
      (guard) => policyContext.guards?.[guard] !== true,
    );
    if (missingGuards.length > 0) {
      return {
        allowed: false,
        code: "guard_missing",
        reason: "Required operation guards are not verified.",
        matchedRuleIds: [],
        missingGuards,
      };
    }

    const matching: PolicyRule[] = [];
    try {
      for (const rule of this.rules) {
        if (rule.operations && !rule.operations.includes(policyContext.operation)) continue;
        if (rule.matches(policyContext)) matching.push(rule);
      }
    } catch {
      return this.deny("policy_error", "Policy evaluation failed closed.");
    }

    const matchedRuleIds = matching.map((rule) => rule.id).sort();
    if (matching.some((rule) => rule.effect === "deny")) {
      return {
        allowed: false,
        code: "explicit_deny",
        reason: "A policy rule denied the operation.",
        matchedRuleIds,
        missingGuards: [],
      };
    }
    if (matching.some((rule) => rule.effect === "allow")) {
      return {
        allowed: true,
        code: "allowed",
        reason: "Policy allowed the operation.",
        matchedRuleIds,
        missingGuards: [],
      };
    }

    return this.deny("default_deny", "No policy rule allowed the operation.");
  }

  private deny(code: PolicyDecisionCode, reason: string): PolicyDecision {
    return { allowed: false, code, reason, matchedRuleIds: [], missingGuards: [] };
  }
}
