#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { captureReleaseInputSnapshot, compareUtf8 } from "./release-input-snapshot.mjs";

const repositoryRoot = process.cwd();
const sourceRoot = path.join(repositoryRoot, "src");
const manifestPath = path.join(repositoryRoot, "src", "lib", "control-plane", "executionFreeze.ts");
const inventoryPath = path.join(repositoryRoot, "docs", "control-plane", "mutation-inventory.json");
const inventoryGeneratorPath = path.join(repositoryRoot, "scripts", "control-plane", "inventory-mutations.mjs");
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function relativeToRepository(filePath) {
  return toPosix(path.relative(repositoryRoot, filePath));
}

function listSourceFiles(directory) {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(absolutePath));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(absolutePath);
    }
  }
  return files;
}

function captureSourceSnapshot() {
  if (!existsSync(sourceRoot)) throw new Error("Required source root is missing: src");
  const sources = listSourceFiles(sourceRoot).map((absolutePath) => ({
    absolutePath,
    relativePath: relativeToRepository(absolutePath),
    text: readFileSync(absolutePath, "utf8"),
  }));
  const digest = createHash("sha256");
  for (const source of sources) {
    digest.update(source.relativePath);
    digest.update("\0");
    digest.update(source.text);
    digest.update("\0");
  }
  return {
    sources,
    byRelativePath: new Map(sources.map((source) => [source.relativePath, source])),
    sourceDigestSha256: digest.digest("hex"),
  };
}

const sourceSnapshot = captureSourceSnapshot();
const releaseInputSnapshot = captureReleaseInputSnapshot(repositoryRoot);
const manifestRelativePath = relativeToRepository(manifestPath);
const manifestSource = sourceSnapshot.byRelativePath.get(manifestRelativePath)?.text;
if (manifestSource === undefined) throw new Error(`Execution-freeze manifest is missing: ${manifestRelativePath}`);
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));

const frozenRoutes = [...manifestSource.matchAll(/^  "((?:POST|PUT|PATCH|DELETE) \/api\/[^"]+)",$/gmu)]
  .map((match) => match[1]);
const frozenSet = new Set(frozenRoutes);
const inventoryById = new Map(inventory.routes.map((route) => [route.id, route]));
const errors = [];
const guardEvidence = [];

const inventorySourceDigestSha256 = inventory.snapshot?.sourceDigestSha256;
const inventorySourceFileCount = inventory.snapshot?.sourceFilesRead;
const inventoryGeneratorDigestSha256 = inventory.snapshot?.generatorSha256;
const inventoryReleaseInputDigestSha256 = inventory.snapshot?.releaseInputDigestSha256;
const inventoryReleaseInputFileCount = inventory.snapshot?.releaseInputFilesRead;
const inventoryReleaseInputConfigBoundaries = inventory.snapshot?.releaseInputConfigBoundaries;
const inventoryReleaseInputRuntimeEnvironmentBoundary = inventory.snapshot?.releaseInputRuntimeEnvironmentBoundary;
const currentSourceFileCount = sourceSnapshot.sources.length;
const currentGeneratorDigestSha256 = createHash("sha256")
  .update(readFileSync(inventoryGeneratorPath, "utf8"))
  .digest("hex");
