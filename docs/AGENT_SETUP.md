# Setting up Pit Crew with a coding agent

Any coding agent that can run shell commands (Claude Code, OpenCode, Codex, Cursor, Aider…) can
set Pit Crew up for you. Paste this to your agent:

```text
Set up Pit Crew (local LLM gateway for OpenCode + Ollama) on this machine by following
https://raw.githubusercontent.com/HarshKumarraghav/pitcrew/main/docs/AGENT_SETUP.md
Explain the plan to me and wait for my OK before downloading models or writing files.
```

---

## Instructions for the agent

You are setting up Pit Crew for the user. The model choice is made by `pitcrew init` from measured
data and the machine's memory; do not substitute your own model picks unless the user asks.

1. **Check prerequisites.** `node --version` must be ≥ 22.6. If it is older, stop and tell the user
   to update Node (https://nodejs.org). macOS on Apple Silicon is the main target; Linux works.

2. **Get the plan (changes nothing).**
   ```sh
   npx -y pitcrew-ai init --json
   ```
   The JSON has `detected` (machine, memory, Ollama, OpenCode, pulled models), `recommendation`
   (`coder`, `light`, context sizes, `warnings`, `notes`), `pulls` (models to download), `files`
   (what will be written, with `action` create/overwrite/keep) and `blockers`.

3. **Resolve blockers first.** If `blockers` mentions Ollama:
   - not installed → tell the user to install it from https://ollama.com/download (macOS:
     `brew install ollama`). Installing software is the user's decision; ask before running brew.
   - not running → ask the user to open the Ollama app, or run `ollama serve` in the background.
   Then run step 2 again.

4. **Explain the plan to the user in plain language**, then wait for their OK:
   - which coder and light model, and why (`recommendation.tier`, sizes, `basis`: measured or estimate)
   - how much will be downloaded (`pulls`, sizes from `recommendation.coder/light.bytes`)
   - every item in `recommendation.warnings` (e.g. little free memory right now) and `notes`
   - which files will be written (`files[].path`); their own OpenCode config is not touched
   If the user wants a different model, add `--coder <ollama tag>` and/or `--light <tag>` and
   repeat step 2. If files already exist (`action: "keep"`), ask before adding `--force`.

5. **Apply.**
   ```sh
   npx -y pitcrew-ai init --yes --json     # add the same --coder/--light/--force flags as in step 4
   ```
   Model downloads can take minutes; progress goes to stderr. The final JSON lists `pulled`,
   `written`, `skipped` and `next`.

6. **Start the gateway** in the background (it keeps running):
   ```sh
   npx -y pitcrew-ai serve
   ```
   The dashboard is at http://127.0.0.1:11500.

7. **Verify.**
   ```sh
   npx -y pitcrew-ai doctor --json
   ```
   Every check has `status` ok / warn / fail and, when not ok, a `fix`. Apply fixes that are safe
   (pulling a listed model, restarting the gateway); ask the user about anything else. A `warn` on
   memory means it works but open apps will be compressed; tell the user.

8. **Hand over.** Tell the user how to start coding:
   ```sh
   OPENCODE_CONFIG=~/.pitcrew/opencode.json opencode
   ```
   If OpenCode is not installed: https://opencode.ai (or `npm i -g opencode-ai`).

### Rules

- Everything stays local: never configure cloud models (`*:cloud`); Pit Crew refuses them anyway.
- Do not edit the user's global OpenCode config; the profile in `~/.pitcrew/opencode.json` is
  merged on top only when `OPENCODE_CONFIG` points at it.
- Do not close the user's apps to free memory. Suggest it if `doctor` warns.
- If something fails that `doctor` cannot explain, show the gateway output and point the user to
  https://github.com/HarshKumarraghav/pitcrew/blob/main/docs/TROUBLESHOOTING.md.
