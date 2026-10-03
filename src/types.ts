import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { Direction, Placement } from "../core/request.js";
import type { RequestedThinking } from "../protocol/model-config.js";

export { StartAgentError } from "../core/errors.js";
export { DIRECTIONS, PLACEMENTS, type Direction, type Placement } from "../core/request.js";
export { THINKING_LEVELS, type RequestedThinking } from "../protocol/model-config.js";
export { PI_SPAWN_TOOL as TOOL_NAME } from "../protocol/pi-child.js";

export const AGENT_KINDS = ["pi", "claude"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface HerdrStartAgentInput {
	name: string;
	kind?: AgentKind;
	placement?: Placement;
	workspace?: string;
	direction?: Direction;
	cwd?: string;
	model?: string;
	thinking?: RequestedThinking;
	prompt?: string;
}

export interface ProfileDescription {
	model?: string;
	thinking?: ThinkingLevel | "off";
}

export interface FallbackSelection {
	requested: ProfileDescription;
	selected: Required<ProfileDescription>;
	reason: string;
}

export interface SelectedProfile {
	model: string;
	thinking: ThinkingLevel | "off";
	fallback?: FallbackSelection;
}

export interface StartResultDetails {
	name: string;
	pane: string;
	tab?: string;
	workspace?: string;
	model?: string;
	thinking?: ThinkingLevel | "off";
	herdr: unknown;
	fallback?: FallbackSelection;
	promptSubmitted?: true;
}
