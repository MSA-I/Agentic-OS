import "server-only";

export type WorkbenchErrorCategory =
  | "quota"
  | "auth"
  | "timeout"
  | "identity"
  | "containment"
  | "policy"
  | "unsupported"
  | "unavailable"
  | "validation"
  | "unknown";

export class WorkbenchConflictError extends Error {
  readonly code: string;

  constructor(message: string, code = "conflict") {
    super(message);
    this.name = "WorkbenchConflictError";
    this.code = code;
  }
}

export class WorkbenchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbenchNotFoundError";
  }
}

export class WorkbenchUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbenchUnsupportedError";
  }
}

export class WorkbenchPilotError extends Error {
  readonly code: string;
  readonly category: WorkbenchErrorCategory;
  readonly status: number;
  readonly runCreated: boolean;
  readonly retrySafe: boolean;
  readonly nextAction: string;

  constructor(input: {
    message: string;
    code: string;
    category: WorkbenchErrorCategory;
    status: number;
    runCreated?: boolean;
    retrySafe?: boolean;
    nextAction: string;
  }) {
    super(input.message);
    this.name = "WorkbenchPilotError";
    this.code = input.code;
    this.category = input.category;
    this.status = input.status;
    this.runCreated = input.runCreated ?? false;
    this.retrySafe = input.retrySafe ?? false;
    this.nextAction = input.nextAction;
  }
}
