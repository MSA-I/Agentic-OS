import { createHash, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
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

const {
  loadOrCreateMachineRecoveryKeyring,
} = await import("./machineRecoveryKeyring.ts");
const directory = process.env.AGENT_OS_TEST_KEYRING_DIRECTORY;
if (!directory) throw new Error("AGENT_OS_TEST_KEYRING_DIRECTORY is required.");
let requestText = "";
for await (const chunk of process.stdin) requestText += chunk;
const request = JSON.parse(requestText || "{}");
const keyring = loadOrCreateMachineRecoveryKeyring({
  directory,
  bootstrapSecret: request.bootstrapSecret,
});
const recoveryKeyId = (secret) => createHmac("sha256", Buffer.from(secret, "utf8"))
  .update("agent-os/windows-job-recovery/key-id/v1", "utf8")
  .digest("hex");
const deriveLegacyBootstrapRecoverySecret = (bootstrapSecret) => {
  if (typeof bootstrapSecret !== "string" || bootstrapSecret.length < 32) return null;
  return createHash("sha256")
    .update("agent-os:wave3:windows-job-recovery\0", "utf8")
    .update(bootstrapSecret, "utf8")
    .digest("base64url");
};
const sentinel = typeof request.sentinel === "string" ? request.sentinel : "";
const derivedSentinel = sentinel
  ? deriveLegacyBootstrapRecoverySecret(sentinel) ?? ""
  : "";
process.stdout.write(JSON.stringify({
  primaryId: createHash("sha256").update(keyring.primarySecret, "utf8").digest("hex"),
  candidateCount: keyring.recoverySecrets.length,
  recoveryKeyIds: keyring.recoverySecrets.map(recoveryKeyId).sort(),
  storagePath: keyring.storagePath,
  argvContainsSentinel: Boolean(sentinel) && process.argv.some((value) => value.includes(sentinel)),
  environmentContainsSentinel: Boolean(sentinel)
    && Object.values(process.env).some((value) => value?.includes(sentinel)),
  argvContainsDerivedSentinel: Boolean(derivedSentinel)
    && process.argv.some((value) => value.includes(derivedSentinel)),
  environmentContainsDerivedSentinel: Boolean(derivedSentinel)
    && Object.values(process.env).some((value) => value?.includes(derivedSentinel)),
}));
