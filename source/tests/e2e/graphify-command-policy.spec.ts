import path from "node:path";
import { expect, test } from "@playwright/test";

// `POST /api/graphify/run` is the one execution-capable route deliberately kept
// live instead of frozen. These are the controls that stand in for the freeze;
// if any of them stops holding, the route must go back behind the manifest.
test.describe("graphify command policy", () => {
  test("rejects cross-origin, non-JSON and oversized requests", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;

    const crossOrigin = await request.post("/api/graphify/run", {
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      data: { command: "--version" },
    });
    expect(crossOrigin.status()).toBe(403);

    const nonJson = await request.post("/api/graphify/run", {
      headers: { Origin: origin, "Content-Type": "text/plain" },
      data: "command=--version",
    });
    expect(nonJson.status()).toBe(415);

    const oversized = await request.post("/api/graphify/run", {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: { command: "--version", padding: "x".repeat(70 * 1024) },
    });
    expect(oversized.status()).toBe(413);
  });

  test("only allowlisted commands and contained directories reach the binary", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const headers = { Origin: origin, "Content-Type": "application/json" };

    const unknownCommand = await request.post("/api/graphify/run", {
      headers,
      data: { command: "add https://example.com/paper.pdf", cwd: process.cwd() },
    });
    expect(unknownCommand.status(), await unknownCommand.text()).toBe(403);
    expect(await unknownCommand.json()).toMatchObject({ code: "graphify_command_denied" });

    const deniedArgument = await request.post("/api/graphify/run", {
      headers,
      data: { command: "query \"anything\" --neo4j-push bolt://localhost:7687", cwd: process.cwd() },
    });
    expect(deniedArgument.status(), await deniedArgument.text()).toBe(403);
    expect(await deniedArgument.json()).toMatchObject({ code: "graphify_command_denied" });

    // A refused directory must fail closed. Falling back to a default would run
    // the command somewhere the caller never asked for, and would make this test
    // pass only on machines where that default happens not to exist.
    const escapingDirectory = await request.post("/api/graphify/run", {
      headers,
      data: { command: "--version", cwd: process.platform === "win32" ? "C:\\Windows" : "/etc" },
    });
    expect(escapingDirectory.status(), await escapingDirectory.text()).toBe(403);
    expect(await escapingDirectory.json()).toMatchObject({ code: "graphify_directory_denied" });

    const missingDirectory = await request.post("/api/graphify/run", {
      headers,
      data: { command: "--version", cwd: path.join(process.cwd(), "no-such-directory-9f2b") },
    });
    expect(missingDirectory.status(), await missingDirectory.text()).toBe(403);
    expect(await missingDirectory.json()).toMatchObject({ code: "graphify_directory_denied" });
  });

  test("an allowlisted command runs, or reports the tool as missing", async ({ request, baseURL }) => {
    const response = await request.post("/api/graphify/run", {
      headers: { Origin: new URL(baseURL!).origin, "Content-Type": "application/json" },
      data: { command: "--version", cwd: process.cwd() },
    });
    // 200 when graphify is installed on this machine, 503 when it is not. Both
    // are truthful; a 500 or a hang is not.
    expect([200, 503]).toContain(response.status());
    if (response.status() === 503) {
      expect(await response.json()).toMatchObject({ code: "graphify_not_installed" });
      return;
    }
    const body = await response.json();
    expect(body).toMatchObject({ ok: true });
    expect(typeof body.stdout).toBe("string");
  });
});
