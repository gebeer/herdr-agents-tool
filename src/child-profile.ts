import { spawn } from "node:child_process";
import { StartAgentError } from "../core/errors.js";
import { record } from "../core/herdr.js";
import type { SelectedProfile } from "./types.js";

const PROFILE_CHECK_TIMEOUT_MS = 15_000;

type ChildProcessResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
};

type RuntimeUrls = { codingAgent: string; ai: string };

const CHILD_PROFILE_CHECK = String.raw`
const [agentDir, cwd, expectedModel, expectedThinking, codingAgentUrl, aiUrl] = process.argv.slice(1);
const fail = (message) => {
	process.stdout.write(JSON.stringify({ ok: false, message }) + "\n");
	process.exitCode = 1;
};
try {
	const { join } = await import("node:path");
	const { readFileSync } = await import("node:fs");
	const { createAgentSessionServices, readStoredCredential, resolveCliModel, SettingsManager } = await import(codingAgentUrl);
	const { getSupportedThinkingLevels } = await import(aiUrl);
	const slash = expectedModel.indexOf("/");
	if (slash < 1 || slash === expectedModel.length - 1) throw new Error("invalid canonical model");
	const provider = expectedModel.slice(0, slash);
	const modelId = expectedModel.slice(slash + 1);
	const unsafeConfigValue = (value) => {
		if (typeof value !== "string" || value.startsWith("!")) return true;
		for (let index = 0; index < value.length; index++) {
			if (value[index] !== "$") continue;
			const next = value[index + 1];
			if (next === "$" || next === "!") {
				index++;
				continue;
			}
			if (next === "{") {
				const end = value.indexOf("}", index + 2);
				if (end > index + 2 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.slice(index + 2, end))) return true;
				continue;
			}
			if (next && /^[A-Za-z_]$/.test(next)) return true;
		}
		return false;
	};
	const unsafeModelAuthConfig = () => {
		let config;
		try {
			config = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		} catch (error) {
			if (error && typeof error === "object" && error.code === "ENOENT") return false;
			throw error;
		}
		const providerConfig = config?.providers?.[provider];
		if (!providerConfig || typeof providerConfig !== "object") return false;
		const values = [providerConfig.apiKey, ...Object.values(providerConfig.headers ?? {})];
		const configuredModel = Array.isArray(providerConfig.models)
			? providerConfig.models.filter((entry) => entry?.id === modelId)
			: [];
		for (const entry of configuredModel) values.push(...Object.values(entry.headers ?? {}));
		values.push(...Object.values(providerConfig.modelOverrides?.[modelId]?.headers ?? {}));
		return values.filter((value) => value !== undefined).some(unsafeConfigValue);
	};
	if (unsafeModelAuthConfig()) {
		throw new Error("child profile authentication must not use environment- or command-sourced provider/model configuration");
	}
	const credential = readStoredCredential(provider, join(agentDir, "auth.json"));
	const shareableApiKey = credential?.type === "api_key" &&
		typeof credential.key === "string" && credential.key.length > 0 &&
		!credential.key.includes("$") && !credential.key.startsWith("!") && credential.env === undefined;
	const shareableOAuth = credential?.type === "oauth" &&
		typeof credential.access === "string" && credential.access.length > 0 &&
		typeof credential.refresh === "string" && credential.refresh.length > 0 &&
		typeof credential.expires === "number" && Number.isFinite(credential.expires) && credential.env === undefined;
	if (!shareableApiKey && !shareableOAuth) {
		throw new Error("child profile authentication must be a stored literal API key or OAuth credential");
	}
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		// Preflight must not load caller-controlled project settings or resources.
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: false }),
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
		modelRuntimeSignal: AbortSignal.timeout(10000),
	});
	if (services.modelRuntime.getError()) throw new Error("child profile model configuration is invalid");
	const resolved = resolveCliModel({ cliModel: expectedModel, modelRuntime: services.modelRuntime });
	const model = services.modelRuntime.getModel(provider, modelId);
	if (!model || resolved.error || resolved.warning || !resolved.model ||
		resolved.model.provider !== provider || resolved.model.id !== modelId) {
		throw new Error("child profile does not resolve the exact requested model");
	}
	if (!getSupportedThinkingLevels(model).includes(expectedThinking)) {
		throw new Error("child profile does not support the requested thinking level");
	}
	const requestAuth = await services.modelRuntime.getAuth(model, {
		signal: AbortSignal.timeout(10000),
		minOAuthValidityMs: 300000,
	});
	const hasApiKey = typeof requestAuth?.auth?.apiKey === "string" && requestAuth.auth.apiKey.length > 0;
	const hasAuthHeader = Object.values(requestAuth?.auth?.headers ?? {}).some((value) => typeof value === "string" && value.length > 0);
	if (!requestAuth || !requestAuth.auth || (!hasApiKey && !hasAuthHeader)) {
		throw new Error("child profile authentication is not ready");
	}
	const expectedSource = credential.type === "api_key" ? "stored credential" : "OAuth";
	if (requestAuth.source !== expectedSource || requestAuth.env !== undefined) {
		throw new Error("child profile authentication is not derived solely from the stored credential");
	}
	process.stdout.write(JSON.stringify({ ok: true, model: expectedModel, thinking: expectedThinking }) + "\n");
} catch (error) {
	fail(error instanceof Error ? error.message : "child profile check failed");
}
`;