const sourceDigestMatches = inventorySourceDigestSha256 === sourceSnapshot.sourceDigestSha256;
const sourceFileCountMatches = inventorySourceFileCount === currentSourceFileCount;
const generatorDigestMatches = inventoryGeneratorDigestSha256 === currentGeneratorDigestSha256;
const releaseInputDigestMatches = inventoryReleaseInputDigestSha256 === releaseInputSnapshot.digestSha256;
const releaseInputFileCountMatches = inventoryReleaseInputFileCount === releaseInputSnapshot.filesRead;
if (!sourceDigestMatches) {
  errors.push(
    `Mutation inventory source digest is stale: expected ${sourceSnapshot.sourceDigestSha256}, received ${String(inventorySourceDigestSha256)}.`,
  );
}
if (!sourceFileCountMatches) {
  errors.push(
    `Mutation inventory source file set is stale: expected ${currentSourceFileCount} files, received ${String(inventorySourceFileCount)}.`,
  );
}
if (!generatorDigestMatches) {
  errors.push(
    `Mutation inventory generator digest is stale: expected ${currentGeneratorDigestSha256}, received ${String(inventoryGeneratorDigestSha256)}.`,
  );
}
if (!releaseInputDigestMatches) {
  errors.push(
    `Mutation inventory release-input digest is stale: expected ${releaseInputSnapshot.digestSha256}, received ${String(inventoryReleaseInputDigestSha256)}.`,
  );
}
if (!releaseInputFileCountMatches) {
  errors.push(
    `Mutation inventory release-input file set is stale: expected ${releaseInputSnapshot.filesRead} files, received ${String(inventoryReleaseInputFileCount)}.`,
  );
}
if (errors.length > 0) {
  process.stdout.write(`${JSON.stringify({
    evidenceLevel: "static-contract",
    inventoryFreshnessStatus: "fail",
    inventorySourceDigestSha256,
    currentSourceDigestSha256: sourceSnapshot.sourceDigestSha256,
    inventorySourceFileCount,
    currentSourceFileCount,
    inventoryGeneratorDigestSha256,
    currentGeneratorDigestSha256,
    inventoryReleaseInputDigestSha256,
    currentReleaseInputDigestSha256: releaseInputSnapshot.digestSha256,
    inventoryReleaseInputFileCount,
    currentReleaseInputFileCount: releaseInputSnapshot.filesRead,
    inventoryReleaseInputConfigBoundaries,
    currentReleaseInputConfigBoundaries: releaseInputSnapshot.configBoundaries,
    inventoryReleaseInputRuntimeEnvironmentBoundary,
    currentReleaseInputRuntimeEnvironmentBoundary: releaseInputSnapshot.runtimeEnvironmentBoundary,
    sourceDigestMatches,
    sourceFileCountMatches,
    generatorDigestMatches,
    releaseInputDigestMatches,
    releaseInputFileCountMatches,
    frozenRouteCount: frozenRoutes.length,
    inventoryRouteCount: Array.isArray(inventory.routes) ? inventory.routes.length : null,
    verificationSkipped: "stale_mutation_inventory",
    routeContractStatus: "fail",
    errors,
  }, null, 2)}\n`);
  process.exit(1);
}

if (frozenSet.size !== frozenRoutes.length) errors.push("Frozen execution manifest contains duplicate route IDs.");

function handlerBody(sourceFile, method) {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === method && statement.body) {
      return statement.body;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === method && declaration.initializer) {
          const initializer = declaration.initializer;
          if ((ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) && initializer.body && ts.isBlock(initializer.body)) {
            return initializer.body;
          }
        }
      }
    }
  }
  return null;
}

