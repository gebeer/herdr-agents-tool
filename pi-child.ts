import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REPORT_TO_ENV, sendReport } from "./core.ts";

/**
 * Loaded only by a started child's launch line (`--extension`), never as a package entry:
 * sends the final answer of each finished turn to the agent that started it.
 */
export default function reportToParent(pi: ExtensionAPI): void {
	const parent = process.env[REPORT_TO_ENV];
	if (!parent || !process.env.HC_TERMINAL_ID || parent === process.env.HC_TERMINAL_ID) return;
	let active = false;
	let last: AssistantMessage | undefined;

	pi.on("agent_start", () => {
		active = true;
		last = undefined;
	});
	pi.on("message_end", (event) => {
		if (active && event.message.role === "assistant") last = event.message;
	});
	pi.on("agent_settled", async (_event, ctx) => {
		if (!active || !ctx.isIdle()) return;
		active = false;
		const message = last;
		last = undefined;
		// The variable reaches everything in the child's terminal; only its interactive session reports.
		if (ctx.mode !== "tui") return;
		// A notes-compaction rollover is not completion: the run in the new window reports.
		if (message?.content.some((part) => part.type === "toolCall" && part.name === "new_context")) return;
		const text = message?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
		const failure = await sendReport(
			async ([command, ...args], timeoutMs) => {
				const result = await pi.exec(command!, args, { timeout: timeoutMs });
				if (result.killed) throw new Error(`${command} timed out`);
				return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
			},
			parent, text, message?.stopReason ?? "no final response",
		);
		if (failure) ctx.ui.notify(failure, "error");
	});
}
