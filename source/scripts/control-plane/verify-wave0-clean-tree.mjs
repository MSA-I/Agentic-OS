#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(scriptDirectory, "..", "..");
const repoRoot = resolve(sourceRoot, "..");
const scratchRoot = resolve(repoRoot, ".tmp");
const routePath = "source/src/app/api/workbench/agents/[id]/sessions/route.ts";
const evidencePath = resolve(
  sourceRoot,
  "docs",
  "control-plane",
  "WAVE-0-CLEAN-TREE-GATE.json",
);
const prospectivePaths = [
  ".gitignore",
  routePath,
  "source/AGENTS.md",
  "source/package.json",
  "source/docs/control-plane",
  "source/scripts/control-plane",
  "source/scripts/verify-workbench-route-distribution.mjs",
];

function command(binary, args, options = {}) {
  const startedAt = performance.now();
  const result = spawnSync(binary, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${binary} ${args.join(" ")} failed after ${durationMs}ms\n${detail}`,
    );
  }
  return {
    durationMs,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function assertInsideScratch(candidate) {
  const resolvedCandidate = resolve(candidate);
  if (!resolvedCandidate.startsWith(`${scratchRoot}${sep}`)) {
    throw new Error(`Refusing scratch operation outside ${scratchRoot}`);
  }
  return resolvedCandidate;
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeEvidence(evidence) {
  mkdirSync(dirname(evidencePath), { recursive: true });
  const temporaryPath = `${evidencePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
  });
  await rename(temporaryPath, evidencePath);
}

if (!existsSync(resolve(repoRoot, routePath))) {
  throw new Error(`Required route is missing: ${routePath}`);
}

mkdirSync(scratchRoot, { recursive: true });
const scratchDirectory = assertInsideScratch(
  mkdtempSync(join(scratchRoot, "wave0-clean-tree-")),
);
const temporaryIndex = join(scratchDirectory, "index");
const archivePath = join(scratchDirectory, "prospective-tree.tar");
const checkoutRoot = join(scratchDirectory, "checkout");
const isolatedSourceRoot = join(checkoutRoot, "source");
const runtimeRoot = join(scratchDirectory, "runtime-data");
const temporaryEnvironment = {
  ...process.env,
  GIT_INDEX_FILE: temporaryIndex,
};
const npmCliPath = process.env.npm_execpath;
if (!npmCliPath || !existsSync(npmCliPath)) {
  throw new Error(
    "npm CLI path is unavailable. Run this gate through `npm run verify:wave0-clean-tree`.",
  );
}
const npmCommand = (args, options) =>
  command(process.execPath, [npmCliPath, ...args], options);

try {
  command("git", ["read-tree", "HEAD"], { env: temporaryEnvironment });
  command("git", ["add", "--", ...prospectivePaths], {
    env: temporaryEnvironment,
  });
  const treeResult = command("git", ["write-tree"], {
    env: temporaryEnvironment,
  });
  const prospectiveTree = treeResult.stdout;
  const routeResult = command("git", [
    "ls-tree",
    "-r",
    "--name-only",
    prospectiveTree,
    "--",
    routePath,
  ]);
  if (routeResult.stdout !== routePath) {
    throw new Error(`${routePath} is absent from prospective tree ${prospectiveTree}`);
  }

  command("git", [
    "archive",
    "--format=tar",
    `--output=${archivePath}`,
    prospectiveTree,
  ]);
  mkdirSync(checkoutRoot, { recursive: true });
  command("tar.exe", ["-xf", archivePath, "-C", checkoutRoot]);

  if (!existsSync(join(isolatedSourceRoot, "package-lock.json"))) {
    throw new Error("Prospective clean tree is missing source/package-lock.json");
  }
  if (!existsSync(join(isolatedSourceRoot, ...routePath.replace(/^source\//u, "").split("/")))) {
    throw new Error("Prospective clean checkout is missing the Workbench sessions route");
  }

  const isolatedEnvironment = {
    ...process.env,
    AGENTIC_OS_FOLDERS_ROOT: runtimeRoot,
    PLAYWRIGHT_PORT: "39130",
    CI: "1",
  };
  const install = npmCommand(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: isolatedSourceRoot,
    env: isolatedEnvironment,
    timeoutMs: 300_000,
  });
  const build = npmCommand(["run", "build"], {
    cwd: isolatedSourceRoot,
    env: isolatedEnvironment,
    timeoutMs: 300_000,
  });
  const contracts = npmCommand(
    [
      "exec",
      "--",
      "playwright",
      "test",
      "tests/e2e/workbench-native-adapters.spec.ts",
      "tests/e2e/workbench-api.spec.ts",
    ], {
      cwd: isolatedSourceRoot,
      env: isolatedEnvironment,
      timeoutMs: 300_000,
    },
  );

  const evidence = {
    schemaVersion: "agent-os-wave-0-clean-tree/v1",
    evidenceLevel: "static-contract",
    collectedAt: new Date().toISOString(),
    gitHead: command("git", ["rev-parse", "HEAD"]).stdout,
    prospectiveTree,
    route: {
      path: routePath,
      included: true,
      sha256: await sha256(resolve(repoRoot, routePath)),
    },
    packageLockSha256: await sha256(join(sourceRoot, "package-lock.json")),
    isolation: {
      source: "git-archive-of-isolated-temporary-index",
      dependencyInstall: "npm-ci-ignore-scripts",
      runtimeData: "scratch-directory",
      existingWorkbenchDatabaseUsed: false,
      existingE2eFinalTouched: false,
    },
    gates: {
      npmCi: { status: "passed", durationMs: install.durationMs },
      nextBuild: { status: "passed", durationMs: build.durationMs },
      workbenchContracts: {
        status: "passed",
        durationMs: contracts.durationMs,
        suites: [
          "tests/e2e/workbench-native-adapters.spec.ts",
          "tests/e2e/workbench-api.spec.ts",
        ],
      },
    },
  };
  await writeEvidence(evidence);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  rmSync(scratchDirectory, { recursive: true, force: true });
}
