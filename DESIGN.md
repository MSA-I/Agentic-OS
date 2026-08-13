# Agentic OS Design System

This document is the implementation contract for the Agentic OS visual skin.
The direction is **Index Atelier with dominant tactile relief**: solid fields,
thin rules, precise typography, and static material texture.

## Layout Lock and Five Desktop Workbenches

The existing React structure is the source of truth outside five explicitly
approved agent routes.

- Desktop keeps the existing 244px global sidebar and flexible main content.
- The sidebar keeps its current sections, labels, item order, active state, and
  scrolling behavior.
- Mission Control keeps its current header, live status tiles, Today's List,
  agent areas, and all following sections in their current order.
- `/codex`, `/claude`, `/hermes`, `/openclaw`, and `/antigravity` are the
  approved exception. They own `100dvh`, omit global shell chrome, and reproduce
  their official desktop information architecture rather than sharing a
  reskinned `UnifiedChat` or one mandatory grid.
- Every route outside those five keeps the existing standard shell, panels,
  cards, and controls.
- At mobile widths, the existing global bottom navigation remains in place on
  standard routes. The five desktop-agent routes use a compact top bar and
  focus-trapped agent drawer, with no global bottom navigation.
- Provider-native activity, tasks, session, artifact, diff, terminal, browser,
  and file panes are allowed only on the five exception routes.
- CSS may change color, type, texture, borders, radii, focus, and state
  transitions. It must not redefine the application grid or reorder content.
- `data-agent-os-*`, `data-agent-workspace`, `data-agent-experience`, and
  `data-shell-mode` are the authoritative hooks for theming and layout tests.

Standard-route overrides live in `source/src/app/agent-os-skin.css`. Shared
workbench primitives and provider workbench styles live in
`source/src/app/agent-workbench.css`.

## Product Posture

- English chrome, desktop-first. User content uses `dir="auto"` and
  `unicode-bidi: plaintext` where appropriate.
- Agentic OS chrome stays recognizable on standard routes. Workbenches use the
  official provider hierarchy plus the compact Agentic OS switcher.
- Mobile supports monitoring and basic intervention; dense editors remain
  desktop-oriented.
- There is one fixed Agentic OS brand theme and no light/dark switch.

## Core Color Tokens

| Token | Value | Role |
|---|---:|---|
| `--perfect-white` | `#FFFFFF` | Base canvas and solid reading surfaces |
| `--outer-space` | `#1F2853` | Global sidebar, dark chrome, primary dark field |
| `--warm-red` | `#FF4E45` | Primary action, focus, selection, signal detail |
| `--deep-outer-space` | `#101630` | Primary ink and accessible text/icons on Warm Red |

Contrast receipts:

- Outer Space on Perfect White: `14.13:1`.
- Deep Outer Space on Warm Red: `5.45:1`.
- Warm Red on Perfect White: `3.27:1`; therefore Warm Red is not body text on
  white.

Warm Red is not an error synonym. Error and status meaning also require text,
iconography, position, and time.

## Agent Workspace Themes

Each workbench has provider-specific structure. Shared code is limited to
types, URL state, streaming, Markdown, accessibility, runtime primitives, and
the compact agent switcher.

| Theme | Canvas | Ink | Accent | Rule / support |
|---|---:|---:|---:|---:|
| Claude immersive | `#FBFAF7` | `#2D2B29` | `#943E28` | `#DEDBD5` |
| Codex immersive | `#181818` | `#F0F0F0` | `#A7A7AD` | `#343434` |
| Hermes immersive | `#F9FAFF` | `#273052` | `#4055FF` | `#D9DEF5` |
| OpenClaw immersive | `#111315` | `#F6F5F3` | `#F5654A` | `#343A3D` |
| Antigravity immersive | `#171B35` | `#F4F3FF` | `#8B7CFF` | `#3D4777` |

Wrappers inherit their provider identity. Tools without a verified provider
identity remain on the neutral Agentic OS theme. Provider accent communicates
identity, not warning or error semantics.

