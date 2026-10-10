# Herdr Agents

**Supported platform: Linux only.** Pi child cleanup requires GNU `tail` with `--pid` support and GNU `timeout`.

Start Pi or Claude Code agents in new [Herdr](https://herdr.dev/docs/) panes, tabs, or workspaces.
Receive their reports in the parent session.

**Start → submit a task → receive a report → send a follow-up or close the child.**

One repository. Two integrations: a Pi extension and a Claude Code mod.
Both use the same launch code. New locations do not take focus.
The tool returns before the task finishes.

> **Warning:** Claude Code children bypass permission prompts by default. Read [Permissions](#permissions) before use.

## Requirements

- [Pi](https://pi.dev) for Pi sessions and children.
- Herdr with `herdr` available through `HERDR_BIN_PATH` or `PATH`.
- Claude Code with [function hooks enabled](https://github.com/anthropics/claude-code/tree/main/mods) for Claude sessions and children.
- Provider credentials for each selected model.
- An existing project directory. Claude Code must already trust this directory.

The Claude Code mod API is early access and can change between releases.

Run the parent inside Herdr.
The tools require `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_WORKSPACE_ID`.
They register no start tool outside this environment.

## Install

Download or clone this repository. Keep it at its installed path.

### Pi extension

From the repository directory, run:

```bash
pi install "$PWD"
```

Set a [Pi model profile](#pi-model-profiles) before the first launch.
Start Pi in a Herdr pane, from your project directory.
For an existing session, run `/reload` after installation.
Pi supplies the runtime dependencies. A local installation needs no `npm install`.

### Claude Code mod

Open a Herdr pane in a trusted project directory.
Run this command with the repository's absolute path:

```bash
claude --plugin-dir /absolute/path/to/herdr-agents-tool
```

The mod registers `mcp__herdr-agents__start_agent` in the parent session.
Claude Code children load the mod automatically.

<details>
<summary>Load the mod in every Claude Code session</summary>

Add this variable to the `env` object in `~/.claude/settings.json`.
Preserve your existing settings and plugin paths.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/herdr-agents-tool"
  }
}
```

A child that also loads this path with `--plugin-dir` loads the mod only once.

</details>

## Start an agent

Ask the parent to start a child with a clear task.
Use the start tool instead of shell commands for launches.
Include a task unless you want an idle child.
Do not poll for results. Reports arrive automatically.

These examples are agent tool calls, not shell commands.

**From Pi:**

```ts
herdr_start_agent({
  name: "reviewer",
  prompt: "Review the current diff. Report actionable findings only.",
})
```

**From Claude Code:**

```ts
mcp__herdr-agents__start_agent({
  name: "reviewer",
  kind: "claude",
  model: "opus",
  thinking: "high",
  permissionMode: "plan",
  prompt: "Review the current diff. Report actionable findings only.",
})
```

Both tools default to a **Pi child in a new tab**.
Only `name` is required. Neither tool starts agents in existing panes.

<details>
<summary>Tool fields</summary>

| Field | Rule or default |
| --- | --- |
| `name` | Use `[a-z][a-z0-9_-]{0,31}`. |
| `kind` | `pi` (default) or `claude`. |
| `prompt` | Optional task text. It must contain nonblank text and no NUL bytes. |
| `placement` | `tab` (default), `pane`, or `workspace`. |
| `workspace` | Tab placement only. Defaults to the parent's workspace. |
| `direction` | Pane placement only. `right` (default) or `down`. |
| `cwd` | Existing directory. Defaults to the parent's directory. Relative paths resolve from that directory. |
| `model` | Pi: configured alias or exact `provider/model-id`. Claude: model alias or ID. |
| `thinking` | Optional effort level. Overrides the selected profile's default. |
| `permissionMode` | Claude Code tool only, for Claude children. Defaults to `bypassPermissions`. |

Use `placement: "pane"` only for an explicitly requested split.
It splits the parent's pane, not the focused pane.
This rule is agent guidance, not runtime enforcement.

</details>

The result identifies the child and its pane.
`promptSubmitted: true` confirms task submission, not task completion.

## Pi model profiles

Run `pi --list-models`.
Replace `provider/model-id` below with an exact model ID.
Select a thinking level that the model supports.
Save the configuration as `herdr-agents.json` in the appropriate Pi profile directory.

```json
{
  "fallback": { "model": "provider/model-id", "thinking": "medium" },
  "aliases": {
    "review": { "model": "provider/model-id", "thinking": "medium" }
  }
}
```

| Parent | Configuration and Pi child profile |
| --- | --- |
| Pi | Uses the parent's Pi profile, including `PI_CODING_AGENT_DIR`. Defaults to `~/.pi/agent`. Children use this same profile. |
| Claude Code | Reads `~/.pi/agent/herdr-agents.json`. Pi children always use `~/.pi/agent`, regardless of `PI_CODING_AGENT_DIR`. |

A Pi parent also reads its project's `.pi/herdr-agents.json` when Pi trusts that project.
Project aliases override matching global aliases. A project fallback replaces the global fallback.
A different child directory does not change this source.
A Claude Code parent ignores project-level Pi configuration.

Configuration is read for each launch. Changes need no `/reload`.
Invalid configuration stops the launch before Herdr creates a location.

<details>
<summary>Model selection, effort, and built-in defaults</summary>

- Omitted `model`: selects the fallback.
- Alias, such as `model: "review"`: selects that profile's model and effort.
- Exact model ID: uses the fallback effort unless `thinking` is supplied.
- Explicit `thinking`: overrides the selected effort.

Pi effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

A Pi parent checks the model and effort against its model registry.
For an explicit model, an invalid or unavailable profile triggers a check of the configured fallback.
The result reports fallback use and its reason.
If both profiles fail, no location is created.
Other invalid inputs, invalid configuration, and launch failures do not trigger model fallback.

A Claude Code parent checks Pi configuration and model-ID syntax only.
It does not check Pi's registry or model support, or switch profiles after selection fails.
Errors can therefore appear in the child's pane.
Neither parent checks provider credentials before launch.

The built-in fallback is `openai-codex/gpt-5.6-sol` with `medium` effort.
Aliases `sol`, `terra`, and `luna` select the corresponding `openai-codex/gpt-5.6-*` models with `medium` effort.
These models may not be available in your registry.

</details>

### Claude Code models

Claude children do not use Pi model profiles or fallback rules.
The tool passes `model` to `--model` and `thinking` to `--effort`.
Omitted options remain under Claude Code's configuration.

Use a Claude Code model alias or ID, such as `opus` or `sonnet`.
Valid effort values are `low`, `medium`, `high`, `xhigh`, and `max`.

## Permissions

**Claude children default to `bypassPermissions`. They can act without permission prompts.**

A Pi parent always uses this mode for Claude children.
A Claude Code parent can set `permissionMode` to `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, or `plan`.
Use protective hooks or another suitable control for unattended work. This extension is not a sandbox.

Herdr starts agents through the pane's shell.
A `claude` alias or function can change launch behavior.
A wrapper with `--dangerously-skip-permissions` can override the requested permission mode.

Children receive instructions not to start more subagents.
Pi children also exclude `herdr_start_agent` from their active tools.
Other process-launch tools remain available.

## Reports and follow-ups

Children send their answers to the original parent pane with `herdr agent prompt`.
Keep the parent in that pane until its children finish.

- Pi reports after `agent_settled`, including retries and queued follow-ups.
- Claude Code reports after each completed main-loop turn.
- Reports identify the child, pane, and stop reason. They include follow-up and cleanup commands.
- Response text is limited to 16,000 UTF-16 code units. Longer text gets a truncation notice.
- Pi reports exclude thinking text. A report is not proof of task success.

Children stay open for more tasks.
Use the report's **Follow-up** command for another task.
Use **Safe Cleanup** when finished.
Pi cleanup terminates Pi, waits up to ten seconds, then closes the pane. It requires GNU `tail` and `timeout`.
Claude cleanup closes the pane directly.

Delivery has a ten-second timeout and no automatic retry. Failures appear in the child's UI.
Blocked or closed parent panes, crashes, and forced termination can prevent reports.
Concurrent reports can arrive as one message, with separate start and end markers.
There is no durable report inbox. Do not bypass blocked dialogs with raw terminal input.

<details>
<summary>Optional: Pi context-window rollover</summary>

With `pi-notes-compaction`:

- A child skips completion reporting for `new_context`. Its next run reports when the task settles.
- After rollover, the parent lists its previously started children that Herdr still reports as live.
- The list includes panes, status, and initial-task previews.

This feature uses session history and `herdr agent list`.
It is inactive without the notes-compaction window marker.
It does not install compaction or continuously monitor children.

</details>

## If a launch fails

| Failure | Tool behavior | Your action |
| --- | --- | --- |
| Invalid input or configuration | Creates no location. | Correct the input or configuration. |
| Startup failure with a confirmed created pane | Attempts to close that pane once. | Check the error for cleanup failure or a startup-screen excerpt. |
| Uncertain location creation | Does not guess or close a pane. | Inspect Herdr for a location that may remain open. |
| Task-submission failure | Leaves the ready child running. Does not retry. | Inspect the child before resubmitting. |

Readiness confirms that the child can accept input, not that a provider request succeeded.
A Claude folder-trust prompt can block readiness. Trust the project before launch.

## Development

```bash
npm install
bun run typecheck
bun run test
```

Bun checks use fake hosts. They make no provider requests.
For the mod, load it once to generate `.claude-plugin/types/`, then run:

```bash
bun run typecheck:mod
bun run test:mod
```

The optional integration test requires a Herdr pane and authenticated `openai-codex/gpt-5.6-sol` and `openai-codex/gpt-5.6-terra` models:

```bash
RUN_HERDR_INTEGRATION=1 bun run test:integration
```

It creates a disposable server and makes real provider requests.
It checks launches, task submission, persisted model settings, reports, follow-ups, and cleanup.
It tests default-profile children, not custom-profile inheritance or context-window rollover.

Shared launch code is in `core/`. Shared configuration and report rules are in `protocol/`.
Pi integration is in `src/`. Claude Code integration is in `hooks/`.

## License

[MIT](LICENSE).
