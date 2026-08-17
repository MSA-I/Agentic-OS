import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const verifierPath = path.join(
  repositoryRoot,
  "scripts",
  "control-plane",
  "verify-wave1-execution-freeze.mjs",
);
const generatorPath = path.join(
  repositoryRoot,
  "scripts",
  "control-plane",
  "inventory-mutations.mjs",
);
const releaseInputSnapshotPath = path.join(
  repositoryRoot,
  "scripts",
  "control-plane",
  "release-input-snapshot.mjs",
);
const scratchRoot = path.join(repositoryRoot, ".next", "control-plane-freeze-tests");

function writeFixtureFile(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function runNode(script, cwd, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return result;
}

function createFixture() {
  mkdirSync(scratchRoot, { recursive: true });
  const root = mkdtempSync(path.join(scratchRoot, "case-"));
  const fixtureGenerator = path.join(root, "scripts", "control-plane", "inventory-mutations.mjs");
  mkdirSync(path.dirname(fixtureGenerator), { recursive: true });
  copyFileSync(generatorPath, fixtureGenerator);
  copyFileSync(releaseInputSnapshotPath, path.join(path.dirname(fixtureGenerator), "release-input-snapshot.mjs"));
  // The manifest lives in its own pure-data module and the guard imports it, so
  // the fixture mirrors that split: the verifier reads the manifest file and also
  // checks that the guard has not grown a private copy.
  writeFixtureFile(root, "src/lib/control-plane/frozenExecutionRoutes.ts", `
export const WAVE1_FROZEN_EXECUTION_ROUTES = [
  "POST /api/provider/run",
] as const;
`.trimStart());
  writeFixtureFile(root, "src/lib/control-plane/executionFreeze.ts", `
import { WAVE1_FROZEN_EXECUTION_ROUTES } from "./frozenExecutionRoutes";

export const FROZEN_EXECUTION_ROUTE_IDS = WAVE1_FROZEN_EXECUTION_ROUTES;

export function denyFrozenExecutionMutation(_routeId: string) {
  return null;
}
`.trimStart());
  writeFixtureFile(root, "src/app/api/provider/run/route.ts", `
import { denyFrozenExecutionMutation } from "@/lib/control-plane/executionFreeze";

export async function POST() {
  const frozen = denyFrozenExecutionMutation("POST /api/provider/run");
  if (frozen) return frozen;
  return Response.json({ ok: true });
}
`.trimStart());
  writeFixtureFile(root, "package-lock.json", `${JSON.stringify({ name: "freeze-fixture", lockfileVersion: 3 }, null, 2)}\n`);
  writeFixtureFile(root, ".env.local", `
AGENTIC_OS_FOLDERS_ROOT=C:\\fixture\\folders-a
AGENTIC_OS_CODEX_SCRATCH=C:\\fixture\\scratch-a
AGENTIC_OS_APIKEY=fixture-fused-secret-a
AGENTIC_OS_DSN=fixture-dsn-secret-a
AGENTIC_OS_DATABASE_URL=fixture-database-url-secret-a
AGENTIC_OS_CONNECTION_STRING=fixture-connection-secret-a
OPENCLAW_GATEWAY_TOKEN=fixture-secret-a
`.trimStart());
  writeFixtureFile(root, "agentic-os.config.json", `${JSON.stringify({
    foldersRoot: "C:\\fixture\\folders-a",
    providerToken: "fixture-secret-a",
  }, null, 2)}\n`);
  const generated = runNode(fixtureGenerator, root);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);
  return root;
}

