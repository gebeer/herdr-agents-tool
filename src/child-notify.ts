import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { herdrId, runHerdr } from "../core/herdr.js";
import { formatSubagentReport, isReportAcknowledged, processCleanupCommand } from "../protocol/report.js";
import { piHerdrHost, resolveHerdrBinary } from "./herdr-cli.js";

/** Explicitly loaded in children, never registered as a package entry point. */
export default function childNotify(pi: ExtensionAPI): void {
	pi.registerFlag("herdr-parent-pane", {
		description: "Orchestrator pane receiving this subagent's completion reports.",
		type: "string",
	});
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
		const parent = herdrId(pi.getFlag("herdr-parent-pane"));
		const pane = process.env.HERDR_PANE_ID;
		if (process.env.HERDR_ENV !== "1" || !pane || ctx.mode !== "tui") return;
		try {
			if (!parent || parent === pane) {
				throw new Error("missing or invalid orchestrator pane");
			}
			const status = message?.stopReason ?? "no final response";
			const text = message?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
			const report = formatSubagentReport({
				name: pi.getSessionName(), pane, status, text, cleanup: processCleanupCommand(process.pid, pane),
			});
			const response = await runHerdr(piHerdrHost(pi, resolveHerdrBinary()), ["agent", "prompt", parent, report], {
				cwd: ctx.cwd, timeoutMs: 10_000, stage: "completion notification",
			});
			if (!isReportAcknowledged(response.result, parent)) {
				throw new Error("malformed or mismatched notification acknowledgement");
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : "unknown error";
			ctx.ui.notify(`Completion notification failed: ${reason}. Delivery may be uncertain; no retry was made.`, "error");
		}
	});
}
