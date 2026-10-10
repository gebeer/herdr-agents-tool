import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StartAgentError } from "../core/errors.js";
import { herdrId } from "../core/herdr.js";
import { AGENT_KINDS, oneOf, resolveCwd, validateStartRequest, type StartRequest } from "../core/request.js";
import { startInNewLocation, type Launch } from "../core/transaction.js";
import { claudeChildLaunch } from "../protocol/claude-child.js";
import {
	MODEL_CONFIG_FILE,
	ModelConfigError,
	mergeModelConfig,
	parseCanonicalModel,
	parseModelConfig,
	resolveModelProfile,
	type ModelConfig,
	type ModelProfile,
	type RequestedThinking,
} from "../protocol/model-config.js";
import { piChildArgv } from "../protocol/pi-child.js";
import { piHerdrHost, resolveHerdrBinary } from "./herdr-cli.js";
import type { SelectedProfile, StartResultDetails } from "./types.js";

// The repo root: the Claude Code plugin Claude children load, and the home of pi children's notifier.
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
		return parseModelConfig(readFileSync(path, "utf8"), path);
	} catch (error) {
		if (error instanceof ModelConfigError) throw new StartAgentError("validation", error.message);
		throw new StartAgentError("validation", `invalid config ${path}: ${error instanceof Error ? error.message : error}`);
	}
}

/** Children run on the orchestrator's profile (PI_CODING_AGENT_DIR), so its herdr-agents.json applies. */
export function loadModelConfig(cwd: string, projectTrusted: boolean, agentDir = getAgentDir()): ModelConfig {
	const paths = [join(agentDir, MODEL_CONFIG_FILE), ...(projectTrusted ? [join(cwd, CONFIG_DIR_NAME, MODEL_CONFIG_FILE)] : [])];
	return mergeModelConfig(paths.map(readModelConfig));
}

/** The registry's model for an exact `provider/model-id`; aliases are already expanded. */
function selectModel(ctx: ExtensionContext, canonical: string): Model<any> {
	const parsed = parseCanonicalModel(canonical);
	if (!parsed) throw new StartAgentError("validation", "invalid model: use one exact provider/model-id or configured alias");
	const exact = ctx.modelRegistry.find(parsed.provider, parsed.id);
	if (!exact || canonicalModelString(exact) !== canonical) {
		throw new StartAgentError("validation", "canonical model unavailable: exact provider/model-id is not known");
	}
	return exact;
}

function selectThinking(model: Model<any>, thinking: RequestedThinking): RequestedThinking {
	if (!getSupportedThinkingLevels(model).includes(thinking)) {
		throw new StartAgentError("validation", `unsupported thinking level for ${canonicalModelString(model)}`);
	}
	return thinking;
}

/** The requested profile if pi's registry knows it, else the configured fallback. */
export function selectProfileFromConfig(
	ctx: ExtensionContext,
	config: ModelConfig,
	requestedModel: string | undefined,
	requestedThinking: RequestedThinking | undefined,
): SelectedProfile {
	const check = (candidate: ModelProfile): SelectedProfile => {
		const model = selectModel(ctx, candidate.model);
		return { model: canonicalModelString(model), thinking: selectThinking(model, candidate.thinking) };
	};

	const requested = resolveModelProfile(config, requestedModel, requestedThinking);
	if (requestedModel === undefined) {
		try {
			const selected = check(requested);
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
			throw new StartAgentError("validation", `fallback profile ${requested.model} (${requested.thinking}) failed: ${reason}`);
		}
	}

	try {
		return check(requested);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "profile validation failed";
		try {
			const selected = check(config.fallback);
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

function selectProfile(
	ctx: ExtensionContext,
	requestedModel: string | undefined,
	requestedThinking: RequestedThinking | undefined,
): SelectedProfile {
	// Trust is evaluated for the orchestrator's project, so that is where project config comes from.
	return selectProfileFromConfig(ctx, loadModelConfig(ctx.cwd, ctx.isProjectTrusted()), requestedModel, requestedThinking);
}

/** Claude children skip profile selection: Claude Code takes the model and effort as given. */
function claudeLaunch(request: StartRequest, parentPane: string) {
	try {
		return { kind: "claude", ...claudeChildLaunch(request.name, parentPane, PLUGIN_ROOT, request.model, request.thinking, "bypassPermissions") };
	} catch (error) {
		throw new StartAgentError("validation", error instanceof Error ? error.message : String(error));
	}
}

/** Pi's start tool: pi profile selection (pi children only), then the shared Herdr transaction. */
export async function startHerdrPiAgent(
	pi: Pick<ExtensionAPI, "exec">,
	input: Record<string, unknown>,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	select: typeof selectProfile = selectProfile,
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
		profile = select(ctx, request.model, request.thinking);
		const argv = piChildArgv({ name: request.name, model: profile.model, thinking: profile.thinking, parentPane, pluginRoot: PLUGIN_ROOT });
		launch = { kind: "pi", argv, env: { PI_CODING_AGENT_DIR: getAgentDir() } };
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