## Typography, Shape, and Motion

- `Geist Sans` is the interface family. The approved Hermes wordmark exception
  uses a Didone stack (`Didot`, `Bodoni MT`, then serif fallback).
- `Geist Mono` is limited to code, paths, metrics, timestamps, and shortcuts.
- Radius scale: `4px` for controls, `6px` for surfaces, and `10px` for
  overlays.
- Shadows are reserved for overlays that must establish z-order.
- State transitions last `120-200ms`.
- There is no decorative idle motion.
- `prefers-reduced-motion: reduce` removes non-essential animation and
  transitions.
- Workbench body text is 14-16px, navigation 12-14px, metadata at least 12px,
  and headings 16/20/28-32px. No operational copy is rendered below 12px.

## Relief System

The texture files are grayscale luminance layers. CSS supplies all color.
Reading and control surfaces use an opaque backing color; relief is never
allowed to reduce text contrast.

| Asset | Intended use | Dimensions | Bytes | Mean luma | Range | SHA-256 |
|---|---|---:|---:|---:|---:|---|
| `ridges.webp` | Hermes material field | 2048x2048 | 900350 | 210.756 | 143-255 | `989db814f2f1039da6cc1705fdde05d347e26d6d81f9bbeae4e00f172c4a0743` |
| `weave.webp` | Global sidebar and dark agent workspaces | 2048x2048 | 1832662 | 157.296 | 0-231 | `2621a6328165400e211ee5f0426b431bddcc0e194a82cca82dc4a32d2f48f6c7` |
| `contours.webp` | Main canvas and light agent workspaces | 2048x2048 | 2372574 | 177.602 | 24-255 | `61d95497294565df7731d2cb034c18e528fffb240f78a57cc773d254b59121ff` |
| `technical-star-map.svg` | Global desktop sidebar and mobile drawer | vector | 2940 | n/a | n/a | `36b942b9255dae2deaf863dc52df27bf51fc39d9b99ab388e73f6b73e3906a41` |
| `hermes-relief.svg` | Subtle classical relief behind Hermes chat | vector | 1949 | n/a | n/a | `19f2076791328635be487d3537db75e7d6ac1ab9b103d5b16c46f8f6d85a99eb` |

All final assets are neutral grayscale WebP files with
`maxRgbDelta=0`. The generated 1254x1254 source images were resized once to
2048x2048 with Sharp Lanczos3 and encoded as lossless WebP. Raw generator
outputs are not published.

### Canonical Image-generation Prompts

Each asset is generated in a separate call. No prompt may request UI text,
logos, marks, devices, or embedded brand color.

#### Ridges

> Create one production-ready, seamless square grayscale luminance relief map
> for a premium desktop operating-system interface. Pattern: RIDGES — layered
> hand-pressed paper ridges, narrow parallel folds, and occasional wider
> geological bands arranged with the discipline of an archival index. The
> relief is tactile but calm beneath solid interface color. Neutral grayscale
> height/luminance information only, edge-to-edge, tile-friendly, broad usable
> midtones, restrained highlights and shadows. No colored pixels, graphic
> gradient motif, lighting vignette, text, letters, numerals, icons, logo,
> watermark, border, mockup, or device. Orthographic flat texture capture,
> uniform illumination, no perspective. Generate at 2048x2048 or larger.

#### Weave

> Create one production-ready, seamless square grayscale luminance relief map
> for a premium desktop operating-system interface. Pattern: WEAVE — dense,
> tactile cross-woven textile or architectural mesh with subtle pressed-fiber
> depth, irregular enough to feel crafted but disciplined like an archival
> index. Neutral grayscale height/luminance information only, edge-to-edge,
> tile-friendly, broad midtones, restrained highlights and shadows. No colored
> pixels, graphic gradient motif, lighting vignette, text, letters, numerals,
> icons, logo, watermark, border, mockup, or device. Orthographic flat texture
> capture, uniform illumination, no perspective. Generate at 2048x2048 or
> larger.

