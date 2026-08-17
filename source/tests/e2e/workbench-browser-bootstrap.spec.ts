import { expect, test } from "@playwright/test";

function bootstrapSecret(): string {
  const secret = process.env.AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET;
  if (!secret) throw new Error("AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET is required.");
  return secret;
}

// The launcher opens exactly one navigation carrying the bootstrap token. This
// is the only way a browser can obtain a Workbench session, so it is also the
// only reason Codex and Claude can be started from the UI.
test.describe("Workbench browser bootstrap", () => {
  test("denies a missing or wrong token", async ({ request }) => {
    const missing = await request.get("/api/workbench/session/bootstrap", { maxRedirects: 0 });
    expect(missing.status()).toBe(401);

    const wrong = await request.get("/api/workbench/session/bootstrap?token=not-the-secret", { maxRedirects: 0 });
    expect(wrong.status()).toBe(401);
  });

  test("exchanges one navigation for HttpOnly cookies and a usable session", async ({ request, baseURL }) => {
    const response = await request.get(
      `/api/workbench/session/bootstrap?token=${encodeURIComponent(bootstrapSecret())}`,
      { maxRedirects: 0 },
    );
    expect(response.status(), await response.text()).toBe(303);
    expect(response.headers().location).toBe("/");

    const cookies = response.headersArray()
      .filter((header) => header.name.toLowerCase() === "set-cookie")
      .map((header) => header.value);
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Path=/api/workbench");
      expect(cookie).not.toContain(bootstrapSecret());
    }

    // The issued session must be immediately usable by the UI client's rotate call.
    const rotate = await request.get("/api/workbench/session", {
      headers: { Origin: new URL(baseURL!).origin },
    });
    expect(rotate.status(), await rotate.text()).toBe(200);
  });

  test("never redirects off this app", async ({ request }) => {
    const external = await request.get(
      `/api/workbench/session/bootstrap?token=${encodeURIComponent(bootstrapSecret())}&next=https://attacker.example/`,
      { maxRedirects: 0 },
    );
    expect(external.status()).toBe(303);
    expect(external.headers().location).toBe("/");

    const protocolRelative = await request.get(
      `/api/workbench/session/bootstrap?token=${encodeURIComponent(bootstrapSecret())}&next=//attacker.example/`,
      { maxRedirects: 0 },
    );
    expect(protocolRelative.status()).toBe(303);
    expect(protocolRelative.headers().location).toBe("/");
  });
});
