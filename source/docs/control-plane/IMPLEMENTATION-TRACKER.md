# AGENT-OS Control-Plane Implementation Tracker

Authoritative plan:

`C:\Users\art1\.codex\visualizations\2026\08\13\019ffc17-3c91-77f1-898c-6c2ba49d666e\AGENT-OS-CONTROL-PLANE-REPAIR-PLAN.md`

## Mandatory Wave preflight

Before any Wave starts or resumes:

1. Read the authoritative plan completely.
2. Re-read the current Wave tasks and exit gate.
3. Inspect current Git status and preserve unrelated work.
4. Record current Git SHA, runtime/config versions, and evidence level.
5. Verify the prior Wave gate with current evidence. Historical evidence is not current proof.

Every future subagent prompt must include the authoritative plan path and require this preflight.

## Status

| Wave | State | Current evidence | Exit gate |
|---|---|---|---|
| 0 — Repository truth and baseline | Complete | `WAVE-0-CLEAN-TREE-GATE.json`, `WAVE-0-BASELINE-LIVE-2026-08-13.json`, `mutation-inventory.json` | Passed |
| 1 — Security and control foundation | Complete | `WAVE-1-POLICY-FREEZE-EVIDENCE.json`, `WAVE-1-PROVIDER-EXECUTION-SAFETY.json`, `WAVE-1-SECRET-CHANNELS-EVIDENCE.json` | Passed |
| 2 — Durable Workbench kernel | Complete | `WAVE-2-DURABLE-KERNEL-EVIDENCE.json`; 467/467 Node tests, 25/25 Playwright, build/typecheck/parser PASS, independent review P0=0/P1=0 | Passed |
| 3 — Restricted Codex/Claude pilot | In progress — blocked on Codex quota until 2026-08-20 08:02 | `WAVE-3-LIVE-CLAUDE-2026-08-17.json`: Claude live start/resume/verified cancel/restart PASS; Codex returns `provider_quota` and its CLI names the reset time, so its 2026-08-14 pass in `WAVE-3-RESTRICTED-PILOT-EVIDENCE.json` is historical. Audit repair: `WAVE-3-AUDIT-REPAIR-2026-08-17.json` | Blocked; Wave 4 remains closed |
| 4 — Tool Gateway pilot | Not started | None | Closed |
| 5 — Hermes/OpenClaw parity | Not started | None | Closed |
| 6 — Shared Project and Mission Control | Not started | None | Closed |
| 7 — Complete Tool Center | Not started | None | Closed |
| 8 — Operational E2E and cutover | Not started | None | Closed |

## Wave 7 input

`SKILLS-BUDGET-FINDING-2026-08-17.md` measures the skills sprawl that makes Codex drop every skill
description at session start: three near-identical roots, 85% duplicated, 646KB of descriptions against
a 2% context budget. It also records the empirically discovered `skills.config` schema and the finding
that no `skills.config` override changes the enumeration. AGENT-OS's own Codex runs are unaffected
because the adapter already sends `skills.config=[]`.

## Open defect plan

`DEFECT-PLAN-2026-08-17.md` holds five reported UI and telemetry defects with a verified root cause for
each. Three of them (Hermes model `unknown`, Token usage, Live activity) are one regression family: Wave 1
froze execution and Wave 3 moved real runs into the durable control plane, but the read-only surfaces still
read the old sources. D1 there is a regression that disables the whole vitals layer and should be fixed
first.

## Evidence rules

- `static-contract`: source or deterministic contract evidence only.
- `fake-runtime`: deterministic adapter evidence; never runtime proof.
- `live-runtime`: current execution against the installed provider/tool.
- `historical`: saved evidence from an earlier SHA, runtime, or date.
- `blocked`: quota, timeout, missing runtime, auth failure, or unavailable dependency. Never PASS.

