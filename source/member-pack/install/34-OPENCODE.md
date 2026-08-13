# 34 · OpenCode — Terminal Coding Agent (Optional)

The **OpenCode** tab runs the locally installed [OpenCode CLI](https://opencode.ai) inside Agent OS. OpenCode writes real project files and can use its own providers or the local OmniRoute gateway.

## Windows setup

Use a native Windows installation so Agent OS can launch the same executable. OpenCode recommends WSL for its interactive terminal, but a WSL-only binary is not directly visible to the native Agent OS server.

Choose one official installation method in PowerShell:

The simplest native option is **Setup Center → OpenCode → Install OpenCode**. After explicit confirmation, Agent OS runs only the allowlisted pinned command `npm.cmd install -g opencode-ai@1.18.16`; it never accepts command text from the browser. Run **Test** after installation. The commands below remain available as manual alternatives.

```powershell
choco install opencode
```

```powershell
scoop install opencode
```

```powershell
npm install -g opencode-ai@1.18.16
```

Then verify what Windows resolves:

```powershell
Get-Command opencode | Select-Object -ExpandProperty Source
opencode --version
```

Open **Setup Center → OpenCode** and run the safe test. If the CLI is installed but not detected, use **Connect existing CLI file** and select the absolute `.exe` path reported by `Get-Command`; the standard npm `opencode.cmd` shim is also supported. Restart Agent OS after saving a CLI path.

macOS and Linux can use the official installer:

```bash
curl -fsSL https://opencode.ai/install | bash
```

## Connect OmniRoute

OmniRoute must be configured as a real OpenCode provider before its models are offered in the OpenCode tab.

1. Make sure OmniRoute is running and its Setup Center test returns models.
2. In **Setup Center → OpenCode**, choose **Connect OmniRoute to OpenCode** and confirm.
3. Run the OpenCode test again.

The action safely merges only the missing `provider.omniroute` fields into the global OpenCode config:

- default: `~/.config/opencode/opencode.json`
- custom: the file named by `OPENCODE_CONFIG`

It preserves all unrelated settings, providers, and existing model definitions. If an existing `omniroute` package, `baseURL`, or `apiKey` conflicts, Setup stops with an error and does not overwrite the file.

The resulting provider uses OpenCode's documented OpenAI-compatible adapter:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "omniroute": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OmniRoute (local)",
      "options": {
        "baseURL": "http://127.0.0.1:20128/v1",
        "apiKey": "{env:OMNIROUTE_API_KEY}"
      },
      "models": {
        "auto/coding": { "name": "OmniRoute Coding" },
        "auto/best-coding": { "name": "OmniRoute Best-Coding" },
        "auto/best-fast": { "name": "OmniRoute Fast" }
      }
    }
  }
}
```

Agent OS supplies `OMNIROUTE_API_KEY` only to the spawned OpenCode process. The local default is `free-local`; set `OMNIROUTE_API_KEY` in the Agent OS environment if your gateway uses another key.

## Other providers

OpenCode supports many providers. To add one interactively:

```powershell
opencode auth login
```

Provider credentials are managed by OpenCode. Agent OS does not copy them into its own config.

## Overrides and troubleshooting

- `OPENCODE_BIN` or `AGENTIC_OS_OPENCODE_BIN`: absolute CLI path.
- `OPENCODE_MODEL`: default `provider/model`.
- `OPENCODE_CONFIG`: custom OpenCode config file.
- If a saved model disappears from the selector, its provider is no longer configured; the tab resets to an available model.
- An OmniRoute build request is rejected with **Setup required** when the provider is absent or incomplete. Agent OS does not silently switch it to OpenCode Zen.
