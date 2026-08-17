#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { captureReleaseInputSnapshot, compareUtf8 } from "./release-input-snapshot.mjs";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PROVIDER_PREFIXES = [
  "/api/antigravity",
  "/api/claude",
  "/api/codex",
  "/api/hermes",
  "/api/openclaw",
];
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const CLASSIFICATIONS = ["direct-provider", "workbench", "other"];

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..", "..");
const sourceRoot = path.join(repositoryRoot, "src");
const routeRoot = path.join(sourceRoot, "app", "api");
const outputDirectory = path.join(repositoryRoot, "docs", "control-plane");
const jsonPath = path.join(outputDirectory, "mutation-inventory.json");
const markdownPath = path.join(outputDirectory, "MUTATION-INVENTORY.md");
const checkOnly = process.argv.includes("--check");

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
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(absolutePath);
    }
  }

  return files;
}

function readSources() {
  if (!existsSync(sourceRoot) || !existsSync(routeRoot)) {
    throw new Error(`Required source root is missing: ${relativeToRepository(routeRoot)}`);
  }

  return listSourceFiles(sourceRoot).map((absolutePath) => ({
    absolutePath,
    relativePath: relativeToRepository(absolutePath),
    // readFileSync deliberately remains unguarded: any unreadable source fails the inventory.
    text: readFileSync(absolutePath, "utf8"),
  }));
}

function scriptKindFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".js":
    case ".cjs":
    case ".mjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function parseSource(source) {
  const sourceFile = ts.createSourceFile(
    source.relativePath,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(source.relativePath),
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    throw new Error(`TypeScript parse failure in ${source.relativePath}: ${message}`);
  }
  return sourceFile;
}

function locationOf(sourceFile, node) {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: location.line + 1, column: location.character + 1 };
}

function hasExportModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function routePathFromFile(relativePath) {
  const routeRelative = relativePath
    .replace(/^src\/app\/api\//, "")
    .replace(/\/route\.[cm]?[jt]sx?$/, "");
  const urlSegments = routeRelative
    .split("/")
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .filter((segment) => !segment.startsWith("@"));
  return `/api/${urlSegments.join("/")}`;
}

function classifyApiPath(apiPath) {
  if (apiPath === "/api/workbench" || apiPath.startsWith("/api/workbench/")) {
    return "workbench";
  }
  if (PROVIDER_PREFIXES.some((prefix) => apiPath === prefix || apiPath.startsWith(`${prefix}/`))) {
    return "direct-provider";
  }
  return "other";
}

function collectRouteHandlers(sources) {
  const routes = [];

  for (const source of sources) {
    if (!/^src\/app\/api\/.+\/route\.[cm]?[jt]sx?$/.test(source.relativePath)) {
      continue;
    }
    const sourceFile = parseSource(source);
    const directExports = new Set();
    const exportedNames = [];

    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
        const name = statement.name.text.toUpperCase();
        if (MUTATION_METHODS.has(name)) {
          directExports.add(name);
          exportedNames.push({ method: name, node: statement.name });
        }
      }

      if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          const name = declaration.name.text.toUpperCase();
          if (MUTATION_METHODS.has(name)) {
            directExports.add(name);
            exportedNames.push({ method: name, node: declaration.name });
          }
        }
      }

      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const name = element.name.text.toUpperCase();
          if (MUTATION_METHODS.has(name) && !directExports.has(name)) {
            exportedNames.push({ method: name, node: element.name });
          }
        }
      }
    }

    const methodsSeen = new Set();
    for (const item of exportedNames) {
      if (methodsSeen.has(item.method)) {
        throw new Error(`Duplicate ${item.method} route export in ${source.relativePath}`);
      }
      methodsSeen.add(item.method);
      const location = locationOf(sourceFile, item.node);
      const apiPath = routePathFromFile(source.relativePath);
      routes.push({
        id: `${item.method} ${apiPath}`,
        method: item.method,
        apiPath,
        classification: classifyApiPath(apiPath),
        file: source.relativePath,
        line: location.line,
        column: location.column,
      });
    }
  }

  return routes.sort((left, right) =>
    compareUtf8(left.apiPath, right.apiPath)
      || compareUtf8(left.method, right.method)
      || compareUtf8(left.file, right.file)
      || left.line - right.line,
  );
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function collectUniqueInitializers(sourceFile) {
  const candidates = new Map();

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const existing = candidates.get(node.name.text);
      candidates.set(node.name.text, existing ? null : node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return candidates;
}

function resolvedExpression(expression, initializers, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (!ts.isIdentifier(current)) return current;
  if (seen.has(current.text)) return current;
  const initializer = initializers.get(current.text);
  if (!initializer) return current;
  return resolvedExpression(initializer, initializers, new Set([...seen, current.text]));
}

function resolveStaticString(expression, initializers, seen = new Set()) {
  const current = unwrapExpression(expression);
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isNumericLiteral(current)) return current.text;
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return null;
    const initializer = initializers.get(current.text);
    if (!initializer) return null;
    return resolveStaticString(initializer, initializers, new Set([...seen, current.text]));
  }
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text;
    for (const span of current.templateSpans) {
      const substitution = resolveStaticString(span.expression, initializers, seen);
      if (substitution === null) return null;
      value += substitution + span.literal.text;
    }
    return value;
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStaticString(current.left, initializers, seen);
    const right = resolveStaticString(current.right, initializers, seen);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function resolveTargetPattern(expression, initializers, seen = new Set()) {
  const current = unwrapExpression(expression);
  const staticValue = resolveStaticString(current, initializers, seen);
  if (staticValue !== null) return staticValue;

  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return null;
    const initializer = initializers.get(current.text);
    if (!initializer) return null;
    return resolveTargetPattern(initializer, initializers, new Set([...seen, current.text]));
  }
  if (ts.isTemplateExpression(current)) {
    let value = current.head.text;
    for (const span of current.templateSpans) {
      value += `*${span.literal.text}`;
    }
    return value;
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveTargetPattern(current.left, initializers, seen) ?? "*";
    const right = resolveTargetPattern(current.right, initializers, seen) ?? "*";
    return left + right;
  }
  return null;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
}