Running the inventory check: `mutation-inventory.json` records the `gitHead` it was generated at, so
`--check` reports it stale immediately after any commit that contains it. Regenerate it as the last step
before staging, and treat a `gitHead`-only difference as that bookkeeping rather than a real drift.

## Worktree preservation

`../e2e-final/` existed before this implementation and is untracked. Do not delete, overwrite, move, or broadly stage it.

## Wave 0 closure — 2026-08-13

- Distribution: the dynamic Workbench sessions route is no longer ignored. The narrow ignore exception keeps all other session-data paths ignored.
- Clean-tree gate: prospective Git tree `3f5c90ac34eac9a24174249a95674b3ff97156a2` passed `npm ci`, `next build`, `workbench-native-adapters.spec.ts`, and `workbench-api.spec.ts` in isolated scratch state.
- Mutation inventory: 160 mutation handlers, 181 internal API caller sites, 62 direct-provider callers, and zero Workbench frontend callers at baseline.
- Current live baseline: AGENT-OS observed on loopback with current session counts and GET latency. Workbench DB contains nine queued runs older than 15 minutes and four pending messages. These are baseline failures, not PASS states.
- Provider evidence: Codex, Claude, Hermes, and OpenClaw versions observed; Hermes and OpenClaw safe health probes observed; Antigravity remains blocked because it is not installed.
- Historical Setup Center evidence remains labeled historical and is not used as current runtime proof.

## Wave 1 closure — 2026-08-13

- Evidence: `WAVE-1-POLICY-FREEZE-EVIDENCE.json`, `WAVE-1-PROVIDER-EXECUTION-SAFETY.json`, and `WAVE-1-SECRET-CHANNELS-EVIDENCE.json`.
- Static wiring: 109 frozen mutation routes exist in the current inventory, including `POST /api/room`. All 109 invoke `denyFrozenExecutionMutation` plus its immediate return before body parsing or handler side effects. The current scanner reports zero missing routes, zero unguarded routes, and zero unclassified execution candidates.
- Current checks: TypeScript PASS, Next production build PASS, 45/45 contract/unit tests PASS, 25/25 combined production-server security/provider/secret/freeze tests PASS, and `git diff --check` PASS.
- Runtime truth: matching and mismatched Workbench requests created no run; 13 representative direct execution routes fail closed. No provider start was attempted or claimed as live proof.
- Exit gate: passed because no execution path is exposed before identity, policy, containment, secret, executable, capability, and durable approval guards are live. Sentinel tests passed across storage, response/export, stream, artifact, and log boundaries. No security waiver is used.
- Remaining blocked capabilities: 128 frontend callers still target frozen execution routes, truthful disabled controls and draft preservation are incomplete, and Windows Job Object, durable approvals, and the Tool Gateway are not yet live. These are not presented as PASS capabilities; execution remains disabled until later Waves supply and verify them.

## Wave 2 closure — 2026-08-14

- Evidence: `WAVE-2-DURABLE-KERNEL-EVIDENCE.json`.
- Durable kernel: atomic queue admission, leases, fencing, generation CAS, recovery-first dequeue, restart-persistent circuit state, event quotas, snapshot/gap replay, compaction-safe create receipts, checksummed migrations, backup and restore passed current tests.
- Native containment: Windows processes start suspended, join the Job Object before resume, bind executable and working-directory identities, encrypt recovery material, reject status rollback/forks through a durable predecessor chain, arbitrate helper/controller ownership through one authenticated exclusive claim, and report completion or cancellation only after `ACTIVE_PROCESS_ZERO` or authenticated `no_process_created` proof.
- Artifact safety: handle-pinned Windows publication/copy/cleanup, durable quota reservations, schema verification, GC accounting, crash recovery, backup/restore mutexes and 10×4 concurrent first-open stress passed.
- Current gates: inventory freshness PASS at 153 mutation handlers and 163 callers; 106 execution routes remain frozen; 115 direct UI callers remain blocked; route distribution PASS; 467/467 Node tests PASS; 25/25 Playwright security/provider/secret/freeze tests PASS; TypeScript, PowerShell parser, production build and whitespace gates PASS.
- Independent review: zero open P0 or P1. Non-blocking P2 items are recorded in the evidence file; no waiver was used.
- Exit gate: passed for the durable kernel only. At the time of this closure production still used the legacy supervisor and no real provider invocation was claimed. Codex/Claude cutover remains Wave 3; Tool Gateway Wave 4; Hermes/OpenClaw/Antigravity parity Wave 5.
- Superseded on 2026-08-17: the Wave 3 cutover landed, so production no longer uses `RunSupervisor`. Every route under `src/app/api/workbench/**` imports `durableControlPlane`, and `getRunSupervisor` has no production caller. Read the Wave 3 sections below for the current path.