test("Wave 1 verifier fails closed when a mutation route file is added after inventory generation", () => {
  const root = createFixture();
  try {
    const baseline = runNode(verifierPath, root);
    assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
    const baselineEvidence = JSON.parse(baseline.stdout);
    assert.equal(baselineEvidence.inventoryFreshnessStatus, "pass");
    assert.equal(baselineEvidence.sourceDigestMatches, true);
    assert.equal(baselineEvidence.sourceFileCountMatches, true);
    assert.equal(baselineEvidence.generatorDigestMatches, true);

    writeFixtureFile(root, "src/app/api/provider/unfrozen/route.ts", `
export async function POST() {
  return runUnfrozenProvider();
}
`.trimStart());

    const stale = runNode(verifierPath, root);
    assert.equal(stale.status, 1, stale.stderr || stale.stdout);
    const evidence = JSON.parse(stale.stdout);
    assert.equal(evidence.inventoryFreshnessStatus, "fail");
    assert.equal(evidence.routeContractStatus, "fail");
    assert.equal(evidence.sourceDigestMatches, false);
    assert.equal(evidence.sourceFileCountMatches, false);
    assert.equal(evidence.generatorDigestMatches, true);
    assert.equal(evidence.currentSourceFileCount, evidence.inventorySourceFileCount + 1);
    assert.ok(evidence.errors.some((error) => error.includes("source digest is stale")));
    assert.ok(evidence.errors.some((error) => error.includes("source file set is stale")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Wave 1 verifier fails closed when source content changes without changing the file count", () => {
  const root = createFixture();
  try {
    writeFixtureFile(root, "src/app/api/provider/run/route.ts", `
import { denyFrozenExecutionMutation } from "@/lib/control-plane/executionFreeze";

export async function POST() {
  const frozen = denyFrozenExecutionMutation("POST /api/provider/run");
  if (frozen) return frozen;
  return Response.json({ ok: true, changedAfterInventory: true });
}
`.trimStart());

    const stale = runNode(verifierPath, root);
    assert.equal(stale.status, 1, stale.stderr || stale.stdout);
    const evidence = JSON.parse(stale.stdout);
    assert.equal(evidence.inventoryFreshnessStatus, "fail");
    assert.equal(evidence.sourceDigestMatches, false);
    assert.equal(evidence.sourceFileCountMatches, true);
    assert.ok(evidence.errors.some((error) => error.includes("source digest is stale")));
    assert.equal(evidence.errors.some((error) => error.includes("source file set is stale")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Wave 1 verifier fails closed when an untracked test is added after inventory generation", () => {
  const root = createFixture();
  try {
    const baseline = runNode(verifierPath, root);
    assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
    const baselineEvidence = JSON.parse(baseline.stdout);
    assert.equal(baselineEvidence.releaseInputDigestMatches, true);
    assert.equal(baselineEvidence.releaseInputFileCountMatches, true);

    writeFixtureFile(root, "tests/e2e/untracked-runtime-proof.spec.ts", `
export const untrackedRuntimeProof = "must invalidate the release-input manifest";
`.trimStart());

    const stale = runNode(verifierPath, root);
    assert.equal(stale.status, 1, stale.stderr || stale.stdout);
    const evidence = JSON.parse(stale.stdout);
    assert.equal(evidence.inventoryFreshnessStatus, "fail");
    assert.equal(evidence.releaseInputDigestMatches, false);
    assert.equal(evidence.releaseInputFileCountMatches, false);
    assert.equal(evidence.currentReleaseInputFileCount, evidence.inventoryReleaseInputFileCount + 1);
    assert.ok(evidence.errors.some((error) => error.includes("release-input digest is stale")));
    assert.ok(evidence.errors.some((error) => error.includes("release-input file set is stale")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Wave 1 verifier fails closed when the lockfile changes without changing the file count", () => {
  const root = createFixture();
  try {
    writeFixtureFile(root, "package-lock.json", `${JSON.stringify({
      name: "freeze-fixture",
      lockfileVersion: 3,
      packages: { "": { dependencies: { sqlite: "changed-after-inventory" } } },
    }, null, 2)}\n`);

    const stale = runNode(verifierPath, root);
    assert.equal(stale.status, 1, stale.stderr || stale.stdout);
    const evidence = JSON.parse(stale.stdout);
    assert.equal(evidence.inventoryFreshnessStatus, "fail");
    assert.equal(evidence.releaseInputDigestMatches, false);
    assert.equal(evidence.releaseInputFileCountMatches, true);
    assert.ok(evidence.errors.some((error) => error.includes("release-input digest is stale")));
    assert.equal(evidence.errors.some((error) => error.includes("release-input file set is stale")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Wave 1 verifier fails closed when an untracked public asset is added", () => {
  const root = createFixture();
  try {
    writeFixtureFile(root, "public/runtime-control-plane.txt", "untracked deployable asset\n");
    const stale = runNode(verifierPath, root);
    assert.equal(stale.status, 1, stale.stderr || stale.stdout);
    const evidence = JSON.parse(stale.stdout);
    assert.equal(evidence.releaseInputDigestMatches, false);
    assert.equal(evidence.releaseInputFileCountMatches, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Wave 1 verifier fingerprints non-secret runtime config and exposes the secret boundary", () => {
  const root = createFixture();
  try {
    const baseline = runNode(verifierPath, root);
    assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
    const baselineEvidence = JSON.parse(baseline.stdout);
    assert.ok(baselineEvidence.currentReleaseInputConfigBoundaries.some((item) =>
      item.path === ".env.local"
      && item.includedValuePolicy.includes("AGENTIC_OS_*")
      && item.secretValueCoverage === "presence-only; live runtime verification required"));
    assert.equal(
      baselineEvidence.currentReleaseInputRuntimeEnvironmentBoundary.valueCoverage,
      "not fingerprinted by static inventory; live runtime verification required",
    );

    writeFixtureFile(root, ".env.local", `
AGENTIC_OS_FOLDERS_ROOT=C:\\fixture\\folders-b
AGENTIC_OS_CODEX_SCRATCH=C:\\fixture\\scratch-a
AGENTIC_OS_APIKEY=fixture-fused-secret-a
AGENTIC_OS_DSN=fixture-dsn-secret-a
AGENTIC_OS_DATABASE_URL=fixture-database-url-secret-a
AGENTIC_OS_CONNECTION_STRING=fixture-connection-secret-a
OPENCLAW_GATEWAY_TOKEN=fixture-secret-a
`.trimStart());
    const stale = runNode(verifierPath, root);
    assert.equal(stale.status, 1, stale.stderr || stale.stdout);
    const staleEvidence = JSON.parse(stale.stdout);
    assert.equal(staleEvidence.releaseInputDigestMatches, false);
    assert.equal(staleEvidence.releaseInputFileCountMatches, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Wave 1 verifier never turns secret values into a static fingerprint", () => {
  const root = createFixture();
  try {
    writeFixtureFile(root, ".env.local", `
AGENTIC_OS_FOLDERS_ROOT=C:\\fixture\\folders-a
AGENTIC_OS_CODEX_SCRATCH=C:\\fixture\\scratch-a
AGENTIC_OS_APIKEY=fixture-fused-secret-b
AGENTIC_OS_DSN=fixture-dsn-secret-b
AGENTIC_OS_DATABASE_URL=fixture-database-url-secret-b
AGENTIC_OS_CONNECTION_STRING=fixture-connection-secret-b
OPENCLAW_GATEWAY_TOKEN=fixture-secret-b
`.trimStart());
    writeFixtureFile(root, "agentic-os.config.json", `${JSON.stringify({
      foldersRoot: "C:\\fixture\\folders-a",
      providerToken: "fixture-secret-b",
    }, null, 2)}\n`);
    const result = runNode(verifierPath, root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.releaseInputDigestMatches, true);
    assert.equal(evidence.inventoryFreshnessStatus, "pass");
    assert.ok(evidence.currentReleaseInputConfigBoundaries.every((item) =>
      item.secretValueCoverage === "presence-only; live runtime verification required"));
    assert.doesNotMatch(result.stdout, /fixture-(?:fused-|dsn-|database-url-|connection-)?secret-[ab]/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Wave 1 verifier fails closed on an unparsed environment line", () => {
  const root = createFixture();
  try {
    writeFixtureFile(root, ".env.local", "this line cannot be fingerprinted safely\n");
    const result = runNode(verifierPath, root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Secret-safe config parsing failed/u);
    assert.doesNotMatch(result.stderr, /fixture-secret/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
