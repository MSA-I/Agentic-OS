import {
  ADAPTER_CAPABILITIES,
  type AgentCapabilities,
  type WorkbenchAdapter,
  type WorkbenchProvider,
} from "./types";

export const WORKBENCH_ADAPTER_API_VERSION = "2.0.0" as const;
export const WORKBENCH_CAPABILITY_SCHEMA_VERSION = 1 as const;

export const REQUIRED_ADAPTER_METHODS = [
  "list",
  "load",
  "start",
  "resume",
  "queue",
  "cancel",
  "approve",
  "artifacts",
] as const;

export interface VersionedAdapterIdentity {
  apiVersion: string;
  capabilitySchemaVersion: number;
  provider: WorkbenchProvider;
}

export class AdapterConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterConformanceError";
  }
}

function fail(message: string): never {
  throw new AdapterConformanceError(message);
}

export function assertAdapterConformance(
  adapter: WorkbenchAdapter,
  identity: VersionedAdapterIdentity,
): void {
  if (identity.apiVersion !== WORKBENCH_ADAPTER_API_VERSION) {
    fail(`Unsupported Workbench adapter API version: ${String(identity.apiVersion)}`);
  }
  if (identity.capabilitySchemaVersion !== WORKBENCH_CAPABILITY_SCHEMA_VERSION) {
    fail(`Unsupported Workbench capability schema version: ${String(identity.capabilitySchemaVersion)}`);
  }
  if (adapter.descriptor.provider !== identity.provider) {
    fail("Adapter identity provider does not match its descriptor.");
  }
  if (adapter.descriptor.id !== identity.provider) {
    fail("Built-in adapter IDs must equal their provider namespace.");
  }

  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== "function") fail(`Adapter is missing method: ${method}`);
  }

  const capabilities = adapter.descriptor.capabilities as unknown;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    fail("Adapter capabilities must be a complete capability map.");
  }
  const capabilityMap = capabilities as Partial<AgentCapabilities> & Record<string, unknown>;
  const capabilityNames = Object.keys(capabilityMap);
  const expectedCapabilityNames = new Set<string>(ADAPTER_CAPABILITIES);
  const unknownCapability = capabilityNames.find((name) => !expectedCapabilityNames.has(name));
  if (unknownCapability) fail(`Adapter declares unknown capability: ${unknownCapability}`);
  for (const name of ADAPTER_CAPABILITIES) {
    if (!Object.prototype.hasOwnProperty.call(capabilityMap, name)) {
      fail(`Adapter is missing capability: ${name}`);
    }
  }
  if (capabilityNames.length !== ADAPTER_CAPABILITIES.length) {
    fail("Adapter capabilities must declare every capability exactly once.");
  }

  for (const name of ADAPTER_CAPABILITIES) {
    const capability = capabilityMap[name];
    if (!capability || typeof capability !== "object" || !("status" in capability)) {
      fail(`Capability ${name} must be supported or include an unsupported reason.`);
    }
    if (capability.status === "supported") continue;
    if (
      capability.status !== "unsupported"
      || typeof capability.reason !== "string"
      || !capability.reason.trim()
    ) {
      fail(`Capability ${name} must be supported or include an unsupported reason.`);
    }
  }
}
