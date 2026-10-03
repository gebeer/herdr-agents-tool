import { THINKING_LEVELS, type RequestedThinking } from "../protocol/model-config.ts";
import { StartAgentError } from "./errors.ts";
import { herdrId, record } from "./herdr.ts";

export const PLACEMENTS = ["pane", "tab", "workspace"] as const;
export const DIRECTIONS = ["right", "down"] as const;
export type Placement = (typeof PLACEMENTS)[number];
export type Direction = (typeof DIRECTIONS)[number];
export const AGENT_KINDS = ["pi", "claude"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const FIELDS = ["name", "placement", "workspace", "direction", "cwd", "model", "thinking", "prompt"];

/** What every orchestrator's start tool accepts; a host strips its own extra fields first. */
export type StartRequest = {
	name: string;
	placement: Placement;
	workspace?: string;
	direction?: Direction;
	cwd?: string;
	model?: string;
	thinking?: RequestedThinking;
	prompt?: string;
};

/** An optional enum field: undefined when absent, otherwise one of `values`. */
export function oneOf<T extends string>(values: readonly T[], value: unknown, label: string): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !values.includes(value as T)) throw new StartAgentError("validation", `invalid ${label}`);
	return value as T;
}

/** Validates tool input before any profile check or layout mutation. */
export function validateStartRequest(input: unknown, defaultWorkspace: string | undefined): StartRequest {
	const source = record(input);
	if (!source) throw new StartAgentError("validation", "invalid input: expected an object");
	for (const key of Object.keys(source)) {
		if (!FIELDS.includes(key)) throw new StartAgentError("validation", `invalid input field: ${key}`);
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
	const placement = oneOf(PLACEMENTS, source.placement, "placement") ?? "tab";
	const direction = oneOf(DIRECTIONS, source.direction, "direction");
	const thinking = oneOf(THINKING_LEVELS, source.thinking, "thinking level");
	const prompt = optionalString("prompt");
	if (prompt !== undefined && (!prompt.trim() || prompt.includes("\0"))) {
		throw new StartAgentError("validation", "invalid prompt: expected nonblank text without NUL bytes");
	}
	const workspace = optionalString("workspace");
	if (workspace !== undefined && placement !== "tab") throw new StartAgentError("validation", "invalid field combination: workspace applies only to tab placement");
	if (direction !== undefined && placement !== "pane") throw new StartAgentError("validation", "invalid field combination: direction applies only to pane placement");
	const common = { name, placement, cwd: optionalString("cwd"), model: optionalString("model"), thinking, prompt };
	switch (placement) {
		case "pane": return { ...common, direction: direction ?? "right" };
		case "tab": {
			const targetWorkspace = workspace ?? defaultWorkspace;
			if (!herdrId(targetWorkspace)) throw new StartAgentError("validation", "invalid Herdr context: workspace is unavailable");
			return { ...common, workspace: targetWorkspace };
		}
		case "workspace": return common;
	}
}

/**
 * The requested directory resolved against `base`, canonical and existing.
 * `realDirectory` is the host's: the canonical path of an existing directory, else undefined.
 */
export async function resolveCwd(
	realDirectory: (path: string) => Promise<string | undefined>,
	base: string,
	requested: string | undefined,
): Promise<string> {
	const candidate = requested === undefined ? base : requested.startsWith("/") ? requested : `${base}/${requested}`;
	if (!candidate.startsWith("/")) throw new StartAgentError("validation", "invalid cwd: must resolve to an absolute path");
	const directory = await realDirectory(candidate);
	if (!directory) throw new StartAgentError("validation", "invalid cwd: must be an existing directory");
	return directory;
}
