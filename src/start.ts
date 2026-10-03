import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { herdrId } from "../core/herdr.js";
import { oneOf, resolveCwd, validateStartRequest, type StartRequest } from "../core/request.js";
import { startInNewLocation, type Launch } from "../core/transaction.js";
import { claudeChildLaunch } from "../protocol/claude-child.js";
import {
	DEFAULT_MODEL_CONFIG,
	MODEL_CONFIG_FILE,
	ModelConfigError,
	expandModelAlias,
	mergeModelConfig,
	parseCanonicalModel,
	parseModelConfig,
	resolveModelProfile,
	type ModelConfig,
	type ModelProfile,
} from "../protocol/model-config.js";
import { piChildArgv } from "../protocol/pi-child.js";
import { verifyChildProfile } from "./child-profile.js";
import { piHerdrHost, resolveHerdrBinary } from "./herdr-cli.js";
import {
	AGENT_KINDS,
	type HerdrStartAgentInput,
	type RequestedThinking,
	type SelectedProfile,
	StartAgentError,
	type StartResultDetails,
} from "./types.js";

export { expandModelAlias, resolveModelProfile, type ModelConfig, type ModelProfile } from "../protocol/model-config.js";

const DEFAULT_AGENT_DIR = join(homedir(), ".pi", "agent");
// The repo root, which is also the Claude Code plugin Claude children load.
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The canonical path of an existing directory, else undefined. */
async function realDirectory(path: string): Promise<string | undefined> {
	try {
		const canonical = realpathSync(path);
		return statSync(canonical).isDirectory() ? canonical : undefined;
	} catch {
		return undefined;
	}
}

function canonicalModelString(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function readModelConfig(path: string): Partial<ModelConfig> {
	if (!existsSync(path)) return {};
	try {
		return parseModelConfig(JSON.parse(readFileSync(path, "utf8")), path);
	} catch (error) {
		if (error instanceof ModelConfigError) throw new StartAgentError("validation", error.message);
		throw new StartAgentError("validation", `invalid config ${path}: ${error instanceof Error ? error.message : error}`);
	}
}

/** Children always run on the default profile, so its herdr-agents.json applies even under another orchestrator profile (pi-clawa). */
export function loadModelConfig(cwd: string, projectTrusted: boolean, agentDir = DEFAULT_AGENT_DIR): ModelConfig {
	const paths = [join(agentDir, MODEL_CONFIG_FILE), ...(projectTrusted ? [join(cwd, CONFIG_DIR_NAME, MODEL_CONFIG_FILE)] : [])];
	return mergeModelConfig(paths.map(readModelConfig));
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
		// Trust is evaluated for the orchestrator's project, so that is where project config comes from.
		loadModelConfig(ctx.cwd, ctx.isProjectTrusted()),
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

function expectedPiArgv(name: string, profile: SelectedProfile, parentPane: string): string[] {
	return piChildArgv({
		name, model: profile.model, thinking: profile.thinking, parentPane,
		notifierPath: fileURLToPath(new URL("./child-notify.ts", import.meta.url)),
	});
}

/** Claude children skip profile selection and preflight: Claude Code takes the model and effort as given. */
function claudeLaunch(request: StartRequest, parentPane: string) {
	try {
		return { kind: "claude", ...claudeChildLaunch(request.name, parentPane, PLUGIN_ROOT, request.model, request.thinking, "bypassPermissions") };
	} catch (error) {
		throw new StartAgentError("validation", error instanceof Error ? error.message : String(error));
	}
}

/** Pi's start tool: pi profile selection and preflight (pi children only), then the shared Herdr transaction. */
export async function startHerdrPiAgent(
	pi: Pick<ExtensionAPI, "exec">,
	input: HerdrStartAgentInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	dependencies: StartHerdrPiAgentDependencies = {},
): Promise<{ text: string; details: StartResultDetails }> {
	const { kind: rawKind, ...shared } = input;
	const kind = oneOf(AGENT_KINDS, rawKind, "kind") ?? "pi";
	const request = validateStartRequest(shared, process.env.HERDR_WORKSPACE_ID);
	const parentPane = herdrId(process.env.HERDR_PANE_ID);
	if (!parentPane) throw new StartAgentError("validation", "invalid Herdr context: orchestrator pane is unavailable");
	const cwd = await resolveCwd(realDirectory, ctx.cwd, request.cwd);
	let profile: SelectedProfile | undefined;
	let launch: Launch;
	if (kind === "claude") {
		launch = claudeLaunch(request, parentPane);
	} else {
		profile = dependencies.selectProfile
			? await dependencies.selectProfile(ctx, request.model, request.thinking, cwd, signal)
			: await selectProfile(ctx, request.model, request.thinking, cwd, signal, dependencies.verifyProfile);
		launch = { kind: "pi", argv: expectedPiArgv(request.name, profile, parentPane), env: { PI_CODING_AGENT_DIR: DEFAULT_AGENT_DIR } };
	}
	const started = await startInNewLocation(piHerdrHost(pi, resolveHerdrBinary()), request, cwd, launch, signal);

	const submission = request.prompt !== undefined ? { promptSubmitted: true as const } : {};
	const { model, thinking } = profile ?? request;
	const given = { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
	const details: StartResultDetails = {
		name: request.name,
		pane: started.paneId,
		...(started.tabId ? { tab: started.tabId } : {}),
		...(started.workspaceId ? { workspace: started.workspaceId } : {}),
		...given,
		herdr: started.herdr,
		...(profile?.fallback ? { fallback: profile.fallback } : {}),
		...submission,
	};
	return {
		text: JSON.stringify({
			name: request.name,
			pane: started.paneId,
			...(profile ? {} : given),
			...(profile?.fallback ? { fallback: profile.fallback } : {}),
			...submission,
		}),
		details,
	};
}
