/**
 * How a Claude Code child is launched, shared by the Claude Code orchestrator (hooks/launch.ts)
 * and the pi orchestrator (src/start.ts). Pure: no imports, so both hosts load it.
 */

/** Variables the orchestrator sets on a Claude child's pane; hooks/register.ts reads them back by literal name. */
export const PARENT_PANE_ENV = "HERDR_AGENTS_PARENT_PANE";
export const AGENT_NAME_ENV = "HERDR_AGENTS_NAME";

export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

const CLAUDE_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

/**
 * Arguments after the `claude` executable, and the pane env. The child loads the plugin at
 * `pluginRoot`, which finds it by `PARENT_PANE_ENV`, adds its subagent instructions to its
 * system prompt, and reports on each turn. Throws on an invalid model or effort.
 */
export function claudeChildLaunch(
	name: string,
	parentPane: string,
	pluginRoot: string,
	model: string | undefined,
	effort: string | undefined,
	permissionMode: PermissionMode,
): { argv: string[]; env: Record<string, string> } {
	if (model !== undefined && !CLAUDE_MODEL.test(model)) {
		throw new Error("invalid model for claude: use a Claude Code model alias or ID, such as opus or sonnet");
	}
	if (effort !== undefined && !CLAUDE_EFFORTS.includes(effort)) {
		throw new Error(`unsupported thinking level for claude: ${effort}; use ${CLAUDE_EFFORTS.join(", ")}`);
	}
	return {
		argv: [
			"--name", name,
			...(model === undefined ? [] : ["--model", model]),
			...(effort === undefined ? [] : ["--effort", effort]),
			"--permission-mode", permissionMode,
			"--plugin-dir", pluginRoot,
		],
		env: { [PARENT_PANE_ENV]: parentPane, [AGENT_NAME_ENV]: name },
	};
}
