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
| 3 — Restricted Codex/Claude pilot | In progress — blocked on Claude quota | `WAVE-3-RESTRICTED-PILOT-EVIDENCE.json`; Codex live start/resume/cancel/restart PASS; Claude live start reached the provider and returned `quota` | Blocked; Wave 4 remains closed |
| 4 — Tool Gateway pilot | Not started | None | Closed |
| 5 — Hermes/OpenClaw parity | Not started | None | Closed |
| 6 — Shared Project and Mission Control | Not started | None | Closed |
| 7 — Complete Tool Center | Not started | None | Closed |
| 8 — Operational E2E and cutover | Not started | None | Closed |

## Evidence rules

- `static-contract`: source or deterministic contract evidence only.
- `fake-runtime`: deterministic adapter evidence; never runtime proof.
- `live-runtime`: current execution against the installed provider/tool.
- `historical`: saved evidence from an earlier SHA, runtime, or date.
- `blocked`: quota, timeout, missing runtime, auth failure, or unavailable dependency. Never PASS.

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
- Exit gate: passed for the durable kernel only. Production still uses the legacy supervisor and no real provider invocation is claimed. Codex/Claude cutover remains Wave 3; Tool Gateway Wave 4; Hermes/OpenClaw/Antigravity parity Wave 5.

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
