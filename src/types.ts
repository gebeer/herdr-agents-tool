import type { RequestedThinking } from "../protocol/model-config.js";

export interface ProfileDescription {
	model?: string;
	thinking?: RequestedThinking;
}

export interface FallbackSelection {
	requested: ProfileDescription;
	selected: Required<ProfileDescription>;
	reason: string;
}

export interface SelectedProfile {
	model: string;
	thinking: RequestedThinking;
	fallback?: FallbackSelection;
}

export interface StartResultDetails {
	name: string;
	pane: string;
	tab?: string;
	workspace?: string;
	model?: string;
	thinking?: RequestedThinking;
	herdr: unknown;
	fallback?: FallbackSelection;
	promptSubmitted?: true;
}
