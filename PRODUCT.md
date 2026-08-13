# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is an individual technical power user who works daily with
Codex, Claude Code, Hermes, OpenClaw, and specialist local tools.

## Product Purpose

Agentic OS brings local coding agents, workflows, projects, sessions,
artifacts, memory, and system controls into one operational workspace. The
redesign improves visual clarity and identity without changing how that
workspace is organized or how its capabilities behave.

## Operating Context

- The product is used mainly on desktop beside terminals, editors, files, and
  long-running local processes.
- The interface remains English and left-to-right.
- Mobile is a compact monitoring and basic-intervention surface, not a full
  editor.
- Existing routes, data stores, APIs, query parameters, localStorage keys, and
  operational behavior are implementation truth.

## Locked Layout Contract

The standard application remains a visual-skin redesign. Claude, Codex,
Hermes, OpenClaw, GLM, Kimi, Antigravity, and Free Claude Code have a
separately approved immersive-agent presentation.

- Preserve all 47 existing page routes.
- Preserve the existing 244px application sidebar, its sections, item order,
  labels, and navigation behavior.
- Preserve every page's current composition, section order, card order, tabs,
  controls, and content hierarchy.
- `/claude`, `/codex`, `/hermes`, `/openclaw`, `/glm`, `/kimi`,
  `/antigravity`, and `/freeclaude` use a full-height immersive shell with one
  236px agent sidebar, one content surface, and a fixed composer. Their actions
  retain the same URLs, events, projects, sessions, and persistence behavior.
- Preserve the existing standard composition for every route outside the eight
  approved exceptions.
- Preserve the current Mission Control composition: header and status tiles,
  Today's List, agent sections, and the rest of the existing page in their
  current order.
- Preserve the existing mobile bottom navigation on standard routes. Immersive
  routes instead use a compact top bar and focus-trapped agent drawer.
- Do not introduce an activity rail, replacement context pane, inspector,
  route registry, capability-filtered navigation, or a replacement Mission
  Control data model.
- Non-structural attributes may be added only for theming, accessibility, or
  automated verification.

Any proposed change that moves, groups, removes, renames, or reorders existing
interface elements requires separate user approval.

## Visual Scope

- Apply the Agentic OS palette, Geist typography, compact radii, static relief
  textures, and accessible state styling through a shared visual layer.
- Keep Agentic OS chrome consistent on standard routes. The eight primary agent
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

- The redesign adds no AI calls, sends, publishing actions, payments, or
  destructive operations.
- No data migration is performed and no user state is deleted.
- Existing API routes remain intact; no overview or capability endpoint is
  required for the visual skin.
- MEMORY continues to consume the existing graph endpoint; the immersive agent
  screens continue to consume the existing agent, project, session, deep-link,
  and localStorage contracts.
- Public files must not expose credentials, binary paths, local vault/session
  paths, logs, configuration values, or private runtime state.
- Tests use mocked responses for agent actions.

## Non-goals

- A new global application shell or navigation hierarchy outside the eight
  approved immersive-agent routes.
- A new Mission Control workflow or aggregation backend.
- New agent behavior, provider integration, authentication, billing, or hosted
  account model.
- A theme switcher, Hebrew/RTL product UI, or full mobile editing environment.
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
- Mission Control, MEMORY, and all eight immersive-agent routes pass visual review at
  1440x900, 1024x768, and 390x844 against their respective standard or
  immersive layout contracts.
- Focused axe and layout-contract checks pass.
- Texture, privacy, secret, and publication-manifest checks pass.
- The final published tree reproduces with `npm ci` and `npm run build` from
  a clean clone.
