# 41 · Muse Code — Meta's Muse Spark 1.2 (Optional)

> 🛑 **Already built.** This tab ships working — don't ask an AI to build it. Missing? Update your pack (`Update Agent OS.command`).

The **Muse Code** tab chats + builds with **Muse Spark 1.2** — Meta's agent-tuned coding model (1M context) — routed through **OpenRouter**. Describe a build, it ships a complete single-file app you can preview right in the tab.

## Setup (1 key, likely already done)
It uses your **OpenRouter key** — the same one Hermes and several other tabs use. If you set up Hermes (`4-HERMES.md`), the tab is already green.

Not set up yet? Get a key at <https://openrouter.ai> and add this line to `~/.hermes/.env` (or `~/.fcc/.env`, or set it as an env var):
```
OPENROUTER_API_KEY=sk-or-your-key
```

Open the **Muse Code** tab, pick Muse Spark 1.2 or 1.1, and build.

> 🟢 Easiest: open any AI agent in the folder and say *"make sure my OpenRouter key is set so the Muse Code tab works."*

## Good to know
- **It's a reasoning model** — you'll see a thinking indicator before answers. Normal.
- **Costs are yours** — OpenRouter bills your key per token; Muse Spark is competitively priced.
- **Model docs:** <https://dev.meta.ai/docs/> (Meta's developer portal).
- **Pick the right brain:** Muse Spark for agent-y single-file builds; GPT 5.6 Code / real Claude for the heaviest work.
