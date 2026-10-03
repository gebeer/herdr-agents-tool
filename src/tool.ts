import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { startHerdrPiAgent } from "./start.js";
import { AGENT_KINDS, DIRECTIONS, PLACEMENTS, THINKING_LEVELS, TOOL_NAME, type HerdrStartAgentInput } from "./types.js";

const schema = Type.Object(
	{
		name: Type.String({ description: "Lowercase Herdr agent name." }),
		kind: Type.Optional(StringEnum(AGENT_KINDS, { description: "Agent to start. Defaults to pi." })),
		prompt: Type.Optional(Type.String({ description: "Initial task for the agent." })),
		placement: Type.Optional(StringEnum(PLACEMENTS, { description: "Defaults to tab. Use pane only when the user explicitly requests a split pane; it splits the calling agent's own pane." })),
		workspace: Type.Optional(Type.String({ description: "Workspace ID for tab placement." })),
		direction: Type.Optional(StringEnum(DIRECTIONS, { description: "Pane split direction." })),
		cwd: Type.Optional(Type.String({ description: "Existing directory for the new location." })),
		model: Type.Optional(Type.String({ description: "claude: Claude Code model alias or ID (opus, sonnet, ...); defaults to the user's configured model. pi: configured alias or exact provider/model-id; defaults to the configured fallback model." })),
		thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Thinking effort. Overrides the alias or fallback default; for pi 'sol high', pass model 'sol' and thinking 'high'. claude accepts low, medium, high, xhigh, max." })),
	},
	{ additionalProperties: false },
);

type ToolInput = Static<typeof schema>;

export function registerHerdrStartAgentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Start Herdr Agent",
		description: "Start one Pi or Claude Code agent in a new Herdr pane, tab, or workspace. In Herdr, use this tool exclusively to start subagents, not other launch tools or direct CLI commands. Include an initial task prompt unless the user explicitly requests an agent without one. This tool does not wait for task completion. The child automatically injects a subagent report into your session; do not poll for results.",
		parameters: schema,
		async execute(_toolCallId, input: ToolInput, signal, _onUpdate, ctx) {
			const started = await startHerdrPiAgent(pi, input as HerdrStartAgentInput, signal, ctx);
			return {
				content: [{ type: "text", text: started.text }],
				details: started.details,
			};
		},
	});
}
