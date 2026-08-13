# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is an individual technical power user who works daily with
Codex, Claude Code, Hermes, OpenClaw, and specialist local tools.

## Product Purpose

Agentic OS brings local coding agents, workflows, projects, sessions,
artifacts, memory, and system controls into one operational workspace. Five
core routes reproduce the current official desktop workflow of their provider
so daily work can stay in Agentic OS without flattening every agent into one
generic chat product.

## Operating Context

- The product is used mainly on desktop beside terminals, editors, files, and
  long-running local processes.
- Product chrome remains English and left-to-right. User messages, artifacts,
  file names, and generated content support Hebrew, RTL, and bidirectional text.
- Mobile is a compact monitoring and basic-intervention surface, not a full
  editor.
- Existing routes, data stores, APIs, query parameters, localStorage keys, and
  operational behavior are implementation truth.

## Locked Layout Contract and Five-Route Exception

The standard application remains structurally locked. Only Codex, Claude,
Hermes, OpenClaw, and Antigravity have a separately approved desktop-workbench
presentation.

- Preserve all 47 existing page routes.
- Preserve the existing 244px application sidebar, its sections, item order,
  labels, and navigation behavior.
- Preserve every page's current composition, section order, card order, tabs,
  controls, and content hierarchy.
- `/codex`, `/claude`, `/hermes`, `/openclaw`, and `/antigravity` use
  independent full-height desktop workbenches. They may arrange provider-native
  sidebars, transcripts, activity, tasks, artifacts, files, review, browser,
  and terminal panes according to the current official product.
- Preserve the existing standard composition for every route outside the five
  approved exceptions.
- Preserve the current Mission Control composition: header and status tiles,
  Today's List, agent sections, and the rest of the existing page in their
  current order.
- Preserve the existing mobile bottom navigation on standard routes. Immersive
  routes instead use a compact top bar and focus-trapped agent drawer.
- Do not introduce a replacement global shell, route registry, or Mission
  Control data model. Provider-native context and activity panes are permitted
  only inside the five workbenches.
- Non-structural attributes may be added only for theming, accessibility, or
  automated verification.

Any structural change outside the five listed routes requires separate user
approval.

## Workbench Product Contract

- `AgentDescriptor` declares provider, runtime, and real capabilities.
- `WorkContext` contains `agentId`, `actorId`, `projectId`, `sessionId`,
  environment, and active panel. URL parameters are the source of truth;
  localStorage holds drafts and backward-compatible preferences only.
- `Run` uses `queued`, `running`, `awaiting_approval`, `succeeded`, `failed`,
  `cancelled`, or `orphaned`. `RunEvent` records messages, reasoning, tools,
  terminal output, diffs, artifacts, status, and errors.
- Approval requests expose risk, a redacted operation, and only
  `allow_once`, `allow_session`, or `deny`.
- Missing adapter abilities are marked `unsupported`; the UI does not render a
  control that cannot perform the named operation.
- Each provider keeps its own native projects, actors, and sessions. Native
  content is read through, never reset, migrated, merged, or duplicated into
  the workbench database.
- Hermes profile and OpenClaw agent are immutable session identity. Switching
  actor selects a compatible session or starts a new one.
- A compact five-agent switcher appears over every workbench. `Ctrl+Shift+A`
  opens it; it never combines histories.

## Visual Scope

- Apply the Agentic OS palette, Geist typography, compact radii, static relief
  textures, and accessible state styling through a shared visual layer.
- Keep Agentic OS chrome consistent on standard routes. The five core agent
  routes deliberately replace that chrome with provider-specific shells.
- Remove CSS gradients, decorative glow, glass effects, shimmer, particles,
  auroras, and idle animation from the standard visual system. MEMORY is the
  narrow Canvas exception, with reduced-motion and hidden-tab safeguards.
- Use motion only for clear state transitions and respect
  `prefers-reduced-motion`.
- Keep reading regions on solid surfaces so texture never compromises text
  contrast.

## Brand Commitments

- Perfect White `#FFFFFF` is the primary canvas.
- Outer Space `#1F2853` is the dark navigation and chrome color.
- Warm Red `#FF4E45` is reserved for primary action, focus, selection, and
  signal details.
- Deep Outer Space `#101630` provides accessible text and icons on Warm Red.
- Warm Red is not ordinary body text on white and is not the sole error signal.
- Status meaning is reinforced with text, iconography, placement, and time; it
  never depends on color alone.

## Data and Safety

- Existing native agent calls remain in scope. The new workbench layer adds no
  publishing, payment, or destructive data-migration operation.
- No data migration is performed and no user state is deleted.
- Existing APIs and deep links remain as compatibility paths during cutover.
- Shared workbench APIs provide create, message (`steer` or `queue`), SSE event
  replay, cancellation, and approval decisions. Local SQLite stores run
  metadata, events, approval decisions, queue entries, and drafts outside the
  repository; native transcript bodies remain in native stores.
- MEMORY continues to consume the existing graph endpoint; the immersive agent
  screens continue to consume the existing agent, project, session, deep-link,
  and localStorage contracts.
- Public files must not expose credentials, binary paths, local vault/session
  paths, logs, configuration values, or private runtime state.
- Tests use mocked responses for agent actions.

## Non-goals

- A new global application shell or navigation hierarchy outside the five
  approved immersive-agent routes.
- A new Mission Control workflow or aggregation backend.
- New provider authentication, billing, or hosted account model.
- A theme switcher or translated product chrome.
- Structural changes copied from a template or mock.

## Accessibility and Responsive Acceptance

- Target WCAG 2.2 AA for contrast, focus visibility, semantics, keyboard
  navigation, and reflow.
- No page-level horizontal clipping at 390px.
- Immersive agent pages must remain within `100dvh` with no page-level overflow;
  their mobile drawer must trap focus, close on Escape, and restore focus.
- Loading, empty, offline, setup, unavailable, and error states must remain
  understandable without color alone.

## Release Acceptance

Release requires:

- TypeScript and production build pass with no new warning beyond the known
  `musecoder` NFT trace warning.
- All 47 page routes return successfully without unexpected page, console, or
  network errors.
- Mission Control, MEMORY, and all five desktop-agent routes pass visual review at
  1440x900, 1024x768, and 390x844 against their respective standard or
  immersive layout contracts.
- Focused axe and layout-contract checks pass.
- Texture, privacy, secret, and publication-manifest checks pass.
- The final published tree reproduces with `npm ci` and `npm run build` from
  a clean clone.
