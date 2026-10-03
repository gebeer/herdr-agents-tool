/**
 * Subagent → orchestrator report protocol, shared by the pi child (src/child-notify.ts)
 * and the Claude Code child (hooks/child.ts). Pure: no imports, so both hosts load it.
 */

const TEXT_LIMIT = 16_000;
const RECEIVER_KINDS: readonly unknown[] = ["pi", "claude"];

export interface SubagentReport {
	name: string | undefined;
	pane: string;
	status: string;
	text: string;
	cleanup: string;
}

export function paneCloseCommand(pane: string): string {
	return `herdr pane close ${pane}`;
}

/** Terminates the child process before closing its pane, so the session ends cleanly. */
export function processCleanupCommand(pid: number, pane: string): string {
	return `kill -TERM ${pid} && timeout 10s tail --pid=${pid} -f /dev/null && ${paneCloseCommand(pane)}`;
}

/** Herdr can concatenate concurrent pastes, so each report is framed independently. */
export function formatSubagentReport(report: SubagentReport): string {
	const body = report.text.length > TEXT_LIMIT
		? `${report.text.slice(0, TEXT_LIMIT)}\n[Truncated; full response remains in the child session.]`
		: report.text;
	const sender = JSON.stringify({ name: report.name, pane: report.pane });
	return `\n[Subagent report ${sender}; ${report.status}]\nNEXT ACTION — After reviewing this report:\nSend a follow-up if more work is needed; otherwise close this agent.\nFollow-up: herdr agent prompt ${report.pane} "<task>"\nSafe Cleanup: ${report.cleanup}\n\n${body || "(No response text.)"}\n[End subagent report]\n`;
}

/** The `herdr agent prompt` result proves delivery to the orchestrator pane, which runs pi or Claude Code. */
export function isReportAcknowledged(result: Record<string, unknown>, parentPane: string): boolean {
	const agent = result.agent as { pane_id?: unknown; agent?: unknown } | undefined;
	return result.type === "agent_prompted" && agent?.pane_id === parentPane && RECEIVER_KINDS.includes(agent.agent);
}
