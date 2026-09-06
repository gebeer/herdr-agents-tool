import type { ThinkingLevel } from "@earendil-works/pi-ai";

export const TOOL_NAME = "herdr_start_agent";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const PLACEMENTS = ["pane", "tab", "workspace"] as const;
export const DIRECTIONS = ["right", "down"] as const;

export type Placement = (typeof PLACEMENTS)[number];
export type Direction = (typeof DIRECTIONS)[number];
export type RequestedThinking = (typeof THINKING_LEVELS)[number];

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

export interface SelectedProfile {
	model: string;
	thinking: ThinkingLevel | "off";
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