## Wave 3 progress — 2026-08-14

- Evidence: `WAVE-3-RESTRICTED-PILOT-EVIDENCE.json`.
- Cutover: Codex and Claude start/resume/cancel now use the durable Workbench control plane. Their desktop UIs do not POST to `/api/codex/chat` or `/api/claude/chat`; the legacy mutation routes remain frozen.
- Restricted provider policy: Codex is read-only with tools restricted. Claude tools, MCP, hooks, and skills are disabled. Drafts and transcripts are volatile client memory only.
- Codex standard live runtime rerun: start run `8b8293de-38dd-4c7f-baca-e424995b299f`, resume run `9a191fbf-8897-411a-9587-3d55386c6dbd`, and cancel run `4c6ebc24-9e2d-4d2a-83d9-9cd8c1145745` passed. Start and resume used native session `01a00135-bc08-70f0-bf23-6bebaadc8e1d`; cancel ended with `pid=null` and verified process-tree termination.
- Codex live restart runtime: start run `25c78f3a-23ed-4790-b648-0e29054fc10f` succeeded; after server restart, resume run `01791c25-22c6-4d02-bf07-b8b9b5f34733` succeeded with the same native session `01a00144-9513-7830-8915-15ffcf666efa`. Active run `996d3e21-ea3a-4fce-b9f4-b912b75c7afe` was terminated fail-closed on the next server restart as `windows_job_blocked`, with `pid=null` and authenticated `terminationVerified=1`. A new active run `b43ad2d3-825c-4619-8982-15ed690f6c75` then passed verified cancel. No duplicate execution or orphan process was observed.
- Claude live runtime rerun: installed Claude Code `2.1.227` is logged in through the first-party provider on a Max subscription. Start run `d4e40fc8-45db-4bf3-ad0d-8c1292d5cb0c` reached the provider and ended `blocked` with error code `quota` and message `Claude quota is unavailable.` after one provider attempt. Resume, cancel, and restart were not run because start did not succeed. This is not PASS.
- Current gates: 183/183 targeted Node tests, 467/467 full Node manifest with exit 0, 27/27 Playwright security/provider/secret/freeze/UI tests, 2/2 screenshot tests, TypeScript, route distribution, production build, current mutation inventory, and execution freeze passed.
- UI evidence: the current Codex and Claude screenshots show the Mission Control return path, agent/project target, and restricted-provider policy. Their SHA-256 hashes are recorded in the evidence file.
- Deferred requested tools: the Tool Gateway and MCP invocation remain Wave 4; Hermes/OpenClaw lifecycle parity remains Wave 5; Ruflo and the complete skills/MCP/apps/plugins/hooks/automations/models catalog plus `agent-orchestrator` router repair remain Wave 7. None is claimed as complete.
- `agent-orchestrator` observation: the current 2,252-skill scan routed the control-plane query to unrelated health skills, including `sexual-health-analyzer`, and matched zero provider runtimes. The observation is recorded for Wave 7; no false-positive skill was applied to product code.
- Exit gate: Codex satisfies live start, native resume, verified cancel, restart resume, fail-closed active-run interruption, and verified cancel after restart. Gate remains blocked only on fresh Claude live start, native resume, verified active-process cancel, and equivalent restart evidence after provider quota is available. Wave 4 must not start before this gate passes.

