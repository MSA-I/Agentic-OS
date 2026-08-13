# 28 · OmniRoute — Free Coding Across 90+ Providers (Optional)

The **OmniRoute** tab lets you build things with AI for **$0** by routing requests across **90+ free model providers** with automatic fallback. The gateway and routing logic run on your computer, while inference is performed by upstream providers; prompts, code, and attachments may therefore leave the machine.

Great for quick web builds and prototypes. You type a prompt, watch it build live on the right, and download the result.

## Setup (2 steps)
1. **Install + start the gateway** (it's a free open-source tool):
   ```bash
   npm install -g omniroute && omniroute
   ```
   Leave that running — it serves a local gateway on `http://localhost:20128`.
2. **Open the OmniRoute tab.** When it shows **"Gateway live"**, you're set. Type a prompt and go.

> 🟢 Easiest: open any AI agent in the folder and say *"install and start OmniRoute for me."*

## Use it with Claude Code too (optional)
OmniRoute is OpenAI/Anthropic-compatible, so you can point Claude Code at it for free coding:
```bash
export ANTHROPIC_BASE_URL=http://localhost:20128/v1
```
Verify it's up any time: `curl localhost:20128/v1/models`.

## Good to know
- **No API key, no cost** — it only uses free providers. Costs are always $0.
- **Rate limits are normal** — free providers throttle, so OmniRoute walks a fallback chain automatically; if it's slow, that's it hunting for a free provider that's free right now.
- **Locally managed gateway** — routing, fallback, and workspace persistence run on your machine. Model requests are sent to the selected upstream provider, so do not include secrets you would not share with that provider.
- Open-source (also an MCP server with 95 tools): <https://github.com/diegosouzapw/OmniRoute>
- Pick the right tool: OmniRoute / Free Claude Code / GLM Code for free builds; real Claude for the hardest work.
