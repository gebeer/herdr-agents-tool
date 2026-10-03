/**
 * How a pi child is launched, shared by the pi orchestrator (src/start.ts) and the
 * Claude Code orchestrator (hooks/launch.ts). Pure: no imports, so both hosts load it.
 */

/** The pi orchestrator tool, kept out of pi children's active tools. */
export const PI_SPAWN_TOOL = "herdr_start_agent";

export interface PiChildLaunch {
	name: string;
	model: string;
	thinking: string;
	parentPane: string;
	/** Absolute path of src/child-notify.ts, which reports to `parentPane`. */
	notifierPath: string;
}

/** Arguments after the `pi` executable. */
export function piChildArgv(launch: PiChildLaunch): string[] {
	return [
		"--name", launch.name, "--model", launch.model, "--thinking", launch.thinking,
		"--exclude-tools", PI_SPAWN_TOOL,
		"--extension", launch.notifierPath,
		"--herdr-parent-pane", launch.parentPane,
		"--append-system-prompt", `You are a subagent. Do not spawn additional subagents. Your orchestrator is in Herdr pane ${launch.parentPane}. Automatic completion reporting is installed; do not send a separate completion notification.`,
	];
}