## Wave 3 audit and repair — 2026-08-17

An independent audit of this working tree against the authoritative plan found three items that no
existing evidence file recorded. All three are addressed here; the Wave 3 exit gate is unchanged and
still blocked on Claude live evidence.

1. Unguarded execution route. `POST /api/graphify/run` executed a binary with a client-supplied
   command string, a client-supplied working directory and the complete server environment, with no
   freeze guard and no local HTTP boundary. It was the only route under `src/app/api` that spawned a
   process without a guard. By owner decision the route stays live instead of being frozen, and now
   enforces: `authorizeLocalMutation` (loopback, Host/Origin match, no cross-site),
   `readLocalMutationJson` (JSON only, 64 KiB cap), a first-token allowlist with no shell, denial of
   `--mcp`, `--watch`, `--neo4j`, `--neo4j-push`, `--falkordb`, `--falkordb-push`, `--obsidian`,
   `--obsidian-dir`, `--wiki` and of any argument containing `://`, a canonical non-symlinked working
   directory inside `AGENT_OS_GRAPHIFY_ROOTS`, `buildToolChildEnvironment` instead of `process.env`,
   and `redactText` over stdout and stderr. The exception is recorded with its rationale in
   `verify-wave1-execution-freeze.mjs` as a classified execution candidate, so it is auditable rather
   than silent, and it must move behind a Tool Gateway approval in Wave 4.
2. Evidence was not current. The mutation inventory was stale against this tree, so the Wave 1
   verifier hard-exited with `verificationSkipped: "stale_mutation_inventory"` and
   `routeContractStatus: "fail"`. The inventory was regenerated and the verifier now reports
   `routeContractStatus: "pass"` with 106 frozen routes, 154 inventory routes, zero missing, zero
   unguarded, zero unclassified execution candidates and one classified exception.
3. No browser bootstrap channel. `POST /api/workbench/session` requires the bootstrap secret, but no
   launcher supplied it and `uiClient` only rotates an existing session, so in a normal launch the UI
   could not obtain a session and no run could be started from the browser. `THREAT-MODEL.md` names
   this channel as a Wave 3 prerequisite. `GET /api/workbench/session/bootstrap` now exchanges one
   launcher-owned navigation for the HttpOnly session and mutation cookies and then redirects, and
   `scripts/launch-agent-os.mjs` generates the secret, starts the server with it, waits for the
   server to answer, and opens that single navigation. Session rotation now extends the idle window
   up to a hard eight-hour deadline from issuance, so a working tab no longer dies after 15 minutes.

Delivery: the Wave 0-3 work is committed on branch `control-plane-repair`; it was previously
uncommitted, which contradicted the Wave 0 requirement that a clean clone contain everything needed.
`../e2e-final/` remains untracked and unstaged.

## Truthful controls and the remaining mutation boundary — 2026-08-17

Two further audit items are now closed. Evidence: `WAVE-3-AUDIT-REPAIR-2026-08-17.json`.

### Local HTTP boundary on every remaining mutation route

The Wave 1 boundary covered the 106 frozen routes and the Workbench, which left the other mutation
routes reachable from a hostile page: a cross-origin `POST` with a simple content type needs no
preflight, so it reaches the handler. `authorizeLocalMutation` is now exported from
`executionFreeze.ts` and is the first statement of 43 mutation handlers across 37 route files,
including the multipart upload `POST /api/videouse/jobs`.
`tests/e2e/local-mutation-boundary.spec.ts` probes every one of them: cross-origin is refused with
`origin_mismatch`, a missing `Origin` with `origin_required`, and a same-origin caller still reaches
its handler. Every probe is refused before the body is read, so the test creates no state.

### Controls that tell the truth

