import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { verifyChildProfile } from "./child-profile.js";
import { requirePaneCloseSuccess, resolveHerdrBinary, runHerdr } from "./herdr-cli.js";
import {
	DIRECTIONS,
	PLACEMENTS,
	THINKING_LEVELS,
	TOOL_NAME,
	type Direction,
	type HerdrStartAgentInput,
	type OwnedLocation,
	type Placement,
	type RequestedThinking,
	type SelectedProfile,
	StartAgentError,
	type StartResultDetails,
} from "./types.js";

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const CREATE_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 35_000;
const PROMPT_TIMEOUT_MS = 10_000;
const HERDR_READY_TIMEOUT_MS = 30_000;
const COMPENSATION_TIMEOUT_MS = 5_000;
const DEFAULT_AGENT_DIR = join(homedir(), ".pi", "agent");
const CONFIG_FILE = "herdr-agents.json";
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]*$/;

export type ModelProfile = {
	model: string;
	thinking: RequestedThinking;
};

export type ModelConfig = {
	fallback: ModelProfile;
	aliases: Record<string, ModelProfile>;
};

const DEFAULT_MODEL_CONFIG: ModelConfig = {
	fallback: { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
	aliases: {
		sol: { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
		terra: { model: "openai-codex/gpt-5.6-terra", thinking: "medium" },
		luna: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
	},
};

type JsonRecord = Record<string, unknown>;

type ValidatedInput = {
	name: string;
	placement: Placement;
	workspace?: string;
	direction?: Direction;
	cwd?: string;
	model?: string;
	thinking?: RequestedThinking;
	prompt?: string;
};

function record(value: unknown): JsonRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: undefined;
}

function id(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value === value.trim() && !/[\0\r\n]/.test(value)
		? value
		: undefined;
}

function requireId(value: unknown, label: string, ownedPaneId?: string): string {
	const found = id(value);
	if (!found) throw new StartAgentError("layout", `malformed create response: missing ${label}`, ownedPaneId);
	return found;
}

function requireRecord(value: unknown, label: string, ownedPaneId?: string): JsonRecord {
	const found = record(value);
	if (!found) throw new StartAgentError("layout", `malformed create response: missing ${label}`, ownedPaneId);
	return found;
}

function requireResultType(result: JsonRecord, expected: string): void {
	if (result.type !== expected) throw new StartAgentError("layout", `malformed create response: expected ${expected}`);
}

function normalizeCwd(cwd: string, requested: string | undefined): string {
	const candidate = requested === undefined ? cwd : resolve(cwd, requested);
	if (!isAbsolute(candidate)) throw new StartAgentError("validation", "invalid cwd: must resolve to an absolute path");
	try {
		const canonical = realpathSync(candidate);
		if (!statSync(canonical).isDirectory()) throw new Error("not directory");
		return canonical;
	} catch {
		throw new StartAgentError("validation", "invalid cwd: must be an existing directory");
	}
}

function canonicalModelString(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function parseCanonicalModel(input: string): { provider: string; id: string } | undefined {
	if (input !== input.trim() || /\s/.test(input)) return undefined;
	const slash = input.indexOf("/");
	if (slash < 1 || slash === input.length - 1) return undefined;
	const provider = input.slice(0, slash);
	const id = input.slice(slash + 1);
	if (!/^[a-z0-9][a-z0-9._-]*$/i.test(provider) || !id || /[*?\[\]{}]/.test(id)) return undefined;
	return { provider, id };
}

function modelProfile(value: unknown, label: string): ModelProfile {
	const profile = record(value);
	if (!profile || Object.keys(profile).some((key) => key !== "model" && key !== "thinking")) {
		throw new StartAgentError("validation", `invalid ${label}: expected model and thinking`);
	}
	if (typeof profile.model !== "string" || !parseCanonicalModel(profile.model)) {
		throw new StartAgentError("validation", `invalid ${label}.model: use one exact provider/model-id`);
	}
	if (typeof profile.thinking !== "string" || !THINKING_LEVELS.includes(profile.thinking as RequestedThinking)) {
		throw new StartAgentError("validation", `invalid ${label}.thinking`);
	}
	return { model: profile.model, thinking: profile.thinking as RequestedThinking };
}

function readModelConfig(path: string): Partial<ModelConfig> {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new StartAgentError("validation", `invalid config ${path}: ${error instanceof Error ? error.message : error}`);
	}
	const source = record(parsed);
	if (!source || Object.keys(source).some((key) => key !== "fallback" && key !== "aliases")) {
		throw new StartAgentError("validation", `invalid config ${path}: expected fallback and aliases`);
	}
	const config: Partial<ModelConfig> = {};
	if (source.fallback !== undefined) config.fallback = modelProfile(source.fallback, `${path} fallback`);
	if (source.aliases !== undefined) {
		const aliases = record(source.aliases);
		if (!aliases) throw new StartAgentError("validation", `invalid ${path} aliases: expected an object`);
		config.aliases = {};
		for (const [name, profile] of Object.entries(aliases)) {
			if (!ALIAS_PATTERN.test(name)) throw new StartAgentError("validation", `invalid ${path} alias: ${name}`);
			config.aliases[name] = modelProfile(profile, `${path} alias ${name}`);
		}
	}
	return config;
}

export function loadModelConfig(cwd: string, projectTrusted: boolean, agentDir = getAgentDir()): ModelConfig {
	let config: ModelConfig = {
		fallback: { ...DEFAULT_MODEL_CONFIG.fallback },
		aliases: { ...DEFAULT_MODEL_CONFIG.aliases },
	};
	for (const path of [join(agentDir, CONFIG_FILE), ...(projectTrusted ? [join(cwd, CONFIG_DIR_NAME, CONFIG_FILE)] : [])]) {
		const override = readModelConfig(path);
		config = {
			fallback: override.fallback ?? config.fallback,
			aliases: { ...config.aliases, ...override.aliases },
		};
	}
	return config;
}

export function expandModelAlias(requested: string, aliases = DEFAULT_MODEL_CONFIG.aliases): string {
	return Object.hasOwn(aliases, requested) ? aliases[requested]!.model : requested;
}

export function resolveModelProfile(
	config: ModelConfig,
	requestedModel: string | undefined,
	requestedThinking: RequestedThinking | undefined,
): ModelProfile {
	const configured = requestedModel !== undefined && Object.hasOwn(config.aliases, requestedModel)
		? config.aliases[requestedModel]!
		: config.fallback;
	return {
		model: requestedModel === undefined ? config.fallback.model : expandModelAlias(requestedModel, config.aliases),
		thinking: requestedThinking ?? configured.thinking,
	};
}

export function selectModel(ctx: ExtensionContext, requested: string, aliases = DEFAULT_MODEL_CONFIG.aliases): Model<any> {
	const expanded = expandModelAlias(requested, aliases);
	const parsed = parseCanonicalModel(expanded);
	if (!parsed) throw new StartAgentError("validation", "invalid model: use one exact provider/model-id or configured alias");
	const exact = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!exact || canonicalModelString(exact) !== expanded) {
		throw new StartAgentError("validation", "canonical model unavailable: exact provider/model-id is not known");
	}
	return exact;
}

