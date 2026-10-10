import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { record, runHerdr } from "../core/herdr.js";
import { PI_SPAWN_TOOL } from "../protocol/pi-child.js";
import { piHerdrHost, resolveHerdrBinary } from "./herdr-cli.js";

/** pi-notes-compaction's window marker; windowNumber > 0 means earlier turns left the model's view. */
const WINDOW_MESSAGE = "notes-compaction:window:v1";
const ROSTER_MESSAGE = "herdr-agents:roster:v1";
const TASK_PREVIEW_CHARS = 300;

interface StartedChild {
	name: string;
	pane: string;
	task: string;
}

function isRollover(entry: SessionEntry): boolean {
	if (entry.type !== "custom_message" || entry.customType !== WINDOW_MESSAGE) return false;
	const details = record(entry.details);
	const windowNumber = record(details?.identity)?.windowNumber;
	return details?.kind === "window" && typeof windowNumber === "number" && windowNumber > 0;
}

/** Children this session started. The session branch is the registry; no extra state. */
function startedChildren(entries: readonly SessionEntry[]): StartedChild[] {
	const tasks = new Map<string, string>();
	const children: StartedChild[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "toolCall" && part.name === PI_SPAWN_TOOL) tasks.set(part.id, String(part.arguments.prompt ?? ""));
			}
		} else if (message.role === "toolResult" && message.toolName === PI_SPAWN_TOOL && !message.isError) {
			const details = record(message.details);
			if (typeof details?.name === "string" && typeof details.pane === "string") {
				children.push({ name: details.name, pane: details.pane, task: tasks.get(message.toolCallId) ?? "" });
			}
		}
	}
	return children;
}

/** Roster lines for started children Herdr still runs, matched by pane and name. */
function rosterLines(children: readonly StartedChild[], agents: readonly unknown[]): string[] {
	const live = agents.map(record);
	return children.flatMap((child) => {
		const agent = live.find((info) => info?.pane_id === child.pane && info.name === child.name);
		if (!agent) return [];
		const task = child.task.length > TASK_PREVIEW_CHARS ? `${child.task.slice(0, TASK_PREVIEW_CHARS)}…` : child.task;
		return [`- ${child.name} (pane ${child.pane}, ${String(agent.agent_status)}): ${task || "(no initial task)"}`];
	});
}

/**
 * After a notes-compaction rollover, tells the orchestrator which subagents it started earlier are
 * still running, so it neither forgets nor re-delegates them. Inert without notes-compaction.
 */
export function registerRolloverRoster(pi: ExtensionAPI): void {
	let checkedWindow: string | undefined;
	pi.on("before_agent_start", async (_event, ctx) => {
		const branch = ctx.sessionManager.getBranch();
		const boundary = branch.findLastIndex(isRollover);
		if (boundary < 0 || branch[boundary]!.id === checkedWindow) return;
		checkedWindow = branch[boundary]!.id;
		const children = startedChildren(branch.slice(0, boundary));
		if (!children.length) return;
		let agents: unknown;
		try {
			const listed = await runHerdr(piHerdrHost(pi, resolveHerdrBinary()), ["agent", "list"], {
				cwd: ctx.cwd, timeoutMs: 5_000, stage: "agent list",
			});
			agents = listed.result.agents;
		} catch (error) {
			ctx.ui.notify(`Subagent roster skipped: ${error instanceof Error ? error.message : error}`, "warning");
			return;
		}
		const lines = rosterLines(children, Array.isArray(agents) ? agents : []);
		if (!lines.length) return;
		return {
			message: {
				customType: ROSTER_MESSAGE,
				display: true,
				content: `<subagent_roster>\nSubagents you started before this context window are still running. Do not start duplicates. Their reports arrive in this session; use history to find earlier ones.\n${lines.join("\n")}\n</subagent_roster>`,
			},
		};
	});
}