The freeze manifest moved into `src/lib/control-plane/frozenExecutionRoutes.ts`, a pure-data module
with no imports, so client components can read the same list the server guard enforces. The verifier
now parses that file and additionally fails if `executionFreeze.ts` stops importing it or declares its
own copy.

- `src/lib/executionAvailability.ts` exposes the frozen paths and one wording for every disabled
  control.
- `scripts/control-plane/generate-frozen-surfaces.mjs` walks each page's import graph and writes
  `src/lib/executionFrozenSurfaces.ts`: 39 routes with the frozen paths their components mutate. Its
  `--check` mode (`npm run control-plane:frozen-surfaces:check`) keeps the map from drifting away from
  the manifest or the inventory.
- `ExecutionFrozenNotice` renders from the shell on those 39 routes. It states that nothing is sent,
  nothing is queued and no run is created, that reads still work, and lists the disabled endpoints
  behind a details toggle.
- Agent surfaces replace their composer instead of offering a Run that cannot run: Antigravity reports
  the runtime-not-available reason first and the freeze reason second, and renders no textarea and no
  Run button; Hermes and OpenClaw show their own reason in place of the composer.
- The two globally mounted surfaces are disabled in place: Setup Center actions and every Command
  Palette action carry the shared reason.

Not covered: individual buttons inside the 39 app surfaces still render. The page notice is what makes
them truthful before a click, and the route still answers `503 control_plane_execution_unavailable`
with `runCreated: false`. Per-control disabling inside those app views remains follow-up work.

## Claude live lifecycle gate — 2026-08-17

Evidence: `WAVE-3-LIVE-CLAUDE-2026-08-17.json`.

The Claude quota that blocked Wave 3 on 2026-08-14 is available again. A CLI preflight under the
adapter's own restrictions answered `OK` with exit 0, and both live pilots then passed through the
canonical durable control plane:

- Standard pilot: start `5f47405a` succeeded and emitted its marker, resume `54bcd5f1` succeeded on the
  same native session `50742ae3`, and cancel `0eadf6d9` ended `cancelled` with `pid=null` and
  `stopped_and_verified`.
- Restart pilot: start `3f71de55` succeeded, resume `45b869c8` succeeded after a server restart on the
  same native session `1d170548`, the active run `9dd2eac8` was terminated fail-closed as
  `windows_job_blocked` with verified termination, and cancel `88810c6e` passed after the restart. No
  duplicate execution and no orphan process.

One defect surfaced, in the tests rather than the product: the marker assertions compared against raw
SSE frames joined by newlines, and Claude's reply arrived as three chunks (`C`, `LAUDE_LI`,
`VE_START_OK`). Both live specs now assemble the assistant transcript in sequence order, which is what
a reader sees. Codex had passed the old assertion only because its chunk boundaries happened not to
split the marker.

The gate did not close, because the blocker swapped providers: Codex now returns `provider_quota` on
three consecutive attempts, so its 2026-08-14 live pass is historical at this SHA. Wave 3 closes when a
current Codex live re-run passes. Wave 4 stays closed.

A direct Codex CLI re-check at 16:06 confirms it and names the reset:
`You've hit your usage limit … try again at Aug 20th, 2026 8:02 AM` (thread
`01a01078-f7f8-74b2-88eb-91489e760a1c`, `turn.failed`). No pilot run was spent, because none can pass
before that time. To close the gate afterwards:

```powershell
node scripts/control-plane/run-wave3-live-pilot.mjs --provider=codex
node scripts/control-plane/run-wave3-live-restart-pilot.mjs --provider=codex --port=3114
```

Two observations from that check, both outside this repository: Codex reported `Exceeded skills context
budget of 2%. All skill descriptions were removed and 3753 additional skills were not included`, which
is a data point for the Wave 7 `agent-orchestrator` and capability-catalog work, and three files under
`~/.agents/skills` fail to load with missing or invalid YAML frontmatter.
