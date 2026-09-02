# Herdr Start Agent Tool

A deliberately narrow Pi package with one tool: `herdr_start_agent`.

Inside a Herdr-managed Pi pane, it creates one new pane, tab, or workspace without focusing it, then starts one interactive Pi agent there. It accepts an exact registered `provider/model-id` (or one of three exact model aliases) and a thinking level supported by that model. It does not start in existing panes, prompt or monitor children, retain state, or change active-tool selection.

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

The package registers nothing unless `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_WORKSPACE_ID` are present.

## Tool

```ts
herdr_start_agent({
  name: "reviewer",
  placement: "pane", // pane | tab | workspace
  direction: "right", // pane only
  cwd: "/work/project",
  model: "terra", // or exact canonical provider/model-id
  thinking: "high",
})
```

`name` must match `[a-z][a-z0-9_-]{0,31}`. `sol`, `terra`, and `luna` expand only to `openai-codex/gpt-5.6-sol`, `openai-codex/gpt-5.6-terra`, and `openai-codex/gpt-5.6-luna`; every other supplied model must be an exact registered `provider/model-id`. Expansion happens before registry lookup, child-profile preflight, and Herdr launch, which use the canonical model. Omitted model and thinking inherit the controller only when both can be validated exactly. Child agents use Pi's default `~/.pi/agent` profile.

## Boundaries

Herdr remains the authority for layout and interactive readiness. On startup failure after a created root pane is proven—including a complete create response that arrives after abort/timeout—the tool makes one fresh, five-second attempt to close exactly that pane and accepts cleanup only when Herdr returns its `ok` discriminator. It never guesses a pane ID after an uncertain create outcome.

Before layout mutation, a Pi subprocess checks the default profile with an explicitly untrusted settings manager and all project-local resources disabled, so caller-controlled `.pi` settings, packages, extensions, skills, prompts, themes, and context cannot execute during preflight. The checker requires the exact model, requested thinking level, and usable stored profile-local request auth (including bounded OAuth refresh/auth derivation). It rejects selected-provider/model `models.json` API-key or header values backed by environment interpolation or commands before auth resolution, then requires final auth to derive solely from the validated stored credential. A successful Herdr readiness response still means only that the child is ready for input, not that a provider request has succeeded.

## Development

```bash
bun run typecheck
bun run test
RUN_HERDR_INTEGRATION=1 bun run test:integration
```

The unit contracts use only Bun/Node primitives. The opt-in integration command creates a named disposable Herdr server, loads this package through Pi's SDK resource loader, executes the assembled tool, and sends one bounded `reply exactly OK` provider turn. It reads the child session reference reported by Herdr to verify the persisted effective model/thinking entries and exact response, then verifies close/stop success and removes only its generated child session file/empty parent and named Herdr session metadata.