function selectThinking(model: Model<any>, thinking: RequestedThinking): RequestedThinking {
	if (!getSupportedThinkingLevels(model).includes(thinking as never)) {
		throw new StartAgentError("validation", `unsupported thinking level for ${canonicalModelString(model)}`);
	}
	return thinking;
}

function validateInput(input: unknown): ValidatedInput {
	const source = record(input);
	if (!source) throw new StartAgentError("validation", "invalid input: expected an object");
	const allowed = new Set(["name", "placement", "workspace", "direction", "cwd", "model", "thinking", "prompt"]);
	for (const key of Object.keys(source)) {
		if (!allowed.has(key)) throw new StartAgentError("validation", `invalid input field: ${key}`);
	}
	const name = source.name;
	if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
		throw new StartAgentError("validation", "invalid name: use [a-z][a-z0-9_-]{0,31}");
	}
	const optionalString = (key: "workspace" | "cwd" | "model" | "prompt"): string | undefined => {
		const value = source[key];
		if (value === undefined) return undefined;
		if (typeof value !== "string") throw new StartAgentError("validation", `invalid ${key}: expected a string`);
		return value;
	};
	const rawPlacement = source.placement;
	if (rawPlacement !== undefined && (typeof rawPlacement !== "string" || !PLACEMENTS.includes(rawPlacement as Placement))) {
		throw new StartAgentError("validation", "invalid placement");
	}
	const placement = (rawPlacement ?? "tab") as Placement;
	const rawDirection = source.direction;
	if (rawDirection !== undefined && (typeof rawDirection !== "string" || !DIRECTIONS.includes(rawDirection as Direction))) {
		throw new StartAgentError("validation", "invalid direction");
	}
	const rawThinking = source.thinking;
	if (rawThinking !== undefined && (typeof rawThinking !== "string" || !THINKING_LEVELS.includes(rawThinking as RequestedThinking))) {
		throw new StartAgentError("validation", "invalid thinking level");
	}
	const prompt = optionalString("prompt");
	if (prompt !== undefined && (!prompt.trim() || prompt.includes("\0"))) {
		throw new StartAgentError("validation", "invalid prompt: expected nonblank text without NUL bytes");
	}
	const workspace = optionalString("workspace");
	const direction = rawDirection as Direction | undefined;
	if (workspace !== undefined && placement !== "tab") throw new StartAgentError("validation", "invalid field combination: workspace applies only to tab placement");
	if (direction !== undefined && placement !== "pane") throw new StartAgentError("validation", "invalid field combination: direction applies only to pane placement");
	const common = {
		name,
		placement,
		cwd: optionalString("cwd"),
		model: optionalString("model"),
		thinking: rawThinking as RequestedThinking | undefined,
		prompt,
	};
	switch (placement) {
		case "pane": return { ...common, direction: direction ?? "right" };
		case "tab": {
			const targetWorkspace = workspace ?? process.env.HERDR_WORKSPACE_ID;
			if (!id(targetWorkspace)) throw new StartAgentError("validation", "invalid Herdr context: workspace is unavailable");
			return { ...common, workspace: targetWorkspace };
		}
		case "workspace": return common;
		default: throw new StartAgentError("validation", "invalid placement");
	}
}

