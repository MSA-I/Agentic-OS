# Agentic OS Design System

This document is the implementation contract for the Agentic OS visual skin.
The direction is **Index Atelier with dominant tactile relief**: solid fields,
thin rules, precise typography, and static material texture.

## Layout Lock

The existing React structure is the source of truth. The redesign must not
replace or rearrange it.

- Desktop keeps the existing 244px global sidebar and flexible main content.
- The sidebar keeps its current sections, labels, item order, active state, and
  scrolling behavior.
- Mission Control keeps its current header, live status tiles, Today's List,
  agent areas, and all following sections in their current order.
- Agent routes keep their current workspace shell, 276px internal sidebar on
  wide screens, tab order, panels, cards, and controls.
- At mobile widths, the existing global bottom navigation remains in place and
  page sections retain their current stacking order.
- There is no new 56px rail, 268px context pane, 320px inspector, replacement
  dashboard grid, or drawer-based information architecture.
- CSS may change color, type, texture, borders, radii, focus, and state
  transitions. It must not redefine the application grid or reorder content.
- `data-agent-os-*` and `data-agent-workspace` attributes are non-structural
  hooks for theming and tests only.

The authoritative visual override is
`source/src/app/agent-os-skin.css`.

## Product Posture

- English, left-to-right, desktop-first.
- Agentic OS chrome stays recognizable on every route.
- A named agent may brand only its existing central workspace.
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

Only the existing central agent workspace changes provider identity.

| Theme | Canvas | Ink | Accent | Rule / support |
|---|---:|---:|---:|---:|
| Claude | `#F1ECE4` | `#191817` | `#D97757` | `#CFC3B8` |
| Codex | `#10101A` | `#D9D9E8` | `#6867AA` | `#6867AA` |
| Hermes | `#0000F2` | `#F5F5F5` | `#EDFF45` | `#F5F5F5` |
| OpenClaw | `#101012` | `#F6F5F3` | `#F5654A` | `#4FC8AE` |

Wrappers inherit their provider identity. Tools without a verified provider
identity remain on the neutral Agentic OS theme. Provider accent communicates
identity, not warning or error semantics.

## Typography, Shape, and Motion

- `Geist Sans` is the only interface family.
- `Geist Mono` is limited to code, paths, metrics, timestamps, and shortcuts.
- Radius scale: `4px` for controls, `6px` for surfaces, and `10px` for
  overlays.
- Shadows are reserved for overlays that must establish z-order.
- State transitions last `120-200ms`.
- There is no decorative idle motion.
- `prefers-reduced-motion: reduce` removes non-essential animation and
  transitions.
- Existing component dimensions and spacing are retained unless a narrow,
  non-structural correction is required to prevent viewport clipping.

## Relief System

The texture files are grayscale luminance layers. CSS supplies all color.
Reading and control surfaces use an opaque backing color; relief is never
allowed to reduce text contrast.

| Asset | Intended use | Dimensions | Bytes | Mean luma | Range | SHA-256 |
|---|---|---:|---:|---:|---:|---|
| `ridges.webp` | Hermes material field | 2048x2048 | 900350 | 210.756 | 143-255 | `989db814f2f1039da6cc1705fdde05d347e26d6d81f9bbeae4e00f172c4a0743` |
| `weave.webp` | Global sidebar and dark agent workspaces | 2048x2048 | 1832662 | 157.296 | 0-231 | `2621a6328165400e211ee5f0426b431bddcc0e194a82cca82dc4a32d2f48f6c7` |
| `contours.webp` | Main canvas and light agent workspaces | 2048x2048 | 2372574 | 177.602 | 24-255 | `61d95497294565df7731d2cb034c18e528fffb240f78a57cc773d254b59121ff` |

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

## Component and Interaction Contract

- Existing navigation, tabs, URLs, deep links, keyboard behavior, and
  localStorage behavior remain unchanged.
- Existing command palette behavior remains available; the redesign does not
  add new global shortcuts.
- Existing agent actions and forms retain their current behavior.
- Every interactive component keeps visible hover, focus, active, disabled,
  loading, and error states where those states already apply.
- Focus uses a visible 2px Warm Red outline with sufficient offset.
- Horizontally scrollable tab rows may remain horizontally scrollable on
  mobile; control order must not change and the page itself must not overflow.

## Prohibited Visual Effects

- CSS gradients and gradient text.
- Decorative glass, backdrop blur, glow, particles, auroras, or shimmer.
- Decorative animated canvases, idle loops, or `requestAnimationFrame` work.
- Color as the only status signal.
- Texture directly behind long-form text without a solid reading surface.
- Structural component transplantation from the Gorgeous-websites template.

## Responsive and Accessibility Contract

- The page viewport does not horizontally clip at 390px.
- The existing mobile bottom navigation remains reachable and visible.
- Full editors are not forced into a new mobile composition.
- Keyboard order and focus remain visible and logical.
- Status does not rely on color alone.
- Target WCAG 2.2 AA for contrast, semantics, keyboard behavior, and reflow.
- Mission Control, Claude, Codex, and Hermes are visually reviewed at
  1440x900, 1024x768, and 390x844 against the locked layout.

## Template Provenance

The Gorgeous-websites template was inspected as required. Because layout is
locked, no marketing, authentication, Supabase, dashboard shell, or structural
component is copied into Agentic OS. Existing disclosure and responsive
patterns remain in place; the redesign contributes only the visual skin and
non-structural accessibility corrections.
