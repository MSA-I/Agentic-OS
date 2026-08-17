import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = process.cwd();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export default undefined" };
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      const candidate = decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:\/)/u, "");
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    if (specifier.startsWith("@/")) {
      const candidate = path.resolve(sourceRoot, "src", specifier.slice(2));
      const target = existsSync(candidate) ? candidate : `${candidate}.ts`;
      if (existsSync(target)) return { shortCircuit: true, url: pathToFileURL(target).href };
    }
    return nextResolve(specifier, context);
  },
});

const { buildProviderChildEnvironment } = await import("../control-plane/childEnvironment.ts");
const { approveLaunchDirectory } = await import("../control-plane/runtimeContainment.ts");
const {
  recoverWindowsJobProcess,
  resolveWindowsJobRecoveryDescriptorPath,
  spawnWindowsJobProcess,
} = await import("../control-plane/windowsJobProcess.ts");
const { DurableWorkbenchWorker, WorkerProcessCrash } = await import("./durableWorker.ts");
const { SqliteDurableWorkerRepository } = await import("./sqliteWorkerRepository.ts");
const { WindowsJobExecutionDriver } = await import("./windowsJobExecutionDriver.ts");

function executableIdentity() {
  const absolutePath = realpathSync.native(process.execPath);
  const file = statSync(absolutePath);
  const sha256 = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  const observedAt = new Date().toISOString();
  return {
    schemaVersion: 2,
    provider: "codex",
    absolutePath,
    launchPath: absolutePath,
    launchArgsPrefix: [],
    version: process.version,
    sha256,
    sizeBytes: file.size,
    modifiedAt: file.mtime.toISOString(),
    observedAt,
    files: [{
      role: "configured",
      absolutePath,
      sha256,
      sizeBytes: file.size,
      modifiedAt: file.mtime.toISOString(),
    }],
  };
}

function appendEvidence(filePath, event) {
  appendFileSync(filePath, `${JSON.stringify({ ...event, observedAt: new Date().toISOString() })}\n`, "utf8");
}

function errorEvidence(error) {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
    ...(error && typeof error === "object" && "failure" in error ? { failure: error.failure } : {}),
  };
}

const configPath = process.argv[2];
if (!configPath) throw new Error("Cross-process crash fixture requires a JSON config path.");
const config = JSON.parse(readFileSync(configPath, "utf8"));
if (!["crash", "recover"].includes(config.mode)) throw new Error("Fixture mode must be crash or recover.");
const recoverySecret = process.env.AGENT_OS_WORKBENCH_RECOVERY_SECRET;
if (typeof recoverySecret !== "string" || recoverySecret.length < 32) {
  throw new Error("Cross-process crash fixture requires a private recovery secret.");
}

const repository = new SqliteDurableWorkerRepository(config.databasePath);
const identityBinding = executableIdentity();
const driver = new WindowsJobExecutionDriver({
  recoveryRepository: repository,
  recoveryRoot: config.recoveryRoot,
  recoverySecret,
  async resolveExecutionSpec() {
    return {
      provider: "codex",
      executableIdentity: identityBinding,
      args: [config.providerScript, config.providerEvidencePath, config.boundary],
      cwd: approveLaunchDirectory("codex", "wave2-driver-test", path.dirname(config.providerScript)),
      env: buildProviderChildEnvironment("codex"),
    };
  },
  async spawnProcess(...args) {
    const controller = await spawnWindowsJobProcess(...args);
    appendEvidence(config.evidencePath, {
      type: "native_spawn",
      fixtureMode: config.mode,
      fixturePid: process.pid,
      boundary: config.boundary,
      identity: controller.identity,
    });
    return controller;
  },
});

async function nativeRecoveryEvidence(context) {
  const descriptorPath = await resolveWindowsJobRecoveryDescriptorPath(
    config.recoveryRoot,
    context.identity.runId,
    context.identity.jobObjectId,
  );
  if (!existsSync(descriptorPath)) return { descriptorPath, exists: false };
  try {
    const recovered = await recoverWindowsJobProcess(descriptorPath, recoverySecret);
    return {
      descriptorPath,
      exists: true,
      identity: recovered.identity,
      status: recovered.status,
    };
  } catch (error) {
    return { descriptorPath, exists: true, error: errorEvidence(error) };
  }
}

const worker = new DurableWorkbenchWorker(repository, driver, {
  workerId: config.workerId,
  leaseDurationMs: 1_000,
  heartbeatIntervalMs: 250,
  now: () => config.now,
  ...(config.mode === "crash"
    ? {
        async crashInjector(current, context) {
          if (current !== config.boundary) return;
          const recovery = await repository.loadExecutionRecovery(context.identity.executionId);
          const native = await nativeRecoveryEvidence(context);
          appendEvidence(config.evidencePath, {
            type: "injected_crash",
            fixturePid: process.pid,
            boundary: current,
            commandId: context.command.id,
            executionId: context.identity.executionId,
            recovery,
            native,
          });
          throw new WorkerProcessCrash(current);
        },
      }
    : {}),
});

try {
  const result = await worker.runOnce();
  const recoveries = await repository.listExecutionRecovery(10);
  appendEvidence(config.evidencePath, {
    type: "worker_result",
    fixtureMode: config.mode,
    fixturePid: process.pid,
    boundary: config.boundary,
    result,
    recoveries,
  });
  repository.close();
  if (config.mode === "crash") {
    process.stderr.write("Crash fixture reached a normal worker result.\n");
    process.exit(87);
  }
  process.stdout.write(`${JSON.stringify({ fixturePid: process.pid, result, recoveries })}\n`);
} catch (error) {
  appendEvidence(config.evidencePath, {
    type: "worker_error",
    fixtureMode: config.mode,
    fixturePid: process.pid,
    boundary: config.boundary,
    error: errorEvidence(error),
  });
  repository.close();
  if (config.mode === "crash" && error instanceof WorkerProcessCrash) {
    process.exit(86);
  }
  process.stderr.write(`${JSON.stringify(errorEvidence(error))}\n`);
  process.exit(88);
}
