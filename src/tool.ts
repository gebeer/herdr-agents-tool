import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { startHerdrPiAgent } from "./start.js";
import { DIRECTIONS, PLACEMENTS, THINKING_LEVELS, TOOL_NAME, type HerdrStartAgentInput } from "./types.js";

const schema = Type.Object(
	{
		name: Type.String({ description: "Lowercase Herdr agent name." }),
		prompt: Type.Optional(Type.String({ description: "Initial task for the agent." })),
		placement: Type.Optional(StringEnum(PLACEMENTS, { description: "New pane, tab, or workspace." })),
		workspace: Type.Optional(Type.String({ description: "Workspace ID for tab placement." })),
		direction: Type.Optional(StringEnum(DIRECTIONS, { description: "Pane split direction." })),
		cwd: Type.Optional(Type.String({ description: "Existing directory for the new location." })),
		model: Type.Optional(Type.String({ description: "Exact provider/model-id, or sol, terra, or luna." })),
		thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Supported thinking level." })),
	},
	{ additionalProperties: false },
);

type ToolInput = Static<typeof schema>;

export function registerHerdrStartAgentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Start Herdr Agent",
		description: "Start one Pi agent in a new Herdr pane, tab, or workspace. In Herdr, use this tool exclusively to start subagents, not other launch tools or direct CLI commands. Include an initial task prompt unless the user explicitly requests an agent without one. This tool does not wait for task completion. The child automatically attempts to send its final response back to your pane; routine result polling is unnecessary.",
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
