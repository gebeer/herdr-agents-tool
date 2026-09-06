# Herdr Start Agent Tool

A deliberately narrow Pi package with one tool: `herdr_start_agent`.

Inside a Herdr-managed Pi pane, it creates one new pane, tab, or workspace without focusing it, then starts one interactive Pi agent there. It accepts an exact registered `provider/model-id` (or one of three exact model aliases) and a thinking level supported by that model. It can submit an optional initial prompt after readiness. It loads a child-only completion notifier. The orchestrator tool does not start in existing panes, monitor children, retain state, or change active-tool selection.

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

## Tool

```ts
herdr_start_agent({
  name: "reviewer",
  placement: "tab", // default; pane | tab | workspace
  cwd: "/work/project",
  model: "terra", // or exact canonical provider/model-id
  thinking: "high",
  prompt: "Review the current diff. Report actionable findings only.", // optional
})
```

Placement defaults to a new tab in the orchestrator's workspace. Use `placement: "pane"` only when the user explicitly requests a split pane; `direction` then defaults to `"right"`.

`name` must match `[a-z][a-z0-9_-]{0,31}`. `sol`, `terra`, and `luna` expand only to `openai-codex/gpt-5.6-sol`, `openai-codex/gpt-5.6-terra`, and `openai-codex/gpt-5.6-luna`; every other supplied model must be an exact registered `provider/model-id`. Expansion happens before registry lookup, child-profile preflight, and Herdr launch, which use the canonical model. Omitted model and thinking inherit the controller only when both can be validated exactly. Every new pane explicitly sets `PI_CODING_AGENT_DIR=$HOME/.pi/agent` through Herdr's `--env`, so child agents use the default Pi profile even when the orchestrator or Herdr server uses another profile (such as `pi-clawa`). This does not change the requested working directory or model/thinking inheritance.

`prompt`, when supplied, must be nonblank text without NUL bytes; whitespace is preserved. After Herdr confirms interactive readiness, the tool submits it once with a ten-second deadline and returns `promptSubmitted: true` in the text result and details. This acknowledges submission, not completion. Omitting the prompt starts an idle agent and leaves the compact result unchanged.

## Completion reports

The launcher explicitly loads `src/child-notify.ts` through Pi's `--extension` flag and passes the calling pane as `--herdr-parent-pane`. Its appended system prompt identifies the child as a subagent, prohibits spawning further subagents, and explains that reporting is automatic. This is not a sandbox or a tool-permission restriction.

After `agent_settled` (including automatic retries and queued follow-ups), the child sends its latest assistant text to the orchestrator with `herdr agent prompt <parent-pane> <report>`. Reports identify the child and stop reason, exclude thinking, and cap response text at 16,000 UTF-16 code units with a truncation notice. They report settlement, not proof of task success. No notification is sent on initial startup. Children remain open for follow-ups; each report includes the exact `herdr agent prompt <child-pane> "<task>"` command. Later tasks also produce reports.

Delivery uses one ten-second CLI call, without waiting for the orchestrator's response or retrying. Failed/uncertain delivery is shown in the child's UI. A blocked or closed orchestrator can prevent delivery; crashes and forced termination cannot guarantee a report. Keep the orchestrator in its original pane.

**Concurrency limitation, verified on Herdr 0.8.2:** three simultaneous `agent prompt` calls were all acknowledged, but arrived in Pi as one concatenated user message. Reports therefore have separate start/end markers. This preserves readable boundaries in that observed case; it does not provide a durable inbox or guarantee independent queued messages. Do not bypass blocked dialogs with raw terminal input.

## Boundaries

Herdr remains the authority for layout and interactive readiness. On startup failure after a created root pane is proven—including a complete create response that arrives after abort/timeout—the tool makes one fresh, five-second attempt to close exactly that pane and accepts cleanup only when Herdr returns its `ok` discriminator. It never guesses a pane ID after an uncertain create outcome.

Prompt submission is outside startup rollback. On a prompt error, timeout, cancellation, or malformed acknowledgement, the tool leaves the agent running and reports its name and pane. Delivery may be uncertain: inspect the agent before retrying; the tool never retries automatically.

Before layout mutation, a Pi subprocess checks the default profile with an explicitly untrusted settings manager and all project-local resources disabled, so caller-controlled `.pi` settings, packages, extensions, skills, prompts, themes, and context cannot execute during preflight. The checker requires the exact model, requested thinking level, and usable stored profile-local request auth (including bounded OAuth refresh/auth derivation). It rejects selected-provider/model `models.json` API-key or header values backed by environment interpolation or commands before auth resolution, then requires final auth to derive solely from the validated stored credential. A successful Herdr readiness response still means only that the child is ready for input, not that a provider request has succeeded.

## Development

```bash
bun run typecheck
bun run test
RUN_HERDR_INTEGRATION=1 bun run test:integration
```

The unit contracts use only Bun/Node primitives. The opt-in integration command creates a named disposable Herdr server with a non-default inherited Pi profile, verifies that the child still uses the default profile without changing cwd, loads this package through Pi's SDK resource loader, executes the assembled tool with an initial prompt, and waits separately for its `OK` provider response. It reads the child session reference reported by Herdr to verify the persisted effective model/thinking entries and exact response, verifies that a real parent Pi receives the automatic completion report, then checks cleanup of its panes, generated session files, and named Herdr session metadata.
