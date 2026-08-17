import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const RELEASE_INPUT_DIRECTORIES = ["public", "scripts", "src", "tests"];
const SECRET_SAFE_JSON_FILES = new Set(["agentic-os.config.json"]);
const SECRET_SAFE_KEY_VALUE_FILES = new Set([".npmrc", ".pnpmrc", ".yarnrc"]);
const EXPOSED_ENV_VALUE_KEYS = new Set(["NODE_ENV"]);
const SECRET_KEY_TOKENS = new Set([
  "access",
  "api",
  "auth",
  "credential",
  "cookie",
  "key",
  "pass",
  "password",
  "private",
  "secret",
  "session",
  "token",
]);

export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), "utf8"), Buffer.from(String(right), "utf8"));
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function relativeToRepository(repositoryRoot, filePath) {
  return toPosix(path.relative(repositoryRoot, filePath));
}

function listFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolutePath));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

function redactedPresence(value) {
  return String(value).trim().length === 0 ? "<redacted:empty>" : "<redacted:present>";
}

function isSecretKey(key) {
  const tokens = String(key)
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
  if (tokens.some((token) => SECRET_KEY_TOKENS.has(token))) return true;
  const fused = tokens.join("");
  return /^(?:api|access|auth|private)(?:key|token)$/u.test(tokens.at(-1) ?? "")
    || /(?:apikey|accesskey|authtoken|privatekey|clientsecret|connectionstring|databaseurl|dsn)$/u.test(fused);
}

function canonicalizeJson(value, parentKey = "") {
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item, parentKey));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareUtf8)
        .map((key) => [
          key,
          isSecretKey(key)
            ? redactedPresence(value[key])
            : canonicalizeJson(value[key], key),
        ]),
    );
  }
  if (isSecretKey(parentKey)) return redactedPresence(value);
  return value;
}

function secretSafeJsonSnapshot(absolutePath) {
  let value;
  try {
    value = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`Secret-safe config parsing failed for ${path.basename(absolutePath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Buffer.from(`${JSON.stringify(canonicalizeJson(value))}\n`, "utf8");
}

function secretSafeKeyValueSnapshot(absolutePath, exposeKnownNonSecretValues) {
  const values = new Map();
  for (const rawLine of readFileSync(absolutePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const match = exposeKnownNonSecretValues
      ? /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/u.exec(line)
      : /^([^=\s][^=]*?)\s*=\s*(.*)$/u.exec(line);
    if (!match) {
      throw new Error(`Secret-safe config parsing failed for ${path.basename(absolutePath)}: unrecognized non-comment line.`);
    }
    const key = match[1].trim();
    const rawValue = match[2];
    const exposeValue = exposeKnownNonSecretValues
      && (EXPOSED_ENV_VALUE_KEYS.has(key) || key.startsWith("AGENTIC_OS_") || key.startsWith("NEXT_PUBLIC_"))
      && !isSecretKey(key);
    values.set(key, exposeValue ? rawValue : redactedPresence(rawValue));
  }
  const canonical = [
    ...[...values]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`),
  ].join("\n");
  return {
    bytes: Buffer.from(`${canonical}\n`, "utf8"),
    keyCount: values.size,
  };
}

function rootFileSnapshot(absolutePath) {
  const name = path.basename(absolutePath);
  if (name.startsWith(".env")) {
    const safe = secretSafeKeyValueSnapshot(absolutePath, true);
    return {
      bytes: safe.bytes,
      configBoundary: {
        path: name,
        format: "dotenv",
        keyCount: safe.keyCount,
        includedValuePolicy: "NODE_ENV, AGENTIC_OS_* and NEXT_PUBLIC_* except secret-classified keys",
        otherValueCoverage: "presence-only; live runtime verification required",
        secretValueCoverage: "presence-only; live runtime verification required",
      },
    };
  }
  if (SECRET_SAFE_JSON_FILES.has(name)) {
    return {
      bytes: secretSafeJsonSnapshot(absolutePath),
      configBoundary: {
        path: name,
        format: "json",
        includedValuePolicy: "all values except secret-classified keys",
        secretValueCoverage: "presence-only; live runtime verification required",
      },
    };
  }
  if (SECRET_SAFE_KEY_VALUE_FILES.has(name)) {
    const safe = secretSafeKeyValueSnapshot(absolutePath, false);
    return {
      bytes: safe.bytes,
      configBoundary: {
        path: name,
        format: "key-value",
        keyCount: safe.keyCount,
        includedValuePolicy: "none",
        otherValueCoverage: "presence-only; live runtime verification required",
        secretValueCoverage: "presence-only; live runtime verification required",
      },
    };
  }
  return { bytes: readFileSync(absolutePath), configBoundary: null };
}

export function captureReleaseInputSnapshot(repositoryRoot) {
  const directoryFiles = RELEASE_INPUT_DIRECTORIES.flatMap((relativePath) =>
    listFiles(path.join(repositoryRoot, relativePath)),
  );
  const rootFiles = readdirSync(repositoryRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .sort((left, right) => compareUtf8(left.name, right.name))
    .map((entry) => path.join(repositoryRoot, entry.name));
  const configBoundaries = [];
  const files = [...new Set([...directoryFiles, ...rootFiles])]
    .map((absolutePath) => {
      const relativePath = relativeToRepository(repositoryRoot, absolutePath);
      const snapshot = path.dirname(absolutePath) === repositoryRoot
        ? rootFileSnapshot(absolutePath)
        : { bytes: readFileSync(absolutePath), configBoundary: null };
      if (snapshot.configBoundary) configBoundaries.push(snapshot.configBoundary);
      return { relativePath, bytes: snapshot.bytes };
    })
    .sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.relativePath);
    digest.update("\0");
    digest.update(file.bytes);
    digest.update("\0");
  }
  return {
    digestSha256: digest.digest("hex"),
    filesRead: files.length,
    directories: RELEASE_INPUT_DIRECTORIES,
    configBoundaries: configBoundaries.sort((left, right) => compareUtf8(left.path, right.path)),
    runtimeEnvironmentBoundary: {
      source: "process.env",
      valueCoverage: "not fingerprinted by static inventory; live runtime verification required",
    },
  };
}