type ProfileCheckResult = {
	ok: boolean;
	model?: unknown;
	thinking?: unknown;
	message?: unknown;
};

function parseProfileCheck(stdout: string): ProfileCheckResult | undefined {
	const line = stdout.trimEnd().split("\n").at(-1);
	if (!line) return undefined;
	try {
		return record(JSON.parse(line)) as ProfileCheckResult | undefined;
	} catch {
		return undefined;
	}
}

const spawnChildProfileCheck = (
	command: string,
	args: string[],
	options: { cwd: string; signal?: AbortSignal; timeout: number },
) => new Promise<ChildProcessResult>((resolve, reject) => {
	if (options.signal?.aborted) {
		resolve({ stdout: "", stderr: "", code: 1, killed: true });
		return;
	}
	const child = spawn(command, args, {
		cwd: options.cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let aborted = false;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => { stdout += chunk; });
	child.stderr.on("data", (chunk: string) => { stderr += chunk; });
	const stop = (timeout: boolean) => {
		timedOut ||= timeout;
		aborted ||= !timeout;
		child.kill("SIGTERM");
	};
	const timer = setTimeout(() => stop(true), options.timeout);
	const onAbort = () => stop(false);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	child.once("error", (error) => {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		reject(error);
	});
	child.once("close", (code, childSignal) => {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		resolve({ stdout, stderr, code: code ?? 1, killed: timedOut || aborted || childSignal !== null });
	});
});

function defaultRuntimeUrls(): RuntimeUrls {
	try {
		return {
			codingAgent: import.meta.resolve("@earendil-works/pi-coding-agent"),
			ai: import.meta.resolve("@earendil-works/pi-ai"),
		};
	} catch {
		throw new StartAgentError("validation", "child profile check is unavailable: cannot resolve Pi runtime");
	}
}

/** Validate exact model resolution, requested thinking, and usable request auth. */
export async function verifyChildProfile(
	profile: SelectedProfile,
	childAgentDir: string,
	cwd: string,
	signal: AbortSignal | undefined,
	runtimeUrls: RuntimeUrls = defaultRuntimeUrls(),
): Promise<void> {
	let result: ChildProcessResult;
	try {
		result = await spawnChildProfileCheck(process.execPath, [
			"--input-type=module", "--eval", CHILD_PROFILE_CHECK,
			childAgentDir, cwd, profile.model, profile.thinking, runtimeUrls.codingAgent, runtimeUrls.ai,
		], { cwd, signal, timeout: PROFILE_CHECK_TIMEOUT_MS });
	} catch {
		throw new StartAgentError("validation", "child profile check failed to run");
	}
	if (result.killed || signal?.aborted) {
		throw new StartAgentError("validation", `child profile check ${signal?.aborted ? "aborted" : "timed out"}`);
	}
	const checked = parseProfileCheck(result.stdout);
	if (result.code !== 0 || !checked?.ok || checked.model !== profile.model || checked.thinking !== profile.thinking) {
		const detail = typeof checked?.message === "string" ? checked.message : "child profile check returned an invalid response";
		throw new StartAgentError("validation", `missing child profile/model parity: ${detail}`);
	}
}
