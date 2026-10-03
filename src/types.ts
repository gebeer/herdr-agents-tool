import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { RequestedThinking } from "../protocol/model-config.js";

export { THINKING_LEVELS, type RequestedThinking } from "../protocol/model-config.js";
export { PI_SPAWN_TOOL as TOOL_NAME } from "../protocol/pi-child.js";

export const PLACEMENTS = ["pane", "tab", "workspace"] as const;
export const DIRECTIONS = ["right", "down"] as const;

export type Placement = (typeof PLACEMENTS)[number];
export type Direction = (typeof DIRECTIONS)[number];

export interface HerdrStartAgentInput {
	name: string;
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

export interface OwnedLocation {
	paneId: string;
	tabId?: string;
	workspaceId?: string;
}

export interface StartResultDetails {
	name: string;
	pane: string;
	tab?: string;
	workspace?: string;
	model: string;
	thinking: ThinkingLevel | "off";
	herdr: unknown;
	fallback?: FallbackSelection;
	promptSubmitted?: true;
}

export class StartAgentError extends Error {
	constructor(
		readonly kind: "validation" | "layout" | "uncertain-create" | "startup" | "compensation",
		message: string,
		readonly ownedPaneId?: string,
	) {
		super(message);
		this.name = "StartAgentError";
	}
}