function resolveFetchMethod(optionsExpression, initializers) {
  if (!optionsExpression) return { kind: "default-get", method: "GET" };
  const options = resolvedExpression(optionsExpression, initializers);
  if (!ts.isObjectLiteralExpression(options)) {
    return { kind: "unresolved", method: null };
  }

  for (const property of options.properties) {
    if (ts.isPropertyAssignment(property) && propertyNameText(property.name)?.toLowerCase() === "method") {
      const method = resolveStaticString(property.initializer, initializers)?.toUpperCase() ?? null;
      return method ? { kind: "resolved", method } : { kind: "unresolved", method: null };
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text.toLowerCase() === "method") {
      const method = resolveStaticString(property.name, initializers)?.toUpperCase() ?? null;
      return method ? { kind: "resolved", method } : { kind: "unresolved", method: null };
    }
  }

  return { kind: "default-get", method: "GET" };
}

function isFetchCall(node) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) return node.expression.text === "fetch";
  return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "fetch";
}

function sourceRole(sourceFile, relativePath) {
  const hasUseClient = sourceFile.statements.some(
    (statement) => ts.isExpressionStatement(statement)
      && ts.isStringLiteral(statement.expression)
      && statement.expression.text === "use client",
  );
  if (hasUseClient) return "client-module";
  if (/^src\/(components|hooks)\//.test(relativePath)) return "frontend-module";
  if (relativePath.startsWith("src/app/")) return "app-ui-module";
  return "shared-source";
}

function normalizedApiPath(targetPattern) {
  if (!targetPattern?.startsWith("/api/")) return null;
  return targetPattern.split(/[?#]/, 1)[0].replace(/\*+/g, "*");
}

function segmentMatches(routeSegment, callerSegment) {
  if (/^\[\[?\.\.\..+\]\]?$/.test(routeSegment)) return true;
  if (/^\[[^\]]+\]$/.test(routeSegment)) return callerSegment.length > 0;
  if (!callerSegment.includes("*")) return routeSegment === callerSegment;
  const escaped = callerSegment
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(routeSegment);
}

function routeMatchesCaller(routePath, callerPath) {
  const routeSegments = routePath.split("/").filter(Boolean);
  const callerSegments = callerPath.split("/").filter(Boolean);
  const catchAllIndex = routeSegments.findIndex((segment) => /^\[\[?\.\.\./.test(segment));
  if (catchAllIndex === -1 && routeSegments.length !== callerSegments.length) return false;
  if (catchAllIndex !== -1 && callerSegments.length < catchAllIndex) return false;

  return routeSegments.every((routeSegment, index) => {
    if (/^\[\[?\.\.\./.test(routeSegment)) return true;
    const callerSegment = callerSegments[index];
    return callerSegment !== undefined && segmentMatches(routeSegment, callerSegment);
  });
}

function collectFrontendMutationCallers(sources, routes) {
  const callers = [];
  const unresolvedInternalFetchMethods = [];
  const mutationFetchesOutsideInternalApi = [];

  for (const source of sources) {
    if (source.relativePath.startsWith("src/app/api/")) continue;
    const sourceFile = parseSource(source);
    const initializers = collectUniqueInitializers(sourceFile);
    const role = sourceRole(sourceFile, source.relativePath);

    function visit(node) {
      if (isFetchCall(node) && node.arguments.length > 0) {
        const methodResult = resolveFetchMethod(node.arguments[1], initializers);
        const targetExpression = node.arguments[0].getText(sourceFile);
        const targetPattern = resolveTargetPattern(node.arguments[0], initializers);
        const apiPath = normalizedApiPath(targetPattern);
        const location = locationOf(sourceFile, node);
        const base = {
          file: source.relativePath,
          line: location.line,
          column: location.column,
          sourceRole: role,
          targetExpression,
          targetPattern,
        };

        if (methodResult.kind === "unresolved" && apiPath) {
          unresolvedInternalFetchMethods.push(base);
        } else if (methodResult.method && MUTATION_METHODS.has(methodResult.method)) {
          if (!apiPath) {
            mutationFetchesOutsideInternalApi.push({
              ...base,
              id: `${methodResult.method} ${source.relativePath}:${location.line}:${location.column}`,
              kind: "direct-fetch",
              method: methodResult.method,
              apiPath: null,
              classification: "other",
              matchedRouteIds: [],
            });
          } else {
            const matchedRouteIds = routes
              .filter((route) => route.method === methodResult.method && routeMatchesCaller(route.apiPath, apiPath))
              .map((route) => route.id)
              .sort(compareUtf8);
            callers.push({
              id: `${methodResult.method} ${source.relativePath}:${location.line}:${location.column}`,
              kind: "direct-fetch",
              method: methodResult.method,
              apiPath,
              classification: classifyApiPath(apiPath),
              file: source.relativePath,
              line: location.line,
              column: location.column,
              sourceRole: role,
              targetExpression,
              targetPattern,
              matchedRouteIds,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  const sorter = (left, right) =>
    compareUtf8(left.file, right.file)
      || left.line - right.line
      || left.column - right.column;
  callers.sort(sorter);
  unresolvedInternalFetchMethods.sort(sorter);
  mutationFetchesOutsideInternalApi.sort(sorter);
  return { callers, unresolvedInternalFetchMethods, mutationFetchesOutsideInternalApi };
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current)
      || ts.isFunctionExpression(current)
      || ts.isArrowFunction(current)
      || ts.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function callableName(functionNode) {
  if (functionNode.name && ts.isIdentifier(functionNode.name)) return functionNode.name.text;
  if (ts.isVariableDeclaration(functionNode.parent) && ts.isIdentifier(functionNode.parent.name)) {
    return functionNode.parent.name.text;
  }
  return null;
}

function collectIndirectFrontendCallers(sources, routes) {
  const callers = [];
  const wrappers = [];

  for (const source of sources) {
    if (source.relativePath.startsWith("src/app/api/")) continue;
    const sourceFile = parseSource(source);
    const initializers = collectUniqueInitializers(sourceFile);
    const role = sourceRole(sourceFile, source.relativePath);
    const fileWrappers = [];

    function findWrappers(node) {
      if (isFetchCall(node) && node.arguments.length > 0) {
        const methodResult = resolveFetchMethod(node.arguments[1], initializers);
        const target = unwrapExpression(node.arguments[0]);
        if (methodResult.method && MUTATION_METHODS.has(methodResult.method) && ts.isIdentifier(target)) {
          const functionNode = enclosingFunction(node);
          const name = functionNode ? callableName(functionNode) : null;
          const parameterIndex = functionNode
            ? functionNode.parameters.findIndex(
              (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === target.text,
            )
            : -1;
          if (name && parameterIndex >= 0) {
            const fetchLocation = locationOf(sourceFile, node);
            fileWrappers.push({
              name,
              method: methodResult.method,
              parameterIndex,
              fetchLine: fetchLocation.line,
              fetchColumn: fetchLocation.column,
            });
          }
        }
      }
      ts.forEachChild(node, findWrappers);
    }
    findWrappers(sourceFile);

    for (const wrapper of fileWrappers) {
      wrappers.push({ file: source.relativePath, ...wrapper });
    }
    if (fileWrappers.length === 0) continue;

    function findCalls(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        for (const wrapper of fileWrappers.filter((item) => item.name === node.expression.text)) {
          const targetArgument = node.arguments[wrapper.parameterIndex];
          if (!targetArgument) continue;
          const targetPattern = resolveTargetPattern(targetArgument, initializers);
          const apiPath = normalizedApiPath(targetPattern);
          if (!apiPath) continue;
          const location = locationOf(sourceFile, node);
          const matchedRouteIds = routes
            .filter((route) => route.method === wrapper.method && routeMatchesCaller(route.apiPath, apiPath))
            .map((route) => route.id)
            .sort(compareUtf8);
          callers.push({
            id: `${wrapper.method} ${source.relativePath}:${location.line}:${location.column} via ${wrapper.name}`,
            kind: "indirect-wrapper",
            method: wrapper.method,
            apiPath,
            classification: classifyApiPath(apiPath),
            file: source.relativePath,
            line: location.line,
            column: location.column,
            sourceRole: role,
            targetExpression: targetArgument.getText(sourceFile),
            targetPattern,
            matchedRouteIds,
            viaFetch: {
              function: wrapper.name,
              file: source.relativePath,
              line: wrapper.fetchLine,
              column: wrapper.fetchColumn,
            },
          });
        }
      }
      ts.forEachChild(node, findCalls);
    }
    findCalls(sourceFile);
  }

  callers.sort((left, right) =>
    compareUtf8(left.file, right.file)
      || left.line - right.line
      || left.column - right.column,
  );
  wrappers.sort((left, right) =>
    compareUtf8(left.file, right.file)
      || left.fetchLine - right.fetchLine
      || left.fetchColumn - right.fetchColumn,
  );
  return { callers, wrappers };
}

function countsByClassification(items) {
  return Object.fromEntries(CLASSIFICATIONS.map((classification) => [
    classification,
    items.filter((item) => item.classification === classification).length,
  ]));
}

function countsByMethod(items) {
  return Object.fromEntries([...MUTATION_METHODS].map((method) => [
    method,
    items.filter((item) => item.method === method).length,
  ]));
}

function sourceDigest(sources) {
  const hash = createHash("sha256");
  for (const source of sources) {
    hash.update(source.relativePath);
    hash.update("\0");
    hash.update(source.text);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function gitHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function buildInventory() {
  const sources = readSources();
  const releaseInputs = captureReleaseInputSnapshot(repositoryRoot);
  const routes = collectRouteHandlers(sources);
  const { callers: directCallers, unresolvedInternalFetchMethods, mutationFetchesOutsideInternalApi } =
    collectFrontendMutationCallers(sources, routes);
  const { callers: indirectCallers, wrappers: indirectFetchWrappers } =
    collectIndirectFrontendCallers(sources, routes);
  const callers = [...directCallers, ...indirectCallers]
    .sort((left, right) =>
      compareUtf8(left.file, right.file)
        || left.line - right.line
        || left.column - right.column,
    );
  const mutationFetchCalls = [...directCallers, ...mutationFetchesOutsideInternalApi]
    .sort((left, right) =>
      compareUtf8(left.file, right.file)
        || left.line - right.line
        || left.column - right.column,
    );
  const routeIdsWithCaller = new Set(callers.flatMap((caller) => caller.matchedRouteIds));
  const routesWithoutStaticFrontendCaller = routes
    .filter((route) => !routeIdsWithCaller.has(route.id))
    .map((route) => route.id);
  const unmatchedMutationCallers = callers
    .filter((caller) => caller.matchedRouteIds.length === 0)
    .map((caller) => caller.id);

  return {
    schemaVersion: 2,
    evidenceLevel: "static-contract",
    scope: {
      routeRoot: "src/app/api",
      callerRoot: "src (excluding src/app/api)",
      mutationMethods: [...MUTATION_METHODS],
      providerPrefixes: PROVIDER_PREFIXES,
      note: "Frontend caller scope is a safe superset: every non-API source module is scanned and sourceRole records whether it is a client, frontend, app UI, or shared module.",
    },
    snapshot: {
      gitHead: gitHead(),
      sourceDigestSha256: sourceDigest(sources),
      generatorSha256: sha256(readFileSync(scriptPath, "utf8")),
      sourceFilesRead: sources.length,
      releaseInputDigestSha256: releaseInputs.digestSha256,
      releaseInputFilesRead: releaseInputs.filesRead,
      releaseInputDirectories: releaseInputs.directories,
      releaseInputConfigBoundaries: releaseInputs.configBoundaries,
      releaseInputRuntimeEnvironmentBoundary: releaseInputs.runtimeEnvironmentBoundary,
    },
    summary: {
      routeHandlers: routes.length,
      routeFiles: new Set(routes.map((route) => route.file)).size,
      mutationFetchCalls: mutationFetchCalls.length,
      frontendMutationCallers: callers.length,
      directFrontendMutationCallers: directCallers.length,
      indirectFrontendMutationCallers: indirectCallers.length,
      routeHandlersByMethod: countsByMethod(routes),
      mutationFetchCallsByMethod: countsByMethod(mutationFetchCalls),
      frontendCallersByMethod: countsByMethod(callers),
      routeHandlersByClassification: countsByClassification(routes),
      mutationFetchCallsByClassification: countsByClassification(mutationFetchCalls),
      frontendCallersByClassification: countsByClassification(callers),
      routesWithoutStaticFrontendCaller: routesWithoutStaticFrontendCaller.length,
      unmatchedMutationCallers: unmatchedMutationCallers.length,
      unresolvedInternalFetchMethods: unresolvedInternalFetchMethods.length,
      mutationFetchesOutsideInternalApi: mutationFetchesOutsideInternalApi.length,
      indirectFetchWrappers: indirectFetchWrappers.length,
    },
    routes,
    mutationFetchCalls,
    frontendCallers: callers,
    diagnostics: {
      unmatchedMutationCallers,
      routesWithoutStaticFrontendCaller,
      unresolvedInternalFetchMethods,
      mutationFetchesOutsideInternalApi,
      indirectFetchWrappers,
    },
  };
}

function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function callerTable(callers) {
  if (callers.length === 0) return "None.\n";
  const rows = callers.map((caller) =>
    `| ${caller.method} | \`${markdownCell(caller.apiPath)}\` | \`${markdownCell(caller.file)}:${caller.line}\` | ${caller.matchedRouteIds.length ? "matched" : "unmatched"} |`,
  );
  return [
    "| Method | API path | Caller | Route match |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function routeTable(routes) {
  if (routes.length === 0) return "None.\n";
  const rows = routes.map((route) =>
    `| ${route.method} | \`${markdownCell(route.apiPath)}\` | \`${markdownCell(route.file)}:${route.line}\` |`,
  );
  return [
    "| Method | API path | Handler |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function buildMarkdown(inventory) {
  const directCallers = inventory.frontendCallers.filter((item) => item.classification === "direct-provider");
  const workbenchCallers = inventory.frontendCallers.filter((item) => item.classification === "workbench");
  const directRoutes = inventory.routes.filter((item) => item.classification === "direct-provider");
  const workbenchRoutes = inventory.routes.filter((item) => item.classification === "workbench");
  const routeCounts = inventory.summary.routeHandlersByClassification;
  const fetchCounts = inventory.summary.mutationFetchCallsByClassification;
  const callerCounts = inventory.summary.frontendCallersByClassification;
  const routeMethodCounts = inventory.summary.routeHandlersByMethod;
  const callerMethodCounts = inventory.summary.frontendCallersByMethod;

  return `# Mutation API inventory baseline

This file is generated by \`scripts/control-plane/inventory-mutations.mjs\`. Do not edit it manually.

## Evidence boundary

- Evidence level: \`static-contract\`.
- Git HEAD: \`${inventory.snapshot.gitHead}\`.
- Source digest: \`${inventory.snapshot.sourceDigestSha256}\`.
- Generator digest: \`${inventory.snapshot.generatorSha256}\`.
- Source files read: ${inventory.snapshot.sourceFilesRead}.
- Release-input digest: \`${inventory.snapshot.releaseInputDigestSha256}\`.
- Release-input files read: ${inventory.snapshot.releaseInputFilesRead}.
- Release-input scope: \`${inventory.snapshot.releaseInputDirectories.join("`, `")}\`, plus every root file. Files are discovered from the live filesystem, so tracked and untracked inputs are both covered.
- Secret-safe config boundary: values are fingerprinted only for \`NODE_ENV\`, \`AGENTIC_OS_*\`, and \`NEXT_PUBLIC_*\` keys that are not secret-classified. Secret-classified and other keys contribute presence only; unparsed non-comment lines fail closed. Live \`process.env\` is outside static inventory and requires live runtime verification.
- Scope: exported \`POST\`, \`PUT\`, \`PATCH\`, and \`DELETE\` handlers under \`src/app/api\`, plus mutation \`fetch\` calls in every non-API module under \`src\`.
- This inventory proves source wiring only. It does not prove that a route, provider, process, or tool works at runtime.

## Snapshot summary

| Classification | Route handlers | Internal API callers | All mutation fetch calls |
|---|---:|---:|---:|
| direct-provider | ${routeCounts["direct-provider"]} | ${callerCounts["direct-provider"]} | ${fetchCounts["direct-provider"]} |
| workbench | ${routeCounts.workbench} | ${callerCounts.workbench} | ${fetchCounts.workbench} |
| other | ${routeCounts.other} | ${callerCounts.other} | ${fetchCounts.other} |
| **Total** | **${inventory.summary.routeHandlers}** | **${inventory.summary.frontendMutationCallers}** | **${inventory.summary.mutationFetchCalls}** |

Current static source contains ${callerCounts["direct-provider"]} direct-provider mutation callers and ${callerCounts.workbench} Workbench mutation callers. Counts are not runtime proof.

| Method | Route handlers | Internal API callers |
|---|---:|---:|
| POST | ${routeMethodCounts.POST} | ${callerMethodCounts.POST} |
| PUT | ${routeMethodCounts.PUT} | ${callerMethodCounts.PUT} |
| PATCH | ${routeMethodCounts.PATCH} | ${callerMethodCounts.PATCH} |
| DELETE | ${routeMethodCounts.DELETE} | ${callerMethodCounts.DELETE} |

## Workbench mutation handlers

${routeTable(workbenchRoutes)}
## Workbench frontend callers

${callerTable(workbenchCallers)}
## Direct-provider mutation handlers

${routeTable(directRoutes)}
## Direct-provider frontend callers

${callerTable(directCallers)}
## Coverage diagnostics

- Route handlers without a statically matched frontend caller: ${inventory.summary.routesWithoutStaticFrontendCaller}.
- Mutation callers without a matching route handler: ${inventory.summary.unmatchedMutationCallers}.
- Internal fetch calls with an unresolved method: ${inventory.summary.unresolvedInternalFetchMethods}.
- Mutation fetch calls whose target is external or cannot be resolved as same-origin \`/api/*\`: ${inventory.summary.mutationFetchesOutsideInternalApi}.
- Local mutation fetch wrappers expanded to literal internal API call sites: ${inventory.summary.indirectFetchWrappers} wrappers, ${inventory.summary.indirectFrontendMutationCallers} caller records.

Full route, caller, match, and diagnostic records are in \`docs/control-plane/mutation-inventory.json\`.

## Reproduce

\`\`\`powershell
node scripts/control-plane/inventory-mutations.mjs
node scripts/control-plane/inventory-mutations.mjs --check
\`\`\`
`;
}

function writeOrCheck(filePath, content) {
  if (checkOnly) {
    if (!existsSync(filePath)) throw new Error(`Inventory output is missing: ${relativeToRepository(filePath)}`);
    const existing = readFileSync(filePath, "utf8");
    if (existing !== content) throw new Error(`Inventory output is stale: ${relativeToRepository(filePath)}`);
    return;
  }
  writeFileSync(filePath, content, "utf8");
}

try {
  const inventory = buildInventory();
  const json = `${JSON.stringify(inventory, null, 2)}\n`;
  const markdown = buildMarkdown(inventory);
  if (!checkOnly) mkdirSync(outputDirectory, { recursive: true });
  writeOrCheck(jsonPath, json);
  writeOrCheck(markdownPath, markdown);
  process.stdout.write(`${checkOnly ? "verified" : "wrote"} ${relativeToRepository(jsonPath)} (${inventory.summary.routeHandlers} handlers, ${inventory.summary.frontendMutationCallers} callers)\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`mutation inventory failed: ${message}\n`);
  process.exitCode = 1;
}
