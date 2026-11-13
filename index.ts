import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	childRoster, type Host, KINDS, MESSAGE_DESCRIPTION, MESSAGE_FIELDS, messageAgent, PLACES, piModelsFrom,
	REPORT_TO_ENV, type Run, START_DESCRIPTION, startAgent, startFields, THINKING_LEVELS,
} from "./core.ts";

/** pi-notes-compaction's window marker; windowNumber > 0 means earlier turns left the model's view. */
const WINDOW_MESSAGE = "notes-compaction:window:v1";

/** Pi's enabled models, read fresh so a settings change needs no /reload. */
function piModels(): string[] {
	const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	try {
		return piModelsFrom(readFileSync(join(dir, "settings.json"), "utf8"));
	} catch {
		return [];
	}
}

function runner(pi: ExtensionAPI, signal?: AbortSignal): Run {
	return async ([command, ...args], timeoutMs) => {
		const result = await pi.exec(command!, args, { signal, timeout: timeoutMs });
		if (result.killed) throw new Error(`${command} timed out`);
		return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
	};
}

function isRollover(entry: SessionEntry): boolean {
	if (entry.type !== "custom_message" || entry.customType !== WINDOW_MESSAGE) return false;
	const details = entry.details as { kind?: unknown; identity?: { windowNumber?: unknown } } | undefined;
	const windowNumber = details?.identity?.windowNumber;
	return details?.kind === "window" && typeof windowNumber === "number" && windowNumber > 0;
}

/**
 * The tools of a session that may start agents: any Pi in an hc terminal that is not itself
 * a started child. Children get pi-child.ts instead, loaded by their launch line.
 */
export default function herdrAgentsTool(pi: ExtensionAPI): void {
	const me = process.env.HC_TERMINAL_ID;
	if (!me || process.env[REPORT_TO_ENV]) return;
	const fields = startFields(piModels());

	pi.registerTool({
		name: "herdr_start_agent",
		label: "Start Herdr Agent",
		description: START_DESCRIPTION,
		parameters: Type.Object(
			{
				name: Type.String({ description: fields.name }),
				prompt: Type.Optional(Type.String({ description: fields.prompt })),
				model: Type.Optional(Type.String({ description: fields.model })),
				kind: Type.Optional(StringEnum(KINDS, { description: fields.kind })),
				thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: fields.thinking })),
				place: Type.Optional(StringEnum(PLACES, { description: fields.place })),
				focus: Type.Optional(Type.Boolean({ description: fields.focus })),
				cwd: Type.Optional(Type.String({ description: fields.cwd })),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			const host: Host = {
				me,
				cwd: ctx.cwd,
				root: dirname(fileURLToPath(import.meta.url)),
				piModels: piModels(),
				piAgentDir: process.env.PI_CODING_AGENT_DIR,
				run: runner(pi, signal),
			};
			return { content: [{ type: "text", text: await startAgent(host, input) }], details: {} };
		},
	});

	pi.registerTool({
		name: "herdr_message_agent",
		label: "Message Herdr Agent",
		description: MESSAGE_DESCRIPTION,
		parameters: Type.Object(
			{ to: Type.String({ description: MESSAGE_FIELDS.to }), text: Type.String({ description: MESSAGE_FIELDS.text }) },
			{ additionalProperties: false },
		),
		async execute(_toolCallId, input, signal) {
			return { content: [{ type: "text", text: await messageAgent(runner(pi, signal), input) }], details: {} };
		},
	});

	// After a notes-compaction rollover the model no longer sees which agents it started: tell it once.
	let checkedWindow: string | undefined;
	pi.on("before_agent_start", async (_event, ctx) => {
		const rollover = ctx.sessionManager.getBranch().findLast(isRollover);
		if (!rollover || rollover.id === checkedWindow) return;
		checkedWindow = rollover.id;
		const roster = await childRoster(runner(pi), me).catch(() => undefined);
		if (!roster) return;
		return {
			message: {
				customType: "herdr-agents:roster:v1",
				display: true,
				content: `<subagent_roster>\nAgents you started before this context window still run. Do not start duplicates. Their reports arrive in this session.\n${roster}\n</subagent_roster>`,
			},
		};
	});
}
