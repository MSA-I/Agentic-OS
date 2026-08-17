#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const EVIDENCE_LEVEL = Object.freeze({
  STATIC: "static-contract",
  LIVE: "current-live",
  HISTORICAL: "historical",
  BLOCKED: "blocked",
});

const PROVIDERS = ["codex", "claude", "hermes", "openclaw", "antigravity"];
const ACTIVE_STATUSES = ["queued", "running", "awaiting_approval"];
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(scriptDirectory, "..", "..");
const outerRoot = path.resolve(sourceRoot, "..");

function parsePositiveNumber(raw, label, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number.`);
  return value;
}

function parseArguments(argv) {
  const options = {
    baseUrl: null,
    output: null,
    requestTimeoutMs: 25_000,
    discoveryTimeoutMs: 3_000,
    stuckAfterMinutes: 15,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--help" || argument === "-h") return { ...options, help: true };
    if (argument === "--base-url") {
      if (!value) throw new Error("--base-url requires a value.");
      options.baseUrl = validateLoopbackBaseUrl(value);
      index += 1;
      continue;
    }
    if (argument === "--output") {
      if (!value) throw new Error("--output requires a value.");
      options.output = value;
      index += 1;
      continue;
    }
    if (argument === "--request-timeout-ms") {
      options.requestTimeoutMs = parsePositiveNumber(value, argument, options.requestTimeoutMs);
      index += 1;
      continue;
    }
    if (argument === "--discovery-timeout-ms") {
      options.discoveryTimeoutMs = parsePositiveNumber(value, argument, options.discoveryTimeoutMs);
      index += 1;
      continue;
    }
    if (argument === "--stuck-after-minutes") {
      options.stuckAfterMinutes = parsePositiveNumber(value, argument, options.stuckAfterMinutes);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/control-plane/collect-baseline.mjs [options]",
    "",
    "Read-only by default: evidence is printed to stdout and no application mutation endpoint is called.",
    "",
    "Options:",
    "  --base-url <url>             Explicit loopback AGENT-OS URL.",
    "  --output <path>              Explicitly write a new evidence file inside source/.",
    "  --request-timeout-ms <ms>    GET and CLI health timeout (default: 25000).",
    "  --discovery-timeout-ms <ms>  Server discovery timeout (default: 3000).",
    "  --stuck-after-minutes <n>    Stuck-run threshold (default: 15).",
    "  --help                       Show this help.",
  ].join("\n");
}

function validateLoopbackBaseUrl(raw) {
  const url = new URL(raw);
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname)) {
    throw new Error("Base URL must use http on 127.0.0.1, localhost, or [::1].");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Base URL must not contain credentials, a path, query, or fragment.");
  }
  return url.origin;
}

function roundMilliseconds(value) {
  return Math.max(0, Math.round(value * 10) / 10);
}

function safeNumber(value) {
  if (typeof value === "bigint") return Number(value);
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function redactText(value, limit = 240) {
  return String(value ?? "")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs]|Bearer)[-_ A-Za-z0-9.]{12,}\b/gi, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, limit);
}

function stripAnsi(value) {
  return String(value ?? "").replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function parseDotEnvValue(contents, key) {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] !== key) continue;
    const raw = match[2].trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }
    return raw;
  }
  return null;
}

async function resolveFoldersRoot() {
  const fromEnvironment = process.env.AGENTIC_OS_FOLDERS_ROOT?.trim();
  if (fromEnvironment) return { value: path.resolve(fromEnvironment), source: "environment" };

  const localEnvironmentPath = path.join(sourceRoot, ".env.local");
  if (existsSync(localEnvironmentPath)) {
    const value = parseDotEnvValue(await readFile(localEnvironmentPath, "utf8"), "AGENTIC_OS_FOLDERS_ROOT");
    if (value) return { value: path.resolve(value), source: ".env.local:selected-key-only" };
  }

  const configCandidates = [
    process.env.AGENTIC_OS_CONFIG,
    path.join(os.homedir(), ".agentic-os", "config.json"),
    path.join(sourceRoot, "agentic-os.config.json"),
  ].filter(Boolean);
  for (const candidate of configCandidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8"));
      if (typeof parsed.foldersRoot === "string" && parsed.foldersRoot.trim()) {
        return { value: path.resolve(parsed.foldersRoot.trim()), source: "config:selected-field-only" };
      }
    } catch {
      // A malformed config must not prevent the documented default from being inspected.
    }
  }

  return { value: path.join(os.homedir(), ".agentic-os", "folders"), source: "documented-default" };
}

function spawnCaptured(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = performance.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child;

    try {
      child = spawn(command, args, {
        cwd: sourceRoot,
        env: process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, error: String(error), stdout, stderr, exitCode: null, timedOut, latencyMs: roundMilliseconds(performance.now() - started) });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.unref();
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    const append = (current, chunk) => (current + chunk.toString("utf8")).slice(0, 64_000);
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: String(error), stdout, stderr, exitCode: null, timedOut, latencyMs: roundMilliseconds(performance.now() - started) });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: exitCode === 0 && !timedOut, error: null, stdout, stderr, exitCode, timedOut, latencyMs: roundMilliseconds(performance.now() - started) });
    });
  });
}

async function resolveExecutable(name) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = await spawnCaptured(locator, [name], 3_000);
  if (!result.ok) return null;
  const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (process.platform !== "win32") return candidates[0] ?? null;
  return candidates.find((candidate) => /\.(?:exe|cmd|bat|com)$/i.test(candidate)) ?? candidates[0] ?? null;
}

function quoteForPowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function runResolvedExecutable(executable, args, timeoutMs) {
  const extension = path.extname(executable).toLowerCase();
  if (process.platform === "win32" && [".cmd", ".bat", ".ps1"].includes(extension)) {
    const commandLine = ["&", quoteForPowerShell(executable), ...args.map(quoteForPowerShell)].join(" ");
    return spawnCaptured("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", commandLine], timeoutMs);
  }
  return spawnCaptured(executable, args, timeoutMs);
}

async function fixedCliProbe(name, args, timeoutMs, parser) {
  const executable = await resolveExecutable(name);
  if (!executable) {
    return {
      evidenceLevel: EVIDENCE_LEVEL.BLOCKED,
      status: "blocked",
      reason: "not-installed-or-not-on-path",
      command: `${name} ${args.join(" ")}`,
    };
  }

  const result = await runResolvedExecutable(executable, args, timeoutMs);
  const parsed = parser ? parser(`${result.stdout}\n${result.stderr}`, result) : {};
  const observedDespiteExit = parsed && parsed.observed === true;
  const evidenceLevel = result.ok || observedDespiteExit ? EVIDENCE_LEVEL.LIVE : EVIDENCE_LEVEL.BLOCKED;
  return {
    evidenceLevel,
    status: evidenceLevel === EVIDENCE_LEVEL.LIVE ? "observed" : "blocked",
    command: `${name} ${args.join(" ")}`,
    executable,
    exitCode: result.exitCode,
    latencyMs: result.latencyMs,
    ...(result.timedOut ? { reason: "timeout" } : {}),
    ...parsed,
  };
}

function versionParser(output) {
  const firstLine = stripAnsi(output).split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine ? { version: redactText(firstLine, 160) } : {};
}

function hermesHealthParser(output, result) {
  const cleanOutput = stripAnsi(output);
  const model = cleanOutput.match(/^\s*Model:\s*(.+)$/im)?.[1]?.trim() ?? null;
  const provider = cleanOutput.match(/^\s*Provider:\s*(.+)$/im)?.[1]?.trim() ?? null;
  return {
    observed: result.ok || Boolean(model || provider),
    model: model ? redactText(model, 120) : null,
    provider: provider ? redactText(provider, 120) : null,
  };
}

function openClawHealthParser(output, result) {
  const cleanOutput = stripAnsi(output);
  const gatewayObserved = /Gateway event loop:/i.test(cleanOutput);
  const agentsLine = cleanOutput.match(/Agents:\s*(.*)/i)?.[1] ?? "";
  const sessionCount = Number(cleanOutput.match(/\((\d+)\s+entries\)/i)?.[1] ?? NaN);
  const loopMaxMs = Number(cleanOutput.match(/max=(\d+)ms/i)?.[1] ?? NaN);
  const loopP99Ms = Number(cleanOutput.match(/p99=(\d+)ms/i)?.[1] ?? NaN);
  return {
    observed: result.ok || gatewayObserved,
    gatewayObserved,
    agentCount: agentsLine ? agentsLine.split(",").map((item) => item.trim()).filter(Boolean).length : null,
    sessionCount: Number.isFinite(sessionCount) ? sessionCount : null,
    loopMaxMs: Number.isFinite(loopMaxMs) ? loopMaxMs : null,
    loopP99Ms: Number.isFinite(loopP99Ms) ? loopP99Ms : null,
  };
}

function credentialPresence(provider) {
  const home = os.homedir();
  if (provider === "codex") {
    return existsSync(path.join(home, ".codex", "auth.json")) || Boolean(process.env.OPENAI_API_KEY);
  }
  if (provider === "claude") {
    return existsSync(path.join(home, ".claude", ".credentials.json")) || Boolean(process.env.ANTHROPIC_API_KEY);
  }
  return null;
}

async function collectRuntimeEvidence(requestTimeoutMs) {
  const specifications = {
    codex: { executable: "codex", versionArgs: ["--version"] },
    claude: { executable: "claude", versionArgs: ["--version"] },
    hermes: { executable: "hermes", versionArgs: ["--version"], healthArgs: ["status"], healthParser: hermesHealthParser },
    openclaw: { executable: "openclaw", versionArgs: ["--version"], healthArgs: ["health"], healthParser: openClawHealthParser },
    antigravity: { executable: "agy", versionArgs: ["--version"] },
  };

  const entries = await Promise.all(PROVIDERS.map(async (provider) => {
    const specification = specifications[provider];
    const version = await fixedCliProbe(specification.executable, specification.versionArgs, Math.min(requestTimeoutMs, 10_000), versionParser);
    let health;
    if (specification.healthArgs) {
      health = await fixedCliProbe(specification.executable, specification.healthArgs, requestTimeoutMs, specification.healthParser);
    } else {
      health = {
        evidenceLevel: EVIDENCE_LEVEL.BLOCKED,
        status: "blocked",
        reason: "no-safe-no-op-health-command-defined-for-wave-0",
      };
    }
    const configured = credentialPresence(provider);
    const credentialSignal = configured === null ? null : {
      evidenceLevel: EVIDENCE_LEVEL.LIVE,
      configured,
      meaning: "credential-presence-only-not-authentication-proof",
    };
    return [provider, {
      evidenceLevel: version.evidenceLevel,
      version,
      health,
      ...(credentialSignal ? { credentialSignal } : {}),
    }];
  }));

  return {
    evidenceLevel: EVIDENCE_LEVEL.LIVE,
    collectedBy: "fixed-read-only-cli-probes",
    providers: Object.fromEntries(entries),
    node: {
      evidenceLevel: EVIDENCE_LEVEL.LIVE,
      status: "observed",
      version: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
  };
}

async function gitCommand(args, { preserveLeadingWhitespace = false } = {}) {
  const result = await spawnCaptured("git", ["-C", sourceRoot, ...args], 5_000);
  if (!result.ok) throw new Error(`Git command failed: git ${args.join(" ")}`);
  return preserveLeadingWhitespace
    ? result.stdout.replace(/\s+$/u, "")
    : result.stdout.trim();
}

async function collectGitEvidence() {
  const [sha, branch, porcelain] = await Promise.all([
    gitCommand(["rev-parse", "HEAD"]),
    gitCommand(["branch", "--show-current"]),
    gitCommand(["status", "--porcelain=v1"], { preserveLeadingWhitespace: true }),
  ]);
  const lines = porcelain.split(/\r?\n/).filter(Boolean);
  return {
    evidenceLevel: EVIDENCE_LEVEL.STATIC,
    sha,
    branch: branch || null,
    worktree: {
      evidenceLevel: EVIDENCE_LEVEL.LIVE,
      dirty: lines.length > 0,
      changedEntryCount: lines.length,
      stagedEntryCount: lines.filter((line) => line[0] !== " " && line[0] !== "?").length,
      unstagedEntryCount: lines.filter((line) => line[1] !== " ").length,
      untrackedEntryCount: lines.filter((line) => line.startsWith("??")).length,
      note: "Counts only; unrelated paths are intentionally omitted from evidence.",
    },
  };
}

function rowsToObject(rows, keyName, valueName = "count") {
  return Object.fromEntries(rows.map((row) => [String(row[keyName]), safeNumber(row[valueName])]));
}

function ageMilliseconds(timestamp, nowMs) {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
}

async function collectWorkbenchDatabaseEvidence(stuckAfterMinutes) {
  const foldersRoot = await resolveFoldersRoot();
  const databasePath = path.join(foldersRoot.value, "AGENT_OS", "data", "workbench.sqlite3");
  if (!existsSync(databasePath)) {
    return {
      evidenceLevel: EVIDENCE_LEVEL.BLOCKED,
      status: "blocked",
      reason: "workbench-database-not-found",
      pathResolutionSource: foldersRoot.source,
    };
  }

  const databaseFile = await stat(databasePath);
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - stuckAfterMinutes * 60_000).toISOString();
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
    const tableRows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const tables = new Set(tableRows.map((row) => String(row.name)));
    if (!tables.has("workbench_runs")) {
      return {
        evidenceLevel: EVIDENCE_LEVEL.BLOCKED,
        status: "blocked",
        reason: "workbench-runs-table-not-found",
        pathResolutionSource: foldersRoot.source,
      };
    }

    const statusRows = database.prepare("SELECT status, COUNT(*) AS count FROM workbench_runs GROUP BY status ORDER BY status").all();
    const providerRows = database.prepare(`
      SELECT provider,
        COUNT(*) AS total,
        SUM(CASE WHEN actor_id IS NOT NULL AND actor_id <> '' THEN 1 ELSE 0 END) AS actor_count,
        SUM(CASE WHEN project_id IS NOT NULL AND project_id <> '' THEN 1 ELSE 0 END) AS project_count,
        SUM(CASE WHEN session_id IS NOT NULL AND session_id <> '' THEN 1 ELSE 0 END) AS session_count,
        SUM(CASE WHEN actor_id IS NOT NULL AND actor_id <> ''
                  AND project_id IS NOT NULL AND project_id <> ''
                  AND session_id IS NOT NULL AND session_id <> '' THEN 1 ELSE 0 END) AS fully_attributed
      FROM workbench_runs GROUP BY provider ORDER BY provider
    `).all();
    const stuckRows = database.prepare(`
      SELECT status, COUNT(*) AS count, MIN(updated_at) AS oldest_updated_at
      FROM workbench_runs
      WHERE status IN ('queued', 'running', 'awaiting_approval') AND updated_at <= ?
      GROUP BY status ORDER BY status
    `).all(cutoff);
    const activeRows = database.prepare(`
      SELECT r.status, r.updated_at, MAX(e.created_at) AS last_event_at
      FROM workbench_runs r
      LEFT JOIN workbench_events e ON e.run_id = r.id
      WHERE r.status IN ('queued', 'running', 'awaiting_approval')
      GROUP BY r.id, r.status, r.updated_at
    `).all();

    const eventLagValues = activeRows
      .map((row) => ageMilliseconds(String(row.last_event_at ?? row.updated_at), nowMs))
      .filter((value) => value !== null);
    const pendingMessages = tables.has("workbench_queued_messages")
      ? database.prepare(`
          SELECT COUNT(*) AS count, MIN(created_at) AS oldest_created_at
          FROM workbench_queued_messages WHERE delivered_at IS NULL
        `).get()
      : null;

    return {
      evidenceLevel: EVIDENCE_LEVEL.LIVE,
      status: "observed",
      accessMode: "sqlite-read-only-query-only",
      pathResolutionSource: foldersRoot.source,
      databaseFile: {
        evidenceLevel: EVIDENCE_LEVEL.LIVE,
        sizeBytes: databaseFile.size,
        modifiedAt: databaseFile.mtime.toISOString(),
      },
      runCountsByStatus: {
        evidenceLevel: EVIDENCE_LEVEL.LIVE,
        values: rowsToObject(statusRows, "status"),
      },
      stuckRuns: {
        evidenceLevel: EVIDENCE_LEVEL.LIVE,
        thresholdMinutes: stuckAfterMinutes,
        cutoff,
        total: stuckRows.reduce((sum, row) => sum + safeNumber(row.count), 0),
        byStatus: Object.fromEntries(stuckRows.map((row) => [String(row.status), {
          count: safeNumber(row.count),
          oldestUpdatedAt: row.oldest_updated_at ? String(row.oldest_updated_at) : null,
          oldestAgeMs: row.oldest_updated_at ? ageMilliseconds(String(row.oldest_updated_at), nowMs) : null,
        }])),
      },
      runAttributionSignals: {
        evidenceLevel: EVIDENCE_LEVEL.LIVE,
        byProvider: Object.fromEntries(providerRows.map((row) => [String(row.provider), {
          totalRuns: safeNumber(row.total),
          withActorId: safeNumber(row.actor_count),
          withProjectId: safeNumber(row.project_count),
          withNativeSessionId: safeNumber(row.session_count),
          fullyAttributed: safeNumber(row.fully_attributed),
        }])),
      },
      activeRunEventLag: {
        evidenceLevel: EVIDENCE_LEVEL.LIVE,
        activeRunCount: activeRows.length,
        activeRunsWithoutEvents: activeRows.filter((row) => !row.last_event_at).length,
        maximumLagMs: eventLagValues.length ? Math.max(...eventLagValues) : null,
      },
      pendingMessages: pendingMessages ? {
        evidenceLevel: EVIDENCE_LEVEL.LIVE,
        count: safeNumber(pendingMessages.count),
        oldestCreatedAt: pendingMessages.oldest_created_at ? String(pendingMessages.oldest_created_at) : null,
        oldestAgeMs: pendingMessages.oldest_created_at ? ageMilliseconds(String(pendingMessages.oldest_created_at), nowMs) : null,
      } : {
        evidenceLevel: EVIDENCE_LEVEL.BLOCKED,
        status: "blocked",
        reason: "queued-messages-table-not-found",
      },
    };
  } catch (error) {
    return {
      evidenceLevel: EVIDENCE_LEVEL.BLOCKED,
      status: "blocked",
      reason: "workbench-database-read-failed",
      detail: redactText(error instanceof Error ? error.message : String(error)),
      pathResolutionSource: foldersRoot.source,
    };
  } finally {
    database?.close();
  }
}

async function getJson(baseUrl, pathname, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(new URL(pathname, baseUrl), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const latencyMs = roundMilliseconds(performance.now() - started);
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await response.json() : null;
    return {
      evidenceLevel: response.ok ? EVIDENCE_LEVEL.LIVE : EVIDENCE_LEVEL.BLOCKED,
      status: response.ok ? "observed" : "blocked",
      httpStatus: response.status,
      latencyMs,
      body,
      ...(response.ok ? {} : { reason: `http-${response.status}` }),
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      evidenceLevel: EVIDENCE_LEVEL.BLOCKED,
      status: "blocked",
      reason: timedOut ? "timeout" : "connection-failed",
      latencyMs: roundMilliseconds(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}

function isAgentOsSessionResponse(result) {
  return result.status === "observed"
    && result.body
    && typeof result.body === "object"
    && result.body.agent?.id === "codex"
    && typeof result.body.sessionCount === "number";
}

async function discoverAgentOsServer(explicitBaseUrl, discoveryTimeoutMs) {
  const candidates = explicitBaseUrl
    ? [explicitBaseUrl]
    : ["http://127.0.0.1:3000", "http://127.0.0.1:3100"];
  const attempts = [];
  for (const candidate of candidates) {
    const result = await getJson(candidate, "/api/workbench/agents/codex/sessions?limit=1&offset=0", discoveryTimeoutMs);
    attempts.push({
      evidenceLevel: result.evidenceLevel,
      baseUrl: candidate,
      status: isAgentOsSessionResponse(result) ? "agent-os-observed" : "blocked",
      httpStatus: result.httpStatus ?? null,
      latencyMs: result.latencyMs,
      reason: isAgentOsSessionResponse(result) ? null : result.reason ?? "unexpected-response-contract",
    });
    if (isAgentOsSessionResponse(result)) return { baseUrl: candidate, attempts };
  }
  return { baseUrl: null, attempts };
}

function sessionAttributionSignals(sessions, totalCount) {
  const safeSessions = Array.isArray(sessions) ? sessions : [];
  const withActorId = safeSessions.filter((session) => typeof session?.actorId === "string" && session.actorId.length > 0).length;
  const withProjectId = safeSessions.filter((session) => typeof session?.projectId === "string" && session.projectId.length > 0).length;
  const fullyAttributed = safeSessions.filter((session) => typeof session?.actorId === "string" && session.actorId.length > 0
    && typeof session?.projectId === "string" && session.projectId.length > 0).length;
  return {
    sampleSize: safeSessions.length,
    totalCount,
    sampleCoveragePercent: totalCount > 0 ? Math.round((safeSessions.length / totalCount) * 10_000) / 100 : 100,
    withActorId,
    withProjectId,
    fullyAttributed,
    withoutActorOrProject: safeSessions.length - safeSessions.filter((session) => session?.actorId || session?.projectId).length,
  };
}

function summarizeVitals(body) {
  if (!body || typeof body !== "object") return null;
  return Object.fromEntries(PROVIDERS.map((provider) => {
    const value = body[provider];
    if (!value || typeof value !== "object") {
      return [provider, { evidenceLevel: EVIDENCE_LEVEL.BLOCKED, status: "blocked", reason: "provider-missing-from-vitals" }];
    }
    const summary = {
      evidenceLevel: value.ok ? EVIDENCE_LEVEL.LIVE : EVIDENCE_LEVEL.BLOCKED,
      status: value.ok ? "observed" : "blocked",
      reportedOk: Boolean(value.ok),
      reportedLatencyMs: typeof value.latencyMs === "number" ? value.latencyMs : null,
    };
    if (provider === "claude" || provider === "antigravity") summary.version = redactText(value.version ?? "", 160) || null;
    if (provider === "hermes") {
      summary.model = redactText(value.model ?? "", 120) || null;
      summary.provider = redactText(value.provider ?? "", 120) || null;
    }
    if (provider === "openclaw") {
      summary.gateway = value.gateway ?? null;
      summary.degraded = Boolean(value.degraded);
      summary.busy = Boolean(value.busy);
      summary.sessionCount = typeof value.sessions === "number" ? value.sessions : null;
      summary.agentCount = Array.isArray(value.agents) ? value.agents.length : null;
    }
    return [provider, summary];
  }));
}

async function collectHttpEvidence(options) {
  const discovery = await discoverAgentOsServer(options.baseUrl, options.discoveryTimeoutMs);
  if (!discovery.baseUrl) {
    return {
      evidenceLevel: EVIDENCE_LEVEL.BLOCKED,
      status: "blocked",
      reason: "agent-os-server-not-available",
      discoveryAttempts: discovery.attempts,
      getLatencyProbes: {
        evidenceLevel: EVIDENCE_LEVEL.BLOCKED,
        status: "blocked",
        reason: "no-agent-os-server",
      },
      nativeSessionInventory: {
        evidenceLevel: EVIDENCE_LEVEL.BLOCKED,
        status: "blocked",
        reason: "no-agent-os-server",
      },
    };
  }

  const sessionEntries = await Promise.all(PROVIDERS.map(async (provider) => {
    const pathname = `/api/workbench/agents/${provider}/sessions?limit=100&offset=0`;
    const result = await getJson(discovery.baseUrl, pathname, options.requestTimeoutMs);
    if (result.status !== "observed" || !result.body || !Array.isArray(result.body.sessions)) {
      return [provider, {
        evidenceLevel: EVIDENCE_LEVEL.BLOCKED,
        status: "blocked",
        httpStatus: result.httpStatus ?? null,
        latencyMs: result.latencyMs,
        reason: result.reason ?? "unexpected-response-contract",
      }];
    }
    const totalCount = safeNumber(result.body.sessionCount);
    return [provider, {
      evidenceLevel: EVIDENCE_LEVEL.LIVE,
      status: "observed",
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      sessionCount: totalCount,
      returnedCount: safeNumber(result.body.returnedCount),
      attributionSignals: {
        evidenceLevel: EVIDENCE_LEVEL.LIVE,
        ...sessionAttributionSignals(result.body.sessions, totalCount),
      },
    }];
  }));

  const vitals = await getJson(discovery.baseUrl, "/api/vitals", options.requestTimeoutMs);
  const vitalsSummary = vitals.status === "observed"
    ? {
        evidenceLevel: EVIDENCE_LEVEL.LIVE,
        status: "observed",
        httpStatus: vitals.httpStatus,
        latencyMs: vitals.latencyMs,
        providers: summarizeVitals(vitals.body),
      }
    : {
        evidenceLevel: EVIDENCE_LEVEL.BLOCKED,
        status: "blocked",
        httpStatus: vitals.httpStatus ?? null,
        latencyMs: vitals.latencyMs,
        reason: vitals.reason,
      };

  return {
    evidenceLevel: EVIDENCE_LEVEL.LIVE,
    status: "observed",
    baseUrl: discovery.baseUrl,
    discoveryAttempts: discovery.attempts,
    getLatencyProbes: {
      evidenceLevel: EVIDENCE_LEVEL.LIVE,
      vitals: vitalsSummary,
      sessions: Object.fromEntries(sessionEntries.map(([provider, value]) => [provider, {
        evidenceLevel: value.evidenceLevel,
        status: value.status,
        httpStatus: value.httpStatus,
        latencyMs: value.latencyMs,
        ...(value.reason ? { reason: value.reason } : {}),
      }])),
      workbenchRuns: {
        evidenceLevel: EVIDENCE_LEVEL.BLOCKED,
        status: "blocked",
        reason: "intentionally-omitted-because-current-supervisor-initialization-can-write-orphan-state",
      },
    },
    nativeSessionInventory: {
      evidenceLevel: EVIDENCE_LEVEL.LIVE,
      providers: Object.fromEntries(sessionEntries),
      note: "Attribution metrics cover the returned page only; total count comes from the provider adapter.",
    },
  };
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function collectHistoricalEvidence() {
  const evidenceDirectory = path.join(outerRoot, "e2e-final");
  if (!existsSync(evidenceDirectory)) {
    return {
      evidenceLevel: EVIDENCE_LEVEL.HISTORICAL,
      status: "not-found",
      artifactCount: 0,
      artifacts: [],
    };
  }

  const names = await readdir(evidenceDirectory);
  const selected = names.filter((name) => /(?:report|route-crawl).*\.json$/i.test(name)).sort();
  const artifacts = [];
  for (const name of selected) {
    const filePath = path.join(evidenceDirectory, name);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) continue;
    artifacts.push({
      evidenceLevel: EVIDENCE_LEVEL.HISTORICAL,
      name,
      sizeBytes: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
      sha256: await sha256File(filePath),
      interpretation: "historical-artifact-only-not-current-runtime-proof",
    });
  }
  return {
    evidenceLevel: EVIDENCE_LEVEL.HISTORICAL,
    status: "inventoried",
    artifactCount: artifacts.length,
    artifacts,
  };
}

async function writeEvidenceFile(outputArgument, evidence) {
  const resolved = path.resolve(process.cwd(), outputArgument);
  const relative = path.relative(sourceRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("--output must resolve to a new file inside the source directory.");
  }
  if (existsSync(resolved)) throw new Error(`Refusing to overwrite existing evidence file: ${resolved}`);
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, resolved);
  return resolved;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const collectedAt = new Date().toISOString();
  const [git, runtime, workbenchDatabase, http, historical] = await Promise.all([
    collectGitEvidence(),
    collectRuntimeEvidence(options.requestTimeoutMs),
    collectWorkbenchDatabaseEvidence(options.stuckAfterMinutes),
    collectHttpEvidence(options),
    collectHistoricalEvidence(),
  ]);

  const evidence = {
    schemaVersion: {
      evidenceLevel: EVIDENCE_LEVEL.STATIC,
      value: "agent-os-wave-0-baseline/v1",
    },
    collectedAt: {
      evidenceLevel: EVIDENCE_LEVEL.LIVE,
      value: collectedAt,
    },
    safetyContract: {
      evidenceLevel: EVIDENCE_LEVEL.STATIC,
      defaultMode: "stdout-only",
      networkScope: "loopback-get-only",
      databaseScope: "sqlite-read-only-query-only",
      excludedActions: [
        "prompt-send",
        "run-start",
        "run-resume",
        "run-cancel",
        "approval-mutation",
        "tool-invocation",
        "workbench-database-write",
        "secret-value-read-or-output",
      ],
    },
    git,
    runtime,
    workbenchDatabase,
    http,
    historical,
    interpretationRules: {
      evidenceLevel: EVIDENCE_LEVEL.STATIC,
      levels: [EVIDENCE_LEVEL.STATIC, EVIDENCE_LEVEL.LIVE, EVIDENCE_LEVEL.HISTORICAL, EVIDENCE_LEVEL.BLOCKED],
      blockedIsNeverPass: true,
      configuredIsNotLiveVerified: true,
      timeoutQuotaAndNotInstalledRemainBlocked: true,
    },
  };

  if (options.output) {
    const outputPath = await writeEvidenceFile(options.output, evidence);
    process.stderr.write(`Evidence written: ${outputPath}\n`);
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${redactText(error instanceof Error ? error.message : String(error), 500)}\n`);
  process.exitCode = 1;
});