for (const routeId of frozenRoutes) {
  const route = inventoryById.get(routeId);
  if (!route) {
    errors.push(`Frozen route is missing from mutation inventory: ${routeId}`);
    continue;
  }
  const source = sourceSnapshot.byRelativePath.get(route.file)?.text;
  if (source === undefined) {
    errors.push(`${routeId} references a source file outside the current inventory snapshot: ${route.file}.`);
    continue;
  }
  const sourceFile = ts.createSourceFile(route.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const importWired = sourceFile.statements.some((statement) =>
    ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === "@/lib/control-plane/executionFreeze"
      && statement.importClause?.namedBindings
      && ts.isNamedImports(statement.importClause.namedBindings)
      && statement.importClause.namedBindings.elements.some((element) => element.name.text === "denyFrozenExecutionMutation"));
  const body = handlerBody(sourceFile, route.method);
  if (!importWired) errors.push(`${routeId} is missing the execution-freeze import in ${route.file}.`);
  if (!body) {
    errors.push(`${routeId} has no analyzable exported ${route.method} handler in ${route.file}.`);
    continue;
  }
  const firstStatements = body.statements.slice(0, 2).map((statement) => statement.getText(sourceFile));
  const guardFirst = firstStatements.length === 2
    && /denyFrozenExecutionMutation\s*\(/u.test(firstStatements[0])
    && firstStatements[0].includes(JSON.stringify(routeId))
    && /if\s*\(\s*frozen\s*\)\s*return\s+frozen/u.test(firstStatements[1]);
  if (!guardFirst) {
    errors.push(`${routeId} does not fail closed in its first two handler statements in ${route.file}.`);
  }
  guardEvidence.push({ routeId, file: route.file, importWired, guardFirst });
}

const EXECUTION_PATTERNS = [
  { code: "process", pattern: /\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(/u },
  { code: "tool", pattern: /\bcallTool\s*(?:<[^>]+>)?\s*\(/u },
  { code: "lifecycle", pattern: /\b(?:run|start|stop|resume|invoke|execute|generate|deploy|publish|commission|install|sync|send)[A-Z][A-Za-z0-9_]*\s*\(/u },
  { code: "known-external", pattern: /\b(?:addCustomServer|toggleEnabled|uninstall|setToolsInclude|parseICP|enrichEmails|hunterDomainSearch|apolloSearch|scoreAndPersonalize|gmailSend|createShort)\s*\(/u },
  { code: "network-mutation", pattern: /\bfetch\s*\([\s\S]{0,500}?\bmethod\s*:\s*["'](?:POST|PUT|PATCH|DELETE)["']/u },
];

// A classification is required if a conservative heuristic ever finds a non-execution
// mutation. Every exception must carry a rationale that names the controls standing in
// for the freeze, so the exception is auditable instead of silent.
const falsePositiveClassifications = new Map([
  [
    "POST /api/graphify/run",
    "Local read-only knowledge-graph tool kept live by explicit owner decision instead of"
    + " freezing it. It is not a provider execution path: no AGENT-OS run, session or"
    + " provider identity is created. Standing controls: authorizeLocalMutation (loopback,"
    + " Host/Origin match, no cross-site), readLocalMutationJson (JSON only, 64 KiB cap),"
    + " a first-token allowlist with no shell, denial of --mcp/--watch/--neo4j-push/"
    + "--falkordb-push/--obsidian/--wiki and of any argument containing '://', a canonical"
    + " non-symlinked cwd inside AGENT_OS_GRAPHIFY_ROOTS, buildToolChildEnvironment instead"
    + " of process.env, and redactText on stdout/stderr. Must move behind a Tool Gateway"
    + " approval in Wave 4.",
  ],
]);
const unclassifiedExecutionCandidates = [];
for (const route of inventory.routes) {
  if (frozenSet.has(route.id)) continue;
  const source = sourceSnapshot.byRelativePath.get(route.file)?.text;
  if (source === undefined) {
    errors.push(`${route.id} references a source file outside the current inventory snapshot: ${route.file}.`);
    continue;
  }
  const sourceFile = ts.createSourceFile(route.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const body = handlerBody(sourceFile, route.method);
  if (!body) continue;
  const bodyText = body.getText(sourceFile);
  const reasons = EXECUTION_PATTERNS.filter((item) => item.pattern.test(bodyText)).map((item) => item.code);
  if (reasons.length === 0) continue;
  const classification = falsePositiveClassifications.get(route.id);
  if (!classification) unclassifiedExecutionCandidates.push({ routeId: route.id, file: route.file, reasons });
}
if (unclassifiedExecutionCandidates.length > 0) {
  errors.push(`${unclassifiedExecutionCandidates.length} execution-capable mutation route(s) are outside the freeze manifest.`);
}

const directExecutionCallers = inventory.frontendCallers.filter((caller) =>
  caller.matchedRouteIds.some((routeId) => frozenSet.has(routeId)));

const result = {
  evidenceLevel: "static-contract",
  inventoryFreshnessStatus: sourceDigestMatches
    && sourceFileCountMatches
    && generatorDigestMatches
    && releaseInputDigestMatches
    && releaseInputFileCountMatches
    ? "pass"
    : "fail",
  inventorySourceDigestSha256,
  currentSourceDigestSha256: sourceSnapshot.sourceDigestSha256,
  inventorySourceFileCount,
  currentSourceFileCount,
  inventoryGeneratorDigestSha256,
  currentGeneratorDigestSha256,
  inventoryReleaseInputDigestSha256,
  currentReleaseInputDigestSha256: releaseInputSnapshot.digestSha256,
  inventoryReleaseInputFileCount,
  currentReleaseInputFileCount: releaseInputSnapshot.filesRead,
  inventoryReleaseInputConfigBoundaries,
  currentReleaseInputConfigBoundaries: releaseInputSnapshot.configBoundaries,
  inventoryReleaseInputRuntimeEnvironmentBoundary,
  currentReleaseInputRuntimeEnvironmentBoundary: releaseInputSnapshot.runtimeEnvironmentBoundary,
  sourceDigestMatches,
  sourceFileCountMatches,
  generatorDigestMatches,
  releaseInputDigestMatches,
  releaseInputFileCountMatches,
  frozenRouteCount: frozenRoutes.length,
  inventoryRouteCount: inventory.routes.length,
  missingFrozenRoutes: frozenRoutes.filter((routeId) => !inventoryById.has(routeId)),
  unguardedFrozenRoutes: guardEvidence.filter((item) => !item.importWired || !item.guardFirst),
  unclassifiedExecutionCandidates,
  falsePositiveClassifications: [...falsePositiveClassifications].map(([routeId, rationale]) => ({ routeId, rationale })),
  directExecutionCallerCount: directExecutionCallers.length,
  uiDirectExecutionStatus: directExecutionCallers.length === 0 ? "pass" : "blocked",
  uiDirectExecutionCallers: directExecutionCallers.map(({ id, file, line, apiPath, matchedRouteIds }) => ({ id, file, line, apiPath, matchedRouteIds })),
  routeContractStatus: errors.length === 0 ? "pass" : "fail",
  errors,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (errors.length > 0) process.exitCode = 1;
