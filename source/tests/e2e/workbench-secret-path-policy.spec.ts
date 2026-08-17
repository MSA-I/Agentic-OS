import { expect, test } from "@playwright/test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isSensitivePath, resolveContainedExistingPathSync } from "../../src/lib/control-plane/pathSecurity";
import { sanitizeNativeArtifact } from "../../src/lib/control-plane/secretChannels";
import { redactRecord, redactText, StreamingRedactor } from "../../src/lib/workbench/redaction";

test.describe("Workbench secret and path policy", () => {
  test("denies secret-bearing file names", () => {
    for (const candidate of [
      ".env",
      ".env.local",
      "nested/auth.json",
      "keys/private.pem",
      ".ssh/id_ed25519",
      "vault-data/session.json",
    ]) {
      expect(isSensitivePath(candidate), candidate).toBe(true);
    }
    expect(isSensitivePath("src/app.ts")).toBe(false);
  });

  test("rejects traversal, absolute paths and reparse-point escapes", async () => {
    const scratch = path.join(os.tmpdir(), `agent-os-path-policy-${process.pid}-${Date.now()}`);
    const root = path.join(scratch, "root");
    const outside = path.join(scratch, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(root, "safe.txt"), "safe", "utf8");
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    try {
      expect(resolveContainedExistingPathSync(root, "safe.txt")).toMatchObject({ ok: true });
      expect(resolveContainedExistingPathSync(root, "../outside/secret.txt")).toEqual({ ok: false, reason: "outside-root" });
      expect(resolveContainedExistingPathSync(root, path.join(outside, "secret.txt"))).toEqual({ ok: false, reason: "absolute-path" });
      await symlink(outside, path.join(root, "junction"), process.platform === "win32" ? "junction" : "dir");
      expect(resolveContainedExistingPathSync(root, "junction/secret.txt")).toEqual({ ok: false, reason: "reparse-point" });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("redacts sentinel secrets in text, records, and chunked streams", () => {
    const sentinel = "sk-AGENTOS_SENTINEL_1234567890";
    expect(redactText(`api_key=${sentinel}`)).not.toContain(sentinel);
    expect(JSON.stringify(redactRecord({ password: sentinel, nested: { token: sentinel } }))).not.toContain(sentinel);

    const stream = new StreamingRedactor();
    const output = [
      stream.push("before\napi_key=sk-AGENTOS_"),
      stream.push("SENTINEL_1234567890\nafter"),
      stream.flush(),
    ].join("");
    expect(output).not.toContain(sentinel);
    expect(output).toContain("[REDACTED]");
  });

  test("rejects sensitive artifact paths and sanitizes artifact URI and metadata", () => {
    const sentinel = "ARTIFACT_SENTINEL_8kQ2mN7vR4xP9zL6";
    expect(sanitizeNativeArtifact({
      id: "codex:sensitive",
      kind: "text",
      label: ".env.local",
      uri: "file:///D:/workspace/.env.local",
      metadata: { relPath: ".env.local" },
    })).toBeNull();
    expect(sanitizeNativeArtifact({
      id: "codex:metadata-sensitive",
      kind: "text",
      label: "report.txt",
      uri: "file:///D:/workspace/report.txt",
      metadata: { source: "D:\\workspace\\vault-data\\credentials.json" },
    })).toBeNull();

    const safe = sanitizeNativeArtifact({
      id: "claude:published-report",
      kind: "html",
      label: `report api_key=${sentinel}`,
      uri: `https://user:${sentinel}@example.test/report?token=${sentinel}&view=summary`,
      metadata: { authorization: sentinel, source: "published", view: "summary" },
    });
    expect(safe).not.toBeNull();
    expect(JSON.stringify(safe)).not.toContain(sentinel);
    expect(safe?.uri).toContain("view=summary");
    expect(safe?.metadata).toMatchObject({ authorization: "[REDACTED]", source: "published", view: "summary" });
  });
});
