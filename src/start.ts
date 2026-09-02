import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { verifyChildProfile } from "./child-profile.js";
import { requirePaneCloseSuccess, resolveHerdrBinary, runHerdr } from "./herdr-cli.js";
import {
	DIRECTIONS,
	PLACEMENTS,
	THINKING_LEVELS,
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
const HERDR_READY_TIMEOUT_MS = 30_000;
const COMPENSATION_TIMEOUT_MS = 5_000;
const DEFAULT_AGENT_DIR = join(homedir(), ".pi", "agent");
const MODEL_ALIASES = {
	sol: "openai-codex/gpt-5.6-sol",
	terra: "openai-codex/gpt-5.6-terra",
	luna: "openai-codex/gpt-5.6-luna",
} as const;

type JsonRecord = Record<string, unknown>;

type ValidatedInput = {
	name: string;
	placement: Placement;
	workspace?: string;
	direction?: Direction;
	cwd?: string;
	model?: string;
	thinking?: RequestedThinking;
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

export function expandModelAlias(requested: string): string {
	return MODEL_ALIASES[requested as keyof typeof MODEL_ALIASES] ?? requested;
}

export function selectModel(ctx: ExtensionContext, requested: string | undefined): Model<any> {
	if (requested === undefined) {
		if (!ctx.model) throw new StartAgentError("validation", "canonical model unavailable: controller has no active model");
		const canonical = canonicalModelString(ctx.model);
		const exact = ctx.modelRegistry.find(ctx.model.provider, ctx.model.id);
		if (!exact || canonicalModelString(exact) !== canonical) {
			throw new StartAgentError("validation", "canonical model unavailable: controller model is not in its registry");
		}
		return exact;
	}
	const expanded = expandModelAlias(requested);
	const parsed = parseCanonicalModel(expanded);
	if (!parsed) throw new StartAgentError("validation", "invalid model: use one exact provider/model-id or sol, terra, luna");
	const exact = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!exact || canonicalModelString(exact) !== expanded) {
		throw new StartAgentError("validation", "canonical model unavailable: exact provider/model-id is not known");
	}
	return exact;
}

function selectThinking(model: Model<any>, inherited: RequestedThinking | undefined, requested: RequestedThinking | undefined): RequestedThinking {
	const thinking = requested ?? inherited;
	if (!thinking) throw new StartAgentError("validation", "thinking level unavailable: controller has no active thinking level");
	if (!getSupportedThinkingLevels(model).includes(thinking as never)) {
		throw new StartAgentError("validation", `unsupported thinking level for ${canonicalModelString(model)}`);
	}
	return thinking;
}

function validateInput(input: unknown): ValidatedInput {
	const source = record(input);
	if (!source) throw new StartAgentError("validation", "invalid input: expected an object");
	const allowed = new Set(["name", "placement", "workspace", "direction", "cwd", "model", "thinking"]);
	for (const key of Object.keys(source)) {
		if (!allowed.has(key)) throw new StartAgentError("validation", `invalid input field: ${key}`);
	}
	const name = source.name;
	if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
		throw new StartAgentError("validation", "invalid name: use [a-z][a-z0-9_-]{0,31}");
	}
	const optionalString = (key: "workspace" | "cwd" | "model"): string | undefined => {
		const value = source[key];
		if (value === undefined) return undefined;
		if (typeof value !== "string") throw new StartAgentError("validation", `invalid ${key}: expected a string`);
		return value;
	};
	const rawPlacement = source.placement;
	if (rawPlacement !== undefined && (typeof rawPlacement !== "string" || !PLACEMENTS.includes(rawPlacement as Placement))) {
		throw new StartAgentError("validation", "invalid placement");
	}
	const placement = (rawPlacement ?? "pane") as Placement;
	const rawDirection = source.direction;
	if (rawDirection !== undefined && (typeof rawDirection !== "string" || !DIRECTIONS.includes(rawDirection as Direction))) {
		throw new StartAgentError("validation", "invalid direction");
	}
	const rawThinking = source.thinking;
	if (rawThinking !== undefined && (typeof rawThinking !== "string" || !THINKING_LEVELS.includes(rawThinking as RequestedThinking))) {
		throw new StartAgentError("validation", "invalid thinking level");
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

async function selectProfile(
	ctx: ExtensionContext,
	requestedModel: string | undefined,
	requestedThinking: RequestedThinking | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<SelectedProfile> {
	const model = selectModel(ctx, requestedModel);
	const profile: SelectedProfile = {
		model: canonicalModelString(model),
		thinking: selectThinking(model, ctx.thinkingLevel as RequestedThinking | undefined, requestedThinking),
	};
	await verifyChildProfile(profile, DEFAULT_AGENT_DIR, cwd, signal);
	return profile;
}

export type StartHerdrPiAgentDependencies = {
	selectProfile?: (
		ctx: ExtensionContext,
		requestedModel: string | undefined,
		requestedThinking: RequestedThinking | undefined,
		cwd: string,
		signal: AbortSignal | undefined,
	) => Promise<SelectedProfile>;
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

function expectedPiArgv(name: string, profile: SelectedProfile): string[] {
	return ["--name", name, "--model", profile.model, "--thinking", profile.thinking];
}

function sameArgv(actual: unknown, expected: string[]): boolean {
	return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function validateAgentStarted(result: JsonRecord, name: string, paneId: string, profile: SelectedProfile): void {
	if (result.type !== "agent_started") throw new StartAgentError("startup", "malformed start response: expected agent_started", paneId);
	const agent = record(result.agent);
	if (!agent) throw new StartAgentError("startup", "malformed start response: missing agent", paneId);
	if (agent.name !== name || agent.pane_id !== paneId || agent.agent !== "pi") {
		throw new StartAgentError("startup", "mismatched start response: agent name, kind, or pane", paneId);
	}
	if (agent.interactive_ready !== true || agent.launch_pending === true) {
		throw new StartAgentError("startup", "agent_not_ready", paneId);
	}
	if (!sameArgv(result.argv, ["pi", ...expectedPiArgv(name, profile)])) {
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
	const cwd = normalizeCwd(ctx.cwd, request.cwd);
	const profile = await (dependencies.selectProfile ?? selectProfile)(ctx, request.model, request.thinking, cwd, signal);
	const binary = resolveHerdrBinary();
	let owned: OwnedLocation | undefined;

	try {
		const created = await runHerdr(pi, binary, createArgs(request.placement, request.name, cwd, request.direction, request.workspace), {
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

	try {
		const started = await runHerdr(pi, binary, [
			"agent", "start", request.name, "--kind", "pi", "--pane", owned.paneId,
			"--timeout", String(HERDR_READY_TIMEOUT_MS), "--", ...expectedPiArgv(request.name, profile),
		], { cwd, signal, timeout: START_TIMEOUT_MS, stage: "agent startup" });
		validateAgentStarted(started.result, request.name, owned.paneId, profile);
		const details: StartResultDetails = {
			name: request.name,
			pane: owned.paneId,
			...(owned.tabId ? { tab: owned.tabId } : {}),
			...(owned.workspaceId ? { workspace: owned.workspaceId } : {}),
			model: profile.model,
			thinking: profile.thinking,
			herdr: started.result,
		};
		return { text: JSON.stringify({ name: request.name, pane: owned.paneId }), details };
	} catch (error) {
		const primary = error instanceof Error ? error : new Error("agent startup failed");
		const cleanupFailure = await compensate(pi, binary, owned.paneId, cwd);
		throw combinedFailure(primary, cleanupFailure);
	}
}
