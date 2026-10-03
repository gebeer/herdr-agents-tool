/**
 * Pi child model profiles (`herdr-agents.json`), shared by the pi orchestrator (src/start.ts)
 * and the Claude Code orchestrator (hooks/profiles.ts). Pure: no imports, so both hosts load it.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type RequestedThinking = (typeof THINKING_LEVELS)[number];

export const MODEL_CONFIG_FILE = "herdr-agents.json";
const ALIAS_PATTERN = /^[a-z][a-z0-9_-]*$/;

export type ModelProfile = {
	model: string;
	thinking: RequestedThinking;
};

export type ModelConfig = {
	fallback: ModelProfile;
	aliases: Record<string, ModelProfile>;
};

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
	fallback: { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
	aliases: {
		sol: { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
		terra: { model: "openai-codex/gpt-5.6-terra", thinking: "medium" },
		luna: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
	},
};

/** Invalid configuration: fails immediately and is never bypassed with a fallback. */
export class ModelConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelConfigError";
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function parseCanonicalModel(input: string): { provider: string; id: string } | undefined {
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
		throw new ModelConfigError(`invalid ${label}: expected model and thinking`);
	}
	if (typeof profile.model !== "string" || !parseCanonicalModel(profile.model)) {
		throw new ModelConfigError(`invalid ${label}.model: use one exact provider/model-id`);
	}
	if (typeof profile.thinking !== "string" || !THINKING_LEVELS.includes(profile.thinking as RequestedThinking)) {
		throw new ModelConfigError(`invalid ${label}.thinking`);
	}
	return { model: profile.model, thinking: profile.thinking as RequestedThinking };
}

/** Validates one parsed config file; `path` only labels errors. */
export function parseModelConfig(parsed: unknown, path: string): Partial<ModelConfig> {
	const source = record(parsed);
	if (!source || Object.keys(source).some((key) => key !== "fallback" && key !== "aliases")) {
		throw new ModelConfigError(`invalid config ${path}: expected fallback and aliases`);
	}
	const config: Partial<ModelConfig> = {};
	if (source.fallback !== undefined) config.fallback = modelProfile(source.fallback, `${path} fallback`);
	if (source.aliases !== undefined) {
		const aliases = record(source.aliases);
		if (!aliases) throw new ModelConfigError(`invalid ${path} aliases: expected an object`);
		config.aliases = {};
		for (const [name, profile] of Object.entries(aliases)) {
			if (!ALIAS_PATTERN.test(name)) throw new ModelConfigError(`invalid ${path} alias: ${name}`);
			config.aliases[name] = modelProfile(profile, `${path} alias ${name}`);
		}
	}
	return config;
}

/** Overrides apply in order over the defaults: a fallback replaces, aliases merge. */
export function mergeModelConfig(overrides: readonly Partial<ModelConfig>[]): ModelConfig {
	let config: ModelConfig = {
		fallback: { ...DEFAULT_MODEL_CONFIG.fallback },
		aliases: { ...DEFAULT_MODEL_CONFIG.aliases },
	};
	for (const override of overrides) {
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
