# Herdr Agents

Start Pi or Claude Code agents from a running agent session, in [herdr-core](https://herdr.dev) terminals.
Their answers come back to the session that started them, without polling.

**Start → the agent works → its final answer arrives in your input → follow up or close it.**

One repository, two integrations: a Pi extension and a Claude Code mod. Both drive the same
`core.ts`, which runs `hc` commands. Agents never need to read the herdr-core skill for this.

> **Warning:** Claude Code children bypass permission prompts by default. See [Permissions](#permissions).

## Requirements

- herdr-core with `hc` on `PATH`. The parent session must run in an hc terminal (`$HC_TERMINAL_ID` is set);
  outside one, no tools are registered.
- The Herdr app for `tab` and `pane` placement. Without it, agents run hidden.
- [Pi](https://pi.dev) for Pi sessions and children.
- Claude Code with [function hooks enabled](https://github.com/anthropics/claude-code/tree/main/mods) for Claude sessions and children.
  The mod API is early access and can change between releases.
- Provider credentials for each model. Claude Code must already trust the child's folder.

## Install

Download or clone this repository and keep it at its installed path.

**Pi extension**, from the repository folder:

```bash
pi install "$PWD"
```

Run `/reload` in an already open session.

**Claude Code mod**: start Claude with `--plugin-dir /absolute/path/to/herdr-agents-tool`, or load it in every
session through `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/herdr-agents-tool" } }
```

## Tools

| Pi | Claude Code | Does |
| --- | --- | --- |
| `herdr_start_agent` | `mcp__herdr-agents__start_agent` | Starts one agent and returns at once. |
| `herdr_message_agent` | `mcp__herdr-agents__message_agent` | Sends text to a running agent: `{ to, text }`. |

Fields of the start tool. Only `name` is required.

| Field | Rule or default |
| --- | --- |
| `name` | `[a-z][a-z0-9_-]{0,31}`, unique among live terminals. |
| `prompt` | The first task. Without it the agent starts idle. |
| `model` | Pi: words that match one enabled model, or an exact `provider/model-id`. Claude: `fable`, `opus`, `sonnet`, `haiku` or a model ID. Default: the agent's own. |
| `kind` | `pi` or `claude`. Left out, it follows `model`: an enabled Pi model wins, then a Claude alias; without a model, `pi`. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Claude accepts `low` to `max`. Default: the agent's own. |
| `place` | `tab` (default): a background tab in the parent's space. `pane`: a split in the parent's tab. `hidden`: no tab or pane. |
| `focus` | `true` shows the agent at once. Default `false`: the view stays where it is. |
| `cwd` | Existing folder. Default: the parent session's folder. |
| `permissionMode` | Claude Code parent only, for Claude children. Default `bypassPermissions`. |

### Models

Pi models come from `enabledModels` in Pi's `settings.json` (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`).
The list is part of the tool's description, so the calling model sees it without a lookup, and it is read
again on every start. `model: "sol"` picks the first enabled entry that contains `sol`;
`"deepseek flash"` the first that contains both words. An unknown model fails with the list of valid ones.

## How reports work

- The child's terminal gets `HERDR_AGENTS_REPORT_TO=<parent address>`. A Pi child loads `pi-child.ts`,
  a Claude child loads this mod. Each sends the final answer of every finished turn with `hc send`.
  The parent receives it as `<hc from="t7 name">answer</hc>`, also in the middle of its own turn.
- The child is told it is a subagent and that reporting is automatic. Children get no start tool.
- herdr-core itself tells the parent when a child is blocked, hits an error or exits
  (`<hc>t7 name is blocked (permission). See: hc read t7</hc>`). It says nothing when a turn simply ends.
- Answers over 16,000 characters are cut. Ask children to write long results to a file.
- A report is sent once. If the parent cannot take it (it is blocked on a question, or gone), the child
  shows a notice and the answer stays in the child's session: `hc read <address>`.

Agents placed in a tab or pane outlive the session that started them. Hidden agents end with it.
Close an agent with `hc kill <address>`.

## Permissions

**Claude children default to `bypassPermissions`: they act without permission prompts.**
A Pi parent always uses this mode. A Claude Code parent can set `permissionMode`.
This extension is not a sandbox; use hooks or another control for unattended work.

## Limits

- Linux and macOS (`env` is used to pass the report variable).
- A pane's split direction is chosen by the Herdr app.
- Agents start on the parent's machine, in the parent's space.

## Development

```bash
npm test                 # pure checks of core.ts (models, report text)
npm run test:e2e         # real agents in a herdr-core of its own
npm run typecheck        # Pi side
npm run typecheck:mod    # Claude Code mod
npm run validate:mod
```

`test:e2e` fakes nothing: it starts the hc session `hat-e2e`, real `pi` and `claude` agents in it, and
makes real model calls (four short turns each way, about a minute). It covers a Pi child in a pane with a
follow-up message, a hidden Claude child, and a Pi and a Claude session that each start a child with their
tool and get its report. Pick the models with `E2E_PI_MODEL` (words or an ID; default: Pi's own) and
`E2E_CLAUDE_MODEL` (default `haiku`). Your own herdr-core is not touched.