type VerifyProfile = typeof verifyChildProfile;

export async function selectProfileFromConfig(
	ctx: ExtensionContext,
	config: ModelConfig,
	requestedModel: string | undefined,
	requestedThinking: RequestedThinking | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	verifyProfile: VerifyProfile = verifyChildProfile,
): Promise<SelectedProfile> {
	const check = async (candidate: ModelProfile): Promise<SelectedProfile> => {
		const model = selectModel(ctx, candidate.model, config.aliases);
		const profile = {
			model: canonicalModelString(model),
			thinking: selectThinking(model, candidate.thinking),
		};
		await verifyProfile(profile, DEFAULT_AGENT_DIR, cwd, signal);
		return profile;
	};

	if (requestedModel === undefined) {
		try {
			const candidate = { ...config.fallback, thinking: requestedThinking ?? config.fallback.thinking };
			const selected = await check(candidate);
			return {
				...selected,
				fallback: {
					requested: requestedThinking === undefined ? {} : { thinking: requestedThinking },
					selected,
					reason: "model omitted",
				},
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : "profile validation failed";
			throw new StartAgentError("validation", `fallback profile ${config.fallback.model} (${requestedThinking ?? config.fallback.thinking}) failed: ${reason}`);
		}
	}

	const requested = resolveModelProfile(config, requestedModel, requestedThinking);
	try {
		return await check(requested);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "profile validation failed";
		try {
			const selected = await check(config.fallback);
			return {
				...selected,
				fallback: {
					requested: { model: requestedModel, thinking: requested.thinking },
					selected,
					reason,
				},
			};
		} catch (fallbackError) {
			const fallbackReason = fallbackError instanceof Error ? fallbackError.message : "profile validation failed";
			throw new StartAgentError(
				"validation",
				`requested profile ${requested.model} (${requested.thinking}) failed: ${reason}; fallback profile ${config.fallback.model} (${config.fallback.thinking}) failed: ${fallbackReason}`,
			);
		}
	}
}

export function selectProfile(
	ctx: ExtensionContext,
	requestedModel: string | undefined,
	requestedThinking: RequestedThinking | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	verifyProfile: VerifyProfile = verifyChildProfile,
): Promise<SelectedProfile> {
	return selectProfileFromConfig(
		ctx,
		loadModelConfig(cwd, ctx.isProjectTrusted()),
		requestedModel,
		requestedThinking,
		cwd,
		signal,
		verifyProfile,
	);
}

export type StartHerdrPiAgentDependencies = {
	selectProfile?: (
		ctx: ExtensionContext,
		requestedModel: string | undefined,
		requestedThinking: RequestedThinking | undefined,
		cwd: string,
		signal: AbortSignal | undefined,
	) => Promise<SelectedProfile>;
	verifyProfile?: VerifyProfile;
};

function parseCreatedLocation(placement: Placement, result: JsonRecord): OwnedLocation {
	try {
		switch (placement) {
			case "pane": {
				requireResultType(result, "pane_info");
				const pane = requireRecord(result.pane, "pane");
				return { paneId: requireId(pane.pane_id, "pane.pane_id") };
			}
			case "tab": {
				requireResultType(result, "tab_created");
				const rootPane = requireRecord(result.root_pane, "root_pane");
				const paneId = requireId(rootPane.pane_id, "root_pane.pane_id");
				const tab = requireRecord(result.tab, "tab", paneId);
				return { paneId, tabId: requireId(tab.tab_id, "tab.tab_id", paneId) };
			}
			case "workspace": {
				requireResultType(result, "workspace_created");
				const rootPane = requireRecord(result.root_pane, "root_pane");
				const paneId = requireId(rootPane.pane_id, "root_pane.pane_id");
				const tab = requireRecord(result.tab, "tab", paneId);
				const workspace = requireRecord(result.workspace, "workspace", paneId);
				return {
					paneId,
					tabId: requireId(tab.tab_id, "tab.tab_id", paneId),
					workspaceId: requireId(workspace.workspace_id, "workspace.workspace_id", paneId),
				};
			}
			default: throw new StartAgentError("validation", "invalid placement");
		}
	} catch (error) {
		if (error instanceof StartAgentError && error.ownedPaneId) throw error;
		throw new StartAgentError("uncertain-create", "malformed create response: ownership was not proven");
	}
}

function createArgs(
	placement: Placement,
	name: string,
	cwd: string,
	direction: Direction | undefined,
	workspace: string | undefined,
): string[] {
	switch (placement) {
		case "pane": return ["pane", "split", "--current", "--direction", direction!, "--cwd", cwd, "--no-focus"];
		case "tab": return ["tab", "create", "--workspace", workspace!, "--cwd", cwd, "--label", name, "--no-focus"];
		case "workspace": return ["workspace", "create", "--cwd", cwd, "--label", name, "--no-focus"];
		default: throw new StartAgentError("validation", "invalid placement");
	}
}

function expectedPiArgv(name: string, profile: SelectedProfile, parentPane: string): string[] {
	return [
		"--name", name, "--model", profile.model, "--thinking", profile.thinking,
		"--exclude-tools", TOOL_NAME,
		"--extension", fileURLToPath(new URL("./child-notify.ts", import.meta.url)),
		"--herdr-parent-pane", parentPane,
		"--append-system-prompt", `You are a subagent. Do not spawn additional subagents. Your orchestrator is in Herdr pane ${parentPane}. Automatic completion reporting is installed; do not send a separate completion notification.`,
	];
}

function sameArgv(actual: unknown, expected: string[]): boolean {
	return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function validateAgentStarted(result: JsonRecord, name: string, paneId: string, argv: string[]): void {
	if (result.type !== "agent_started") throw new StartAgentError("startup", "malformed start response: expected agent_started", paneId);
	const agent = record(result.agent);
	if (!agent) throw new StartAgentError("startup", "malformed start response: missing agent", paneId);
	if (agent.name !== name || agent.pane_id !== paneId || agent.agent !== "pi") {
		throw new StartAgentError("startup", "mismatched start response: agent name, kind, or pane", paneId);
	}
	if (agent.interactive_ready !== true || agent.launch_pending === true) {
		throw new StartAgentError("startup", "agent_not_ready", paneId);
	}
	if (!sameArgv(result.argv, ["pi", ...argv])) {
		throw new StartAgentError("startup", "mismatched start response: argv", paneId);
	}
}

async function compensate(pi: Pick<ExtensionAPI, "exec">, binary: string, paneId: string, cwd: string): Promise<string | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), COMPENSATION_TIMEOUT_MS);
	try {
		const closed = await runHerdr(pi, binary, ["pane", "close", paneId], {
			cwd,
			signal: controller.signal,
			timeout: COMPENSATION_TIMEOUT_MS,
			stage: "compensation",
		});
		requirePaneCloseSuccess(closed);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : "compensation failed";
	} finally {
		clearTimeout(timer);
	}
}

