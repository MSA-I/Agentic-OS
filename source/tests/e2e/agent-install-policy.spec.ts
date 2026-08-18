import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * The boundary around the two routes that can run a command chosen by a model.
 *
 * Every probe here is refused before anything spawns, so the spec installs
 * nothing and leaves no state behind — the same property that makes
 * graphify-command-policy.spec.ts safe to run anywhere.
 */

const PLAN = "/api/setup/agent-install/plan";
const STEP = "/api/setup/agent-install/step";

/** Mints the Path=/api/setup capability cookie the way the panel does. */
async function capability(request: APIRequestContext): Promise<void> {
  const response = await request.get("/api/setup");
  expect(response.status(), await response.text()).toBe(200);
}

const COMMAND_STEP = {
  kind: "command",
  program: "npm",
  args: ["install", "-g", "left-pad@1.3.0"],
  why: "probe",
  timeoutSeconds: 900,
};

test.describe("agent install policy", () => {
  test("both routes refuse a cross-origin caller and one with no Origin", async ({ request }) => {
    for (const path of [PLAN, STEP]) {
      const crossOrigin = await request.post(path, {
        headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
        data: {},
      });
      expect(crossOrigin.status(), `${path}: ${await crossOrigin.text()}`).toBe(403);
      expect(await crossOrigin.json()).toMatchObject({ code: "origin_mismatch" });

      const noOrigin = await request.post(path, {
        headers: { "Content-Type": "application/json" },
        data: {},
      });
      expect(noOrigin.status()).toBe(403);
      expect(await noOrigin.json()).toMatchObject({ code: "origin_required" });
    }
  });

  test("without the setup capability cookie neither route is reachable", async ({ browser, baseURL }) => {
    // A context that has never called GET /api/setup has no capability cookie.
    const context = await browser.newContext({ baseURL });
    const response = await context.request.post(PLAN, {
      headers: { Origin: new URL(baseURL!).origin, "Content-Type": "application/json" },
      data: { route: "/opencode", steps: [COMMAND_STEP] },
    });
    expect(response.status(), await response.text()).toBe(403);
    await context.close();
  });

  test("a non-JSON body and an oversized body are refused before any parsing", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await capability(request);

    const nonJson = await request.post(PLAN, {
      headers: { Origin: origin, "Content-Type": "text/plain" },
      data: "steps",
    });
    expect(nonJson.status()).toBe(415);

    const oversized = await request.post(PLAN, {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: { route: "/opencode", steps: [{ ...COMMAND_STEP, why: "x".repeat(30_000) }] },
    });
    expect(oversized.status()).toBe(413);
  });

  test("a plan naming a program outside the allowlist is refused at approval", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await capability(request);

    const hostile = [
      { ...COMMAND_STEP, program: "bash", args: ["-c", "echo hi"] },
      { ...COMMAND_STEP, program: "powershell", args: ["-Command", "ls"] },
      { ...COMMAND_STEP, args: ["install", "a && b"] },
      { ...COMMAND_STEP, args: ["run", "postinstall"] },
      { ...COMMAND_STEP, args: ["install", "C:/windows/system32"] },
      { kind: "command", program: "git", args: ["clone", "ssh://git@example.com/x"], why: "probe", timeoutSeconds: 900 },
    ];
    for (const step of hostile) {
      const response = await request.post(PLAN, {
        headers: { Origin: origin, "Content-Type": "application/json" },
        data: { route: "/opencode", steps: [step] },
      });
      expect(response.status(), `${JSON.stringify(step)} was accepted`).toBe(403);
      expect(await response.json()).toMatchObject({ code: "plan_rejected" });
    }
  });

  test("an unknown service and an unknown request field are refused", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await capability(request);

    const unknownRoute = await request.post(PLAN, {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: { route: "/not-a-service", steps: [COMMAND_STEP] },
    });
    expect(unknownRoute.status()).toBe(404);

    const extraField = await request.post(PLAN, {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: { route: "/opencode", steps: [COMMAND_STEP], cwd: "C:/" },
    });
    expect(extraField.status()).toBe(400);
  });

  // The reason the plan token exists: an execution request carries no program
  // and no argument, so there is nothing in it to smuggle a command through.
  test("the step route accepts no program or argument, only a plan id and index", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await capability(request);

    const smuggled = await request.post(STEP, {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: { planId: "a".repeat(24), stepIndex: 0, program: "bash", args: ["-c", "echo hi"] },
    });
    expect(smuggled.status()).toBe(400);
    expect(await smuggled.json()).toMatchObject({ error: "Unknown request field." });

    const unknownPlan = await request.post(STEP, {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: { planId: "a".repeat(24), stepIndex: 0 },
    });
    expect(unknownPlan.status()).toBe(403);
    expect(await unknownPlan.json()).toMatchObject({ code: "plan_unknown" });

    const malformedId = await request.post(STEP, {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: { planId: "../../etc", stepIndex: 0 },
    });
    expect(malformedId.status()).toBe(400);
  });

  test("a stored plan runs its steps once each, by index", async ({ request, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await capability(request);

    // Manual steps only: the plan is stored and claimed without spawning
    // anything, which is what lets this assertion run anywhere.
    const stored = await request.post(PLAN, {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: {
        route: "/opencode",
        steps: [{ kind: "manual", instruction: "do it yourself", why: "probe" }],
      },
    });
    expect(stored.status(), await stored.text()).toBe(200);
    const { planId, runnable } = await stored.json();
    expect(runnable).toBe(0);

    const manual = await request.post(STEP, {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: { planId, stepIndex: 0 },
    });
    expect(manual.status()).toBe(409);
    expect(await manual.json()).toMatchObject({ code: "step_not_runnable" });

    const outOfRange = await request.post(STEP, {
      headers: { Origin: origin, "Content-Type": "application/json" },
      data: { planId, stepIndex: 7 },
    });
    expect(outOfRange.status()).toBe(400);
    expect(await outOfRange.json()).toMatchObject({ code: "step_out_of_range" });
  });
});
