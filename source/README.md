# 🦞 Agentic OS

> A local operational workspace for your AI agents.
> Built by Julian Goldie for AIPB members.

![local](https://img.shields.io/badge/runs-localhost-22d3ee?style=flat-square)
![local control plane](https://img.shields.io/badge/local-control_plane-a855f7?style=flat-square)
![voice](https://img.shields.io/badge/voice-built_in-ec4899?style=flat-square)

A single task-centered workspace for Claude Code, Codex, OpenClaw, Hermes, and the rest of the Agentic OS toolset.

Chat. Runs. Files. Artifacts. Goals. Journal.
Connected workflows can write durable context to your Obsidian vault.

The control plane and user state run on your laptop. A configured AI or media provider receives data only when you explicitly run the workflow that uses it.

---

## ✨ What's inside

- 💬 **Chat with multiple AI agents** from one beautiful dashboard
- 🎤 **Voice input** in every chat box (Chrome/Safari)
- 🧠 **Auto-saved to Obsidian** — every chat becomes a markdown note
- 🎯 **Goals page** that writes a real task list to your vault
- 📓 **Journal page** — daily entries, one file per day
- 📖 **Built-in build guide** — teach others how you made yours
- ✨ **Index Atelier workspace** — precise solid fields, tactile relief, explicit state, and no decorative idle effects
- ⌘ **Mission Control** — the familiar overview, status tiles, task list, and agent areas in their original order
- 🧭 **Stable navigation** — all existing routes and sidebar items stay in place across desktop and mobile
- 🦞 **Real CLI bridge** — calls your local Claude / OpenClaw / Hermes binaries

---

## 🟢 Requirements

- **Node 22+** (`node -v` to check, `brew install node` if missing)
- **macOS, Windows, or Linux** (Windows has a native PowerShell guide in the repository root)
- **At least one AI agent CLI** installed locally:
  - [Claude Code](https://claude.com/claude-code) — Anthropic's CLI
  - OpenClaw — install via the openclaw.ai install guide
  - Hermes Agent — install via `pip install nousresearch-hermes`
- **Optional but recommended:** an [Obsidian](https://obsidian.md) vault

If you only have one agent installed, that's fine — missing ones just don't show in the dashboard.

---

## 🚀 Quick start (5 minutes)

Clone the public repository, then install the locked dependencies from the `source` directory.

```bash
# 1. Clone the product
git clone https://github.com/MSA-I/Agentic-OS.git
cd Agentic-OS/source

# 2. Install dependencies
npm ci

# 3. Configure your paths
mkdir -p ~/.agentic-os
cp agentic-os.config.example.json ~/.agentic-os/config.json
# Then edit ~/.agentic-os/config.json with your vault path + agent binary paths

# 4. Run it on the standard Agentic OS port (macOS/Linux)
PORT=3737 npm run dev
```

On Windows PowerShell, use `$env:PORT=3737` and then `npm run dev`. Open **http://localhost:3737** in your browser.

The app binds to localhost by default. Optional agents and services report their setup state in their existing tabs.

---

## ⚙️ Configuration

Agentic OS reads config from (in priority order):

1. Environment variables
2. `~/.agentic-os/config.json`
3. Auto-detection (`which claude`, common Obsidian paths)
4. Sensible defaults

### Minimal config.json

```json
{
  "claude": "/Users/you/.local/bin/claude",
  "openclaw": "/Users/you/local/node/bin/openclaw",
  "hermes": "/Users/you/.local/bin/hermes",
  "vaultRoot": "/Users/you/Documents/Obsidian Vault",
  "goalCategories": ["Health", "Work", "Personal"]
}
```

Find the right paths with:

```bash
which claude     # → paste into "claude"
which openclaw   # → paste into "openclaw"
which hermes     # → paste into "hermes"
```

For your Obsidian vault, just point it at the folder you open in Obsidian.

### Where settings live (and survive updates)

Put your settings in **`~/.agentic-os/config.json`** — it lives **outside** the app folder, so an update never touches it. Set your vault path there:

```bash
# create it once (safe — outside the app folder)
mkdir -p ~/.agentic-os
printf '{\n  "vaultRoot": "/full/path/to/your/Obsidian vault"\n}\n' > ~/.agentic-os/config.json
```

> ⚠️ **Don't keep keys or config in a `.env` / `.env.local` inside the app folder as your only copy.** The updater now preserves them if they're there, but `~/.agentic-os/config.json` is the update-proof home — use it.

---

## 🧪 First-run check

Once running, hit each route to confirm everything's wired:

- `http://localhost:3737` — Mission Control overview
- `http://localhost:3737/claude` — Claude workspace (needs Claude Code installed)
- `http://localhost:3737/codex` — Codex workspace (needs Codex installed)
- `http://localhost:3737/openclaw` — OpenClaw workspace
- `http://localhost:3737/hermes` — Hermes workspace
- `http://localhost:3737/memory` — Search your connected Obsidian vault
- `http://localhost:3737/goals` — Goals (writes to the connected vault)
- `http://localhost:3737/journal` — Daily journal

If an agent tile says "not installed", check `which <agent>` returns a path. If it does, paste that path into your `config.json`.

---

## 🎨 Customising

Six files for the most common changes:

| Want to... | Edit |
|---|---|
| Add a new agent | `src/lib/runner.ts` + `src/lib/config.ts` |
| Change vault location | your `config.json` or `.env.local` |
| Change colours | `src/app/globals.css` (CSS variables at the top) |
| Change goal categories | your `config.json` (`goalCategories`) |
| Add a new sidebar page | `src/components/Sidebar.tsx` + `src/app/<page>/page.tsx` |
| Tweak the build guide | `BUILD-YOUR-OWN.md` |

---

## 🔒 Privacy & data

- **The Agentic OS control plane runs on localhost.** There is no Agentic OS telemetry service or hosted account requirement.
- Local state stays on your machine. Content is sent to a third-party provider only when you invoke a configured provider-backed workflow.
- Vault-enabled workflows write plain local files to the vault you selected.
- API routes shell out to your local CLIs via `child_process.spawn` — no shell interpolation, so prompt content can't run commands.
- `/api/run` enforces a per-agent regex allowlist for any tool-style commands.
- Path traversal blocked on vault-read endpoints.

Audit it yourself — the whole thing is about 2,500 lines.

---

## 🛠 Troubleshooting

**"agent is not installed"**
Your CLI isn't on `PATH` or auto-detection missed it. Edit `~/.agentic-os/config.json` and paste the full path from `which <agent>`.

**"no output" from chat**
Run the agent directly in your terminal first (`claude -p "hi"`). If that works, restart `npm run dev`. If it doesn't, the agent's broken, not the dashboard.

**Voice button is grey**
Voice needs Chrome or Safari. Firefox doesn't support the Web Speech API.

**Slow agents (>30s)**
Normal for some local models (ollama/deepseek). The "thinking… 18s" counter shows it's still working. If too slow, point that agent at a faster cloud model.

**Routes return 404**
Make sure you ran `npm ci` and you're on Node 22+.

---

## 🤖 Building your own from scratch

The full guide for using Claude Code to build this same system is at:

- `BUILD-YOUR-OWN.md` in this repo

It's 8 copy-paste prompts that mirror exactly how Julian built his.

---

## 📜 Licence

For AIPB members only. Not for redistribution.
You can fork it for personal use. Just don't resell.

— Julian Goldie · [AIPB](https://aiprofitboardroom.com)
