/**
 * Everything the two hosts share: how an agent is chosen, started through herdr-core (`hc`),
 * messaged and reported on. Pure and import-free, so the Pi extension (index.ts) and the
 * Claude Code mod (hooks/register.ts) both load it.
 */

/** Set on a child's terminal: the hc address that receives its turn reports. */
export const REPORT_TO_ENV = "HERDR_AGENTS_REPORT_TO";

export const KINDS = ["pi", "claude"] as const;
export const PLACES = ["tab", "pane", "hidden"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const;

const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"];
const CLAUDE_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const REPORT_LIMIT = 16_000;
/** hc holds a send while a person has an unfinished draft, for up to 60 seconds. */
const SEND_TIMEOUT_MS = 75_000;
const HC_TIMEOUT_MS = 15_000;

export type Run = (argv: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface Host {
	/** This session's hc address (`$HC_TERMINAL_ID`). */
	me: string;
	/** The folder a new agent starts in when none is given. */
	cwd: string;
	/** This repository's absolute root: children load their reporting code from it. */
	root: string;
	/** Pi's enabled models, in the user's order (see `piModelsFrom`). */
	piModels: readonly string[];
	/** A non-default Pi profile folder; Pi children get the same one. */
	piAgentDir?: string;
	/** Runs a program to its exit. Rejects when it cannot start or times out. */
	run: Run;
}

export interface StartInput {
	name: string;
	prompt?: string;
	kind?: string;
	model?: string;
	thinking?: string;
	place?: string;
	focus?: boolean;
	cwd?: string;
	permissionMode?: string;
}

export const START_DESCRIPTION =
	"Start one Pi or Claude Code agent in its own herdr-core terminal. Use this instead of hc or herdr-app commands. It returns at once. The agent's final answer of every turn then arrives in your input as <hc from=\"address name\">...</hc>, so end your turn instead of polling. The agent has none of your context: give it a self-contained prompt.";

export const MESSAGE_DESCRIPTION =
	"Send a message to a running agent or terminal by its hc address or name, such as a follow-up task for an agent you started. Its answer arrives in your input by itself.";

export const MESSAGE_FIELDS = {
	to: "The hc address (t7) or name of the agent.",
	text: "The message. It is typed into the agent and submitted.",
};

/** Field descriptions of the start tool; `piModels` puts the user's model list in front of the calling model. */
export function startFields(piModels: readonly string[]) {
	const enabled = piModels.length ? piModels.join(", ") : "none configured: pass an exact provider/model-id";
	return {
		name: "Agent name: [a-z][a-z0-9_-]{0,31}, unique among live terminals.",
		prompt: "The agent's first task. Leave out only for an idle agent.",
		model: `Pi: words that match one enabled model, first match wins (${enabled}), or an exact provider/model-id. Claude: ${CLAUDE_ALIASES.join(", ")} or a model ID. Leave out for the agent's own default.`,
		kind: "pi or claude. Leave out to infer it from model: an enabled Pi model wins, then a Claude alias; without a model, pi.",
		thinking: "Effort level; 'sol high' means model sol, thinking high. Claude accepts low to max. Leave out for the default.",
		place: "tab (default): a background tab in your space. pane: a split in your own tab, only when the user asks for a pane. hidden: no tab or pane.",
		focus: "true shows the new agent at once. Default false: the user's view stays where it is.",
		cwd: "Existing folder for the agent. Default: your session's folder. A claude agent needs a folder Claude Code already trusts.",
		permissionMode: "claude only. Default bypassPermissions.",
	};
}

/**
 * The model IDs in `enabledModels` of a Pi settings.json; empty when the file is missing or unreadable.
 * Its patterns (`openai/*`, `sonnet`) are left out: `pi --model` takes an ID, and only Pi can expand them.
 */
export function piModelsFrom(settingsText: string | undefined): string[] {
	try {
		const models = JSON.parse(settingsText ?? "{}")?.enabledModels;
		return Array.isArray(models) ? models.filter((model): model is string => typeof model === "string" && /^[^\s/*?[]+\/[^\s*?[]+$/.test(model)) : [];
	} catch {
		return [];
	}
}

/** The first enabled model that contains every word of `wanted`, such as "deepseek flash". */
export function matchPiModel(wanted: string, piModels: readonly string[]): string | undefined {
	const words = wanted.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return undefined;
	const exact = piModels.find((model) => model === wanted);
	// A provider/model-id asks for that model: words must not turn it into a longer ID.
	if (exact || wanted.includes("/")) return exact;
	return piModels.find((model) => words.every((word) => model.toLowerCase().includes(word)));
}

/** Which agent to run and with which exact model. Throws with the valid choices when it cannot tell. */
export function resolveAgent(input: Pick<StartInput, "kind" | "model">, piModels: readonly string[]): { kind: "pi" | "claude"; model?: string } {
	const wanted = input.model?.trim();
	if (input.kind !== undefined && input.kind !== "pi" && input.kind !== "claude") throw new Error("invalid kind: use pi or claude");
	if (!wanted) return { kind: input.kind ?? "pi" };
	const piModel = matchPiModel(wanted, piModels) ?? (/^[^\s/]+\/\S+$/.test(wanted) ? wanted : undefined);
	const claudeModel = CLAUDE_MODEL.test(wanted) ? wanted : undefined;
	const looksClaude = claudeModel !== undefined && (CLAUDE_ALIASES.includes(wanted.toLowerCase()) || wanted.startsWith("claude-"));
	if (input.kind === "claude" && claudeModel) return { kind: "claude", model: claudeModel };
	if (input.kind !== "claude" && piModel) return { kind: "pi", model: piModel };
	if (input.kind === undefined && looksClaude) return { kind: "claude", model: claudeModel };
	throw new Error(`unknown model "${wanted}". Pi models: ${piModels.join(", ") || "none enabled"} (or an exact provider/model-id). Claude models: ${CLAUDE_ALIASES.join(", ")} or a model ID.`);
}

/** The app learns of a new terminal a moment after hc starts it, so ask for up to 3 s. */
async function showAgent(run: Run, address: string): Promise<boolean> {
	for (let attempt = 0; attempt < 10; attempt++) {
		const shown = await run(["herdr-app", "do", "agent.focus", "--terminal", address], HC_TIMEOUT_MS).catch(() => undefined);
		if (shown?.exitCode === 0) return true;
		await run(["sleep", "0.3"], HC_TIMEOUT_MS).catch(() => undefined);
	}
	return false;
}

/** What a child is told about its role, in its system prompt. */
export function subagentNote(parent: string): string {
	return `You are a subagent, started by the agent in hc terminal ${parent}. Your final answer of each turn is sent to it automatically; do not send it yourself. Do not start further agents.`;
}

/** The command line of the child agent, after `hc run ... --`. */
function agentArgv(host: Host, input: StartInput): { kind: "pi" | "claude"; model?: string; argv: string[] } {
	const { kind, model } = resolveAgent(input, host.piModels);
	const thinking = input.thinking;
	if (thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(thinking)) {
		throw new Error(`invalid thinking level: use ${THINKING_LEVELS.join(", ")}`);
	}
	// A leading - or @ would be read as an option or a file argument, not as the task.
	const prompt = input.prompt?.trim() ? [/^[-@]/.test(input.prompt) ? `Task: ${input.prompt}` : input.prompt] : [];
	const env = [`${REPORT_TO_ENV}=${host.me}`];
	if (kind === "claude") {
		if (thinking !== undefined && !CLAUDE_EFFORTS.includes(thinking)) {
			throw new Error(`unsupported thinking level for claude: ${thinking}; use ${CLAUDE_EFFORTS.join(", ")}`);
		}
		const mode = input.permissionMode ?? "bypassPermissions";
		if (!(PERMISSION_MODES as readonly string[]).includes(mode)) throw new Error(`invalid permissionMode: use ${PERMISSION_MODES.join(", ")}`);
		return {
			kind, model,
			argv: ["env", ...env, "claude", "--name", input.name, ...(model ? ["--model", model] : []), ...(thinking ? ["--effort", thinking] : []),
				"--permission-mode", mode, "--plugin-dir", host.root, ...prompt],
		};
	}
	if (input.permissionMode !== undefined) throw new Error("permissionMode applies only to claude agents");
	if (host.piAgentDir) env.push(`PI_CODING_AGENT_DIR=${host.piAgentDir}`);
	return {
		kind, model,
		argv: ["env", ...env, "pi", "--name", input.name, ...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : []),
			"--extension", `${host.root}/pi-child.ts`, "--append-system-prompt", subagentNote(host.me), ...prompt],
	};
}

/** Runs one hc command and returns its JSON answer. Throws hc's own message and hint on failure. */
async function hc(run: Run, command: string, args: string[], timeoutMs = HC_TIMEOUT_MS): Promise<Record<string, any>> {
	const result = await run(["hc", command, "--json", ...args], timeoutMs);
	if (result.exitCode !== 0) {
		let reason = result.stderr.trim() || `exit ${result.exitCode}`;
		try {
			const error = JSON.parse(result.stderr).error;
			reason = [error.message, error.hint].filter(Boolean).join(" ");
		} catch { /* not hc's JSON error: keep the raw text */ }
		throw new Error(`hc ${command} failed: ${reason}`);
	}
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(`hc ${command} gave no JSON: ${result.stdout.slice(0, 200)}`);
	}
}

/** Starts the agent and returns the tool's result text. The agent's parent is this session. */
export async function startAgent(host: Host, input: StartInput): Promise<string> {
	if (typeof input.name !== "string" || !NAME.test(input.name)) throw new Error("invalid name: use [a-z][a-z0-9_-]{0,31}");
	let place = input.place ?? "tab";
	if (!(PLACES as readonly string[]).includes(place)) throw new Error(`invalid place: use ${PLACES.join(", ")}`);
	const agent = agentArgv(host, input);
	const notes: string[] = [];
	const shown: string[] = [];
	if (place !== "hidden") {
		// A terminal carrying these labels shows up in the Herdr app without taking focus.
		const labels = (await hc(host.run, "get", [host.me])).labels ?? {};
		if (!labels["herdr.space"]) {
			place = "hidden";
			notes.push("This session is in no Herdr space, so the agent runs hidden.");
		} else {
			// Shown agents are the user's to close: they outlive this session.
			shown.push("--outlive-parent", "--label", `herdr.space=${labels["herdr.space"]}`);
			if (place === "pane" && labels["herdr.tab"]) shown.push("--label", `herdr.tab=${labels["herdr.tab"]}`);
		}
	}
	const started = await hc(host.run, "run", ["--bg", "--name", input.name, "--cwd", input.cwd ?? host.cwd, ...shown, "--", ...agent.argv]);
	const address = String(started.address);
	if (input.focus && !(await showAgent(host.run, address))) notes.push("It could not be shown: herdr-app did not answer.");
	const profile = [agent.kind, agent.model, input.thinking].filter(Boolean).join(" ");
	return [
		`Started ${input.name} as ${address} (${profile}, ${place}).`,
		...notes,
		input.prompt?.trim()
			? `Its final answer of each turn arrives in your input as <hc from="${address} ${input.name}">. End your turn instead of polling.`
			: "It is idle: send its task with the message tool.",
		`Follow up with the message tool (to: "${address}"). When its work is accepted, close it: hc kill ${address}`,
	].join("\n");
}

/** Types `text` into another terminal and submits it. */
export async function messageAgent(run: Run, input: { to: string; text: string }): Promise<string> {
	if (typeof input.to !== "string" || !input.to.trim() || typeof input.text !== "string" || !input.text.trim()) {
		throw new Error("message needs both to and text");
	}
	const sent = await hc(run, "send", ["--", input.to, input.text], SEND_TIMEOUT_MS);
	return sent.started === false ? `Sent to ${input.to}, but it has not started working on it yet. Check: hc read ${input.to}` : `Sent to ${input.to}.`;
}

/** A child's turn report: its final answer, marked when the turn did not end normally. */
export function reportText(answer: string, reason: string): string {
	const text = answer.length > REPORT_LIMIT ? `${answer.slice(0, REPORT_LIMIT)}\n[Truncated. The full answer is in the agent's session.]` : answer;
	const normal = reason === "answer" || reason === "stop";
	if (!text.trim()) return `(No answer text. The turn ended: ${reason}.)`;
	return normal ? text : `[The turn ended: ${reason}]\n${text}`;
}

/** Sends a finished turn to the parent, once. Resolves a notice to show in the child when it was not delivered. */
export async function sendReport(run: Run, parent: string, answer: string, reason: string): Promise<string | undefined> {
	try {
		await hc(run, "send", ["--", parent, reportText(answer, reason)], SEND_TIMEOUT_MS);
		return undefined;
	} catch (error) {
		return `Report to ${parent} was not delivered: ${error instanceof Error ? error.message : error}`;
	}
}

/** The agents this session started that still run, one line each; undefined when there are none. */
export async function childRoster(run: Run, me: string): Promise<string | undefined> {
	const listed = await hc(run, "ls", []);
	const lines = (Array.isArray(listed.terminals) ? listed.terminals : [])
		.filter((terminal: Record<string, unknown>) => terminal.parent === me)
		.map((terminal: Record<string, unknown>) => `- ${terminal.name ?? "unnamed"} (${terminal.address}, ${terminal.status ?? "no status"})`);
	return lines.length ? lines.join("\n") : undefined;
}