#### Contours

> Create one production-ready, seamless square grayscale luminance relief map
> for a premium desktop operating-system interface. Pattern: CONTOURS — densely
> layered topographic strata embossed into fine matte paper, flowing in
> deliberate nested bands with occasional tighter index-like knots and broad
> calm valleys. Neutral grayscale height/luminance information only,
> edge-to-edge, tile-friendly, broad midtones, restrained highlights and
> shadows. No colored pixels, graphic gradient motif, lighting vignette, text,
> letters, numerals, icons, logo, watermark, border, mockup, or device.
> Orthographic flat texture capture, uniform illumination, no perspective.
> Generate at 2048x2048 or larger.

## Provider Desktop Contracts

- Codex is task and review first: projects/worktrees, task list, transcript,
  activity, review/diff, terminal, browser/files, and permission cards.
- Claude is session and pane first: filters, split panes, transcript modes,
  tasks/subagents, plan, diff, browser, terminal, and files.
- Hermes is chat and profile first: agents/projects, skills, messaging,
  artifacts, queue, preview/files/review/terminal, and a persistent status bar.
  Profiles, Skills, MCPs, and Settings are native screens, not an iframe.
- OpenClaw is identity and thread first: agent identity, pinned/threads/groups/
  coding, place picker, session/workspace/tasks rails, terminal/browser, and
  explicit attention approvals.
- Antigravity is artifact and subagent first: projects/conversations,
  Local/worktree, scheduled tasks, subagent cards, artifacts, review milestones,
  and editable permission cards.

## Component and Interaction Contract

- Existing routes, native data, old deep links, and APIs remain compatible.
- The URL is authoritative for agent, actor, project, session, environment,
  and panel. Back/forward navigation restores the complete context.
- `Ctrl+Shift+A` opens the compact agent switcher on desktop and mobile.
- Every conversation has one canonical list location; no duplicate sidebar,
  history widget, or Sessions screen represents the same rows.
- Pin is visible. Search covers title, content, status, and time. Long histories
  use pagination or virtualization and are never silently truncated.
- Existing agent actions and forms retain their current behavior.
- Every interactive component keeps visible hover, focus, active, disabled,
  loading, and error states where those states already apply.
- Focus uses a visible 2px Warm Red outline with sufficient offset.
- Horizontally scrollable tab rows may remain horizontally scrollable on
  mobile; control order must not change and the page itself must not overflow.

## Prohibited Visual Effects

- CSS gradients and gradient text outside the approved immersive compositions.
- Decorative glass, backdrop blur, glow, particles, auroras, or shimmer.
- Decorative animated canvases, idle loops, or `requestAnimationFrame` work,
  except the approved MEMORY Galaxy. Its Canvas is data-driven, pauses while
  the tab is hidden, disables flight/twinkle under reduced motion, and is paired
  with the keyboard-accessible clean graph.
- Color as the only status signal.
- Texture directly behind long-form text without a solid reading surface.
- Structural component transplantation from the Gorgeous-websites template.

## Responsive and Accessibility Contract

- The page viewport does not horizontally clip at 390px.
- The existing mobile bottom navigation remains reachable and visible on
  standard routes; it is intentionally absent on immersive-agent routes.
- Full editors are not forced into a new mobile composition.
- Keyboard order and focus remain visible and logical.
- Status does not rely on color alone.
- Target WCAG 2.2 AA for contrast, semantics, keyboard behavior, and reflow.
- Mission Control, MEMORY, and all five desktop agents are visually reviewed at
  1440x900, 1024x768, and 390x844 against the locked layout.

## Template Provenance

The Gorgeous-websites template was inspected as required. Because layout is
locked, no marketing, authentication, Supabase, dashboard shell, or structural
component is copied into Agentic OS. Existing disclosure and responsive
patterns remain in place; the redesign contributes only the visual skin and
non-structural accessibility corrections.