function combinedFailure(primary: Error, cleanupFailure: string | undefined): Error {
	return cleanupFailure
		? new Error(`${primary.message}; compensation failed: ${cleanupFailure}`)
		: new Error(`${primary.message}; compensation closed created pane`);
}

/** One bounded create/start transaction. It deliberately retains no post-return state. */
export async function startHerdrPiAgent(
	pi: Pick<ExtensionAPI, "exec">,
	input: HerdrStartAgentInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	dependencies: StartHerdrPiAgentDependencies = {},
): Promise<{ text: string; details: StartResultDetails }> {
	const request = validateInput(input);
	const parentPane = id(process.env.HERDR_PANE_ID);
	if (!parentPane) throw new StartAgentError("validation", "invalid Herdr context: orchestrator pane is unavailable");
	const cwd = normalizeCwd(ctx.cwd, request.cwd);
	const profile = dependencies.selectProfile
		? await dependencies.selectProfile(ctx, request.model, request.thinking, cwd, signal)
		: await selectProfile(ctx, request.model, request.thinking, cwd, signal, dependencies.verifyProfile);
	const binary = resolveHerdrBinary();
	const argv = expectedPiArgv(request.name, profile, parentPane);
	let owned: OwnedLocation | undefined;

	try {
		const created = await runHerdr(pi, binary, [
			...createArgs(request.placement, request.name, cwd, request.direction, request.workspace),
			"--env", `PI_CODING_AGENT_DIR=${DEFAULT_AGENT_DIR}`,
		], {
			cwd,
			signal,
			timeout: CREATE_TIMEOUT_MS,
			stage: "layout create",
		});
		owned = parseCreatedLocation(request.placement, created.result);
		if (created.lateCompletion) {
			throw new StartAgentError("layout", `layout create: ${created.lateCompletion}`, owned.paneId);
		}
	} catch (error) {
		const failure = error instanceof StartAgentError ? error : new StartAgentError("layout", "layout failure");
		if (!failure.ownedPaneId) {
			if (failure.kind === "uncertain-create") throw new Error(`${failure.message}; creation outcome is uncertain and no pane was closed`);
			throw new Error(failure.message);
		}
		const cleanupFailure = await compensate(pi, binary, failure.ownedPaneId, cwd);
		throw combinedFailure(failure, cleanupFailure);
	}

	let started;
	try {
		started = await runHerdr(pi, binary, [
			"agent", "start", request.name, "--kind", "pi", "--pane", owned.paneId,
			"--timeout", String(HERDR_READY_TIMEOUT_MS), "--", ...argv,
		], { cwd, signal, timeout: START_TIMEOUT_MS, stage: "agent startup" });
		validateAgentStarted(started.result, request.name, owned.paneId, argv);
	} catch (error) {
		const primary = error instanceof Error ? error : new Error("agent startup failed");
		const cleanupFailure = await compensate(pi, binary, owned.paneId, cwd);
		throw combinedFailure(primary, cleanupFailure);
	}

	// Once ready, never roll back or retry: a failed prompt acknowledgement may hide delivered work.
	if (request.prompt !== undefined) {
		try {
			signal?.throwIfAborted();
			const prompted = await runHerdr(pi, binary, ["agent", "prompt", request.name, request.prompt], {
				cwd, signal, timeout: PROMPT_TIMEOUT_MS, stage: "prompt submission",
			});
			const agent = record(prompted.result.agent);
			if (prompted.result.type !== "agent_prompted" || agent?.name !== request.name ||
				agent.pane_id !== owned.paneId || agent.agent !== "pi") {
				throw new Error("malformed or mismatched agent_prompted response");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "prompt submission failed";
			throw new Error(`${message}; agent ${request.name} in pane ${owned.paneId} left running; prompt delivery may be uncertain; inspect before retrying`);
		}
	}

	const submission = request.prompt !== undefined ? { promptSubmitted: true as const } : {};
	const details: StartResultDetails = {
		name: request.name,
		pane: owned.paneId,
		...(owned.tabId ? { tab: owned.tabId } : {}),
		...(owned.workspaceId ? { workspace: owned.workspaceId } : {}),
		model: profile.model,
		thinking: profile.thinking,
		herdr: started.result,
		...(profile.fallback ? { fallback: profile.fallback } : {}),
		...submission,
	};
	return {
		text: JSON.stringify({
			name: request.name,
			pane: owned.paneId,
			...(profile.fallback ? { fallback: profile.fallback } : {}),
			...submission,
		}),
		details,
	};
}
