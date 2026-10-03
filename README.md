# Herdr Start Agent Tool

A deliberately narrow Pi package with one tool: `herdr_start_agent`.

Inside a Herdr-managed Pi pane, it creates one new pane, tab, or workspace without focusing it, then starts one interactive Pi agent there. It accepts an exact registered `provider/model-id` or configured model alias and a thinking level supported by that model. It can submit an optional initial prompt after readiness. It loads a child-only completion notifier. The orchestrator tool does not start in existing panes, monitor children, retain state, or change active-tool selection.

The same repository is also a Claude Code plugin (a mod) that gives a Claude Code orchestrator the same capability for Claude Code and pi children; see [Claude Code mod](#claude-code-mod).

## Loading

Install the declared Pi runtime peers beside a directly copied package before loading it:

```bash
cd /home/gbr/.pi/extensions/herdr_agents_tool
npm install --omit=dev --no-package-lock
```

Without that local install, the isolated child-profile preflight cannot resolve Pi's runtime modules.

```json
{
  "packages": ["/home/gbr/.pi/extensions/herdr_agents_tool"]
}
```

The package registers nothing unless `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_WORKSPACE_ID` are present. Inside Herdr, its description directs orchestrators to use it exclusively for starting subagents, rather than other launch tools or direct CLI commands. Include an initial task prompt unless the user explicitly requests an agent without one. This is model guidance, not runtime enforcement; communication tools remain unaffected.

## Configuration

Model profiles live in `~/.pi/agent/herdr-agents.json`, also when the orchestrator runs on another Pi profile, because children always use the default profile. The orchestrator's project, when Pi trusts it, may override the fallback or individual aliases in its `.pi/herdr-agents.json`. Each profile contains an exact `provider/model-id` and its default thinking effort:

```json
{
  "fallback": { "model": "openai-codex/gpt-5.6-sol", "thinking": "medium" },
  "aliases": {
    "sol": { "model": "openai-codex/gpt-5.6-sol", "thinking": "medium" },
    "terra": { "model": "openai-codex/gpt-5.6-terra", "thinking": "medium" },
    "luna": { "model": "openai-codex/gpt-5.6-luna", "thinking": "medium" }
  }
}
```

Configuration is read for each launch, so edits do not require `/reload`. Project aliases merge over global aliases; project configuration is ignored unless Pi trusts the project. Invalid configuration fails immediately and is never bypassed with a fallback.

## Tool

```ts
herdr_start_agent({
  name: "reviewer",
  placement: "tab", // default; pane | tab | workspace
  cwd: "/work/project",
  model: "terra", // configured alias or exact provider/model-id
  thinking: "high", // overrides the alias default
  prompt: "Review the current diff. Report actionable findings only.", // optional
})
```

Placement defaults to a new tab in the orchestrator's workspace. Use `placement: "pane"` only when the user explicitly requests a split pane; it splits the orchestrator's own pane, and `direction` then defaults to `"right"`.

`kind: "claude"` starts a Claude Code child instead of a pi one, loading this repository as its plugin so it reports back like the mod's Claude children. `model` and `thinking` go to Claude Code as given, with no profile selection, preflight, or fallback. These children always run with `--permission-mode bypassPermissions`, since pi has no permission modes: rely on your damage-control hooks, not on permission prompts.

`name` must match `[a-z][a-z0-9_-]{0,31}`. A configured alias expands before registry lookup, child-profile preflight, and Herdr launch. An explicit thinking value overrides that alias's default. An exact `provider/model-id` uses the fallback thinking value when thinking is omitted.

The requested profile is checked first. If its model is malformed, unknown, unavailable, incompatible with the thinking level, or rejected by child-profile preflight/auth, the configured fallback profile is checked before Herdr changes the layout. Omitting `model` selects the fallback directly; an explicit `thinking` still overrides its default. Automatic fallback use is reported in both tool text and details with the requested profile (when available), selected fallback profile, and reason. If fallback also fails, the error includes both failures and no pane, tab, or workspace is created. Invalid configuration, other invalid tool input, invalid cwd/Herdr context, and failures after layout creation do not trigger fallback.

Every new pane explicitly sets `PI_CODING_AGENT_DIR=$HOME/.pi/agent` through Herdr's `--env`, so child agents use the default Pi profile even when the orchestrator or Herdr server uses another profile (such as `pi-clawa`). This does not change the requested working directory or configured model profile.

`prompt`, when supplied, must be nonblank text without NUL bytes; whitespace is preserved. After Herdr confirms interactive readiness, the tool submits it once with a ten-second deadline and returns `promptSubmitted: true` in the text result and details. This acknowledges submission, not completion. Omitting the prompt starts an idle agent and leaves the compact result unchanged.

## Completion reports

The launcher explicitly loads `src/child-notify.ts` through Pi's `--extension` flag and passes the calling pane as `--herdr-parent-pane`. Its appended system prompt identifies the child as a subagent, prohibits spawning further subagents, and explains that reporting is automatic. Children also launch with `--exclude-tools herdr_start_agent`, keeping the spawning tool out of their active tool set. This is not a sandbox: other tools can still launch processes.

After `agent_settled` (including automatic retries and queued follow-ups), the child sends its latest assistant text to the orchestrator with `herdr agent prompt <parent-pane> <report>`. Reports identify the child and stop reason, exclude thinking, and cap response text at 16,000 UTF-16 code units with a truncation notice. They report settlement, not proof of task success. No notification is sent on initial startup. Children remain open for follow-ups; each report includes the exact `herdr agent prompt <child-pane> "<task>"` command. Later tasks also produce reports. Before the response body, a `NEXT ACTION` block directs the orchestrator to send a follow-up if more work is needed or otherwise close the child. Its `Safe Cleanup` command sends SIGTERM to the child Pi process, waits up to ten seconds for it to exit using GNU `tail --pid`, and closes its Herdr pane only if both steps succeed.

Delivery uses one ten-second CLI call, without waiting for the orchestrator's response or retrying. Failed/uncertain delivery is shown in the child's UI. A blocked or closed orchestrator can prevent delivery; crashes and forced termination cannot guarantee a report. Keep the orchestrator in its original pane.

**Concurrency limitation, verified on Herdr 0.8.2:** three simultaneous `agent prompt` calls were all acknowledged, but arrived in Pi as one concatenated user message. Reports therefore have separate start/end markers. This preserves readable boundaries in that observed case; it does not provide a durable inbox or guarantee independent queued messages. Do not bypass blocked dialogs with raw terminal input.

## Boundaries

Herdr remains the authority for layout and interactive readiness. On startup failure after a created root pane is proven—including a complete create response that arrives after abort/timeout—the tool makes one fresh, five-second attempt to close exactly that pane and accepts cleanup only when Herdr returns its `ok` discriminator. It never guesses a pane ID after an uncertain create outcome.

Prompt submission is outside startup rollback. On a prompt error, timeout, cancellation, or malformed acknowledgement, the tool leaves the agent running and reports its name and pane. Delivery may be uncertain: inspect the agent before retrying; the tool never retries automatically.

Before layout mutation, a Pi subprocess checks the default profile with an explicitly untrusted settings manager and all project-local resources disabled, so caller-controlled `.pi` settings, packages, extensions, skills, prompts, themes, and context cannot execute during preflight. The checker requires the exact model, requested thinking level, and usable stored profile-local request auth (including bounded OAuth refresh/auth derivation). It rejects selected-provider/model `models.json` API-key or header values backed by environment interpolation or commands before auth resolution, then requires final auth to derive solely from the validated stored credential. A successful Herdr readiness response still means only that the child is ready for input, not that a provider request has succeeded.

## Claude Code mod

The repository root is also a Claude Code plugin (`.claude-plugin/plugin.json`, `hooks/`). Load it per session, or for every session through `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`:

```bash
claude --plugin-dir /home/gbr/.pi/extensions/herdr_agents_tool
```

Like the pi package, it does nothing outside a Herdr pane. One plugin plays two roles, chosen by the pane's environment:

- **Orchestrator**: registers the `start_agent` tool (`mcp__herdr-agents__start_agent`). It runs the very transaction `herdr_start_agent` runs (`core/transaction.ts`), with the same rollback rules: a proven pane is closed once on startup failure, an uncertain create is never guessed at, and a ready agent is never rolled back.
- **Child**: a Claude Code child launched by the tool loads this plugin with `--plugin-dir`, recognizes itself by `HERDR_AGENTS_PARENT_PANE` (set on its pane through Herdr's `--env`), registers no tool, adds its subagent instructions as a system-prompt section (`prompt.compose`), and sends each finished main-loop turn's answer to the orchestrator with `herdr agent prompt`. Reports use the same framed format as pi children (`protocol/report.ts`); their cleanup command is `herdr pane close <pane>`.

```ts
start_agent({
  name: "reviewer",
  kind: "claude",            // pi (default) | claude
  model: "opus",             // claude: Claude Code alias or ID; pi: herdr-agents.json alias or provider/model-id
  thinking: "high",          // claude accepts low | medium | high | xhigh | max (passed as --effort)
  permissionMode: "plan",    // claude only; defaults to bypassPermissions
  prompt: "Review the current diff. Report actionable findings only.",
})
```

`placement`, `workspace`, `direction`, `cwd`, `name`, and `prompt` behave as in the pi tool. Omitting `model` gives Claude children the user's configured model, and pi children the configured fallback profile.

Pi children are launched with exactly the arguments the pi orchestrator uses (`protocol/pi-child.ts`), including `src/child-notify.ts`. Their profiles come from the global `~/.pi/agent/herdr-agents.json`, parsed by the same rules (`protocol/model-config.ts`). The mod cannot reach pi's model registry, auth, or project trust, so it skips the child-profile preflight, automatic fallback, and project-level configuration: a bad model or missing auth surfaces in the child's pane.

Herdr types the child command into the new pane's shell, so a shell alias or function named `claude` applies to children too: a wrapper that adds `--dangerously-skip-permissions` overrides `permissionMode`. The plugin passes no `--append-system-prompt` (Claude Code keeps only the last one), so a prompt the wrapper appends survives beside the subagent section. A child that also loads this plugin through `CLAUDE_CODE_PLUGIN_DIRS` loads it once, not twice.

Both orchestrators share one host-neutral core. `core/` holds tool input validation, cwd resolution, the Herdr CLI adapter, and the create → start → prompt → rollback transaction, written against a `HerdrHost` port. The pi package implements that port over `pi.exec` (`src/herdr-cli.ts`), which keeps a killed command's output, so a create that completes after a timeout or abort is still proven and rolled back. The mod implements it over `$.process.run`, which rejects on timeout instead; such a create is reported as uncertain and never guessed at. `protocol/` holds the report format, `herdr-agents.json` rules, and pi child argv. Neither `core/` nor `protocol/` imports anything outside the two folders, so both hosts load them.

`$` (the engine interface) may appear only in `hooks/register.ts`. That file is the imperative shell: it reads the environment and builds the mod's `Host` (`hooks/host.ts`, the `HerdrHost` port plus plugin facts) for its pure modules: `hooks/start.ts` (the mod's `kind` and `permissionMode`), `hooks/launch.ts` (Claude and pi launch specs), `hooks/child.ts`, and `hooks/context.ts`.

## Development

```bash
bun run typecheck
bun run test
RUN_HERDR_INTEGRATION=1 bun run test:integration
bun run typecheck:mod   # after Claude Code has loaded the plugin once, which lays .claude-plugin/types/
bun run test:mod
```

`bun run test` also covers the mod's pure core against a fake host (`test/claude-mod.ts`); `test:mod` runs `hooks/register.test.ts` against the Claude Code engine to cover the shell's wiring.

The unit contracts use only Bun/Node primitives. The opt-in integration command creates a named disposable Herdr server with a non-default inherited Pi profile, verifies that the child still uses the default profile without changing cwd, loads this package through Pi's SDK resource loader, executes the assembled tool with an initial prompt, and waits separately for its `OK` provider response. It reads the child session reference reported by Herdr to verify the persisted effective model/thinking entries and exact response, verifies that a real parent Pi receives the automatic completion report, then checks cleanup of its panes, generated session files, and named Herdr session metadata.
