# Security and privacy

## What Pit Crew guarantees

- **Localhost only by default.** The gateway binds to `127.0.0.1`. Any other host prints a warning.
  There is no authentication; do not expose it to a network.
- **No cloud models.** Models with a `remote_host`, or named `*:cloud` / `*-cloud`, are refused at
  resolve time (HTTP 403) and hidden from `/v1/models`. Config validation rejects cloud aliases.
- **No outbound network calls** from the gateway. It only talks to the configured Ollama URL.
- **No shell for jobs.** Image/TTS/STT job commands are spawned without a shell; request values are
  substituted as whole argv entries, so prompts cannot inject flags or commands.
- **No prompt logging.** Logs and events record sizes, timings and model names — not content.
- **Repositories are read, not written.** `pitcrew scout` stores artifacts in
  `~/.pitcrew/projects/<id>/`.

## What it does not guarantee

Local inference does not make the whole workflow private.

- **OpenCode** may contact its own services (update checks, model metadata, sharing, plugins).
  `bin/opencode-local` and the example profiles disable sharing, auto-update, models.dev fetches,
  LSP downloads, web fetch and external skills, and restrict providers to the local one. Verify on
  your machine with `bench/tools/netwatch.sh`.
- Other OpenCode processes (e.g. editor integrations via `opencode acp`) use your **global**
  OpenCode config, which may route to cloud providers.
- **Ollama** contacts its registry when you pull models and may offer cloud models if you are signed
  in. Pit Crew refuses those models, but Ollama itself is not sandboxed.
- **MCP servers, plugins, package managers and the code the agent runs** can reach the network.

## Reporting

Please report vulnerabilities privately via GitHub security advisories rather than public issues.
