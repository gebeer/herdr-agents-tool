import assert from "node:assert/strict";
import childNotify from "../src/child-notify.js";

export async function childNotifyChecks(): Promise<void> {
	const previousEnv = process.env.HERDR_ENV;
	process.env.HERDR_ENV = "1";
	try {
		for (const outcome of ["stop", "aborted", "error", "transport", "wrong-target", "long", "empty"]) {
			const handlers: Record<string, (...args: any[]) => any> = {};
			const calls: string[][] = [];
			const notices: string[] = [];
			childNotify({
				registerFlag: () => {},
				getFlag: () => "w-test:orchestrator",
				getSessionName: () => "worker",
				on: (event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; },
				exec: async (_binary: string, args: string[], options: { timeout: number }) => {
					calls.push(args);
					assert.equal(options.timeout, 10_000);
					assert.deepEqual(args.slice(0, 3), ["agent", "prompt", "w-test:orchestrator"]);
					if (outcome === "transport") throw new Error("offline");
					return { code: 0, killed: false, stderr: "", stdout: JSON.stringify({ id: "notify", result: {
						type: "agent_prompted", agent: { pane_id: outcome === "wrong-target" ? "other" : "w-test:orchestrator", agent: "pi" },
					} }) };
				},
			} as never);
			const ctx = { cwd: process.cwd(), mode: "tui", isIdle: () => true, ui: { notify: (text: string) => notices.push(text) } };
			await handlers.agent_settled!({}, ctx);
			assert.equal(calls.length, 0, "startup must not notify");
			handlers.agent_start!();
			if (outcome !== "empty") {
				handlers.message_end!({ message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "stale" }] } });
				handlers.message_end!({ message: { role: "assistant", stopReason: outcome, content: [
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "text", text: outcome === "long" ? "x".repeat(20_000) : "Final 日本語" },
				] } });
			}
			await handlers.agent_settled!({}, ctx);
			await handlers.agent_settled!({}, ctx);
			assert.equal(calls.length, 1, "settlement sends once, even after delivery failure");
			const report = calls[0]![3]!;
			assert.ok(report.startsWith("\n[Subagent report ") && report.endsWith("[End subagent report]\n"));
			assert.ok(report.includes(`Follow-up: herdr agent prompt ${process.env.HERDR_PANE_ID} "<task>" — this child remains available and will report back automatically.`));
			assert.ok(report.endsWith(`Cleanup when no longer needed: kill -TERM ${process.pid} && timeout 10s tail --pid=${process.pid} -f /dev/null && herdr pane close ${process.env.HERDR_PANE_ID}\n[End subagent report]\n`));
			assert.ok(!report.includes("private reasoning") && !report.includes("stale"));
			assert.ok(report.includes(outcome === "empty" ? "no final response" : outcome));
			if (outcome === "long") assert.ok(report.includes("Truncated") && report.length < 17_000);
			assert.equal(notices.length, ["transport", "wrong-target"].includes(outcome) ? 1 : 0);
		}
	} finally {
		if (previousEnv === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousEnv;
	}
}
