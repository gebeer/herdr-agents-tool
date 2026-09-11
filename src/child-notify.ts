import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveHerdrBinary, runHerdr } from "./herdr-cli.js";

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
		const parent = pi.getFlag("herdr-parent-pane");
		const pane = process.env.HERDR_PANE_ID;
		if (process.env.HERDR_ENV !== "1" || !pane || ctx.mode !== "tui") return;
		try {
			if (typeof parent !== "string" || !parent || parent !== parent.trim() || /[\0\r\n]/.test(parent) || parent === pane) {
				throw new Error("missing or invalid orchestrator pane");
			}
			const status = message?.stopReason ?? "no final response";
			const text = message?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
			const body = text.length > 16_000 ? `${text.slice(0, 16_000)}\n[Truncated; full response remains in the child session.]` : text;
			const sender = JSON.stringify({ name: pi.getSessionName(), pane });
			// Herdr can concatenate concurrent pastes. Frame each report independently.
			const report = `\n[Subagent report ${sender}; ${status}]\nNEXT ACTION — After reviewing this report:\nSend a follow-up if more work is needed; otherwise close this agent.\nFollow-up: herdr agent prompt ${pane} "<task>"\nSafe Cleanup: kill -TERM ${process.pid} && timeout 10s tail --pid=${process.pid} -f /dev/null && herdr pane close ${pane}\n\n${body || "(No response text.)"}\n[End subagent report]\n`;
			const response = await runHerdr(pi, resolveHerdrBinary(), ["agent", "prompt", parent, report], {
				cwd: ctx.cwd, timeout: 10_000, stage: "completion notification",
			});
			const agent = response.result.agent as { pane_id?: string; agent?: string } | undefined;
			if (response.result.type !== "agent_prompted" || agent?.pane_id !== parent || agent.agent !== "pi") {
				throw new Error("malformed or mismatched notification acknowledgement");
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : "unknown error";
			ctx.ui.notify(`Completion notification failed: ${reason}. Delivery may be uncertain; no retry was made.`, "error");
		}
	});
}
