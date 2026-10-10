import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRolloverRoster } from "./src/rollover-roster.js";
import { registerHerdrStartAgentTool } from "./src/tool.js";

/** Register only in an actual Herdr pane; reload naturally reevaluates this boundary. */
export default function herdrAgentsTool(pi: ExtensionAPI): void {
	if (
		process.env.HERDR_ENV !== "1" ||
		!process.env.HERDR_PANE_ID ||
		!process.env.HERDR_WORKSPACE_ID
	) {
		return;
	}
	registerHerdrStartAgentTool(pi);
	registerRolloverRoster(pi);
}
