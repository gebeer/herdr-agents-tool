import type { ToolSpec } from 'claude-code'
import { AGENT_KINDS, DIRECTIONS, PLACEMENTS } from '../core/request.ts'
import { PERMISSION_MODES } from '../protocol/claude-child.ts'
import { THINKING_LEVELS } from '../protocol/model-config.ts'

/** The model calls it as `mcp__<plugin>__start_agent`; the matcher needs the full name as a literal. */
export const START_TOOL_NAME = 'mcp__herdr-agents__start_agent'

// The engine's generated MCP types list only the session's connected servers; declare our own
// tool so its name typechecks either way. Loose arguments: startAgent validates them.
declare module 'claude-code' {
  interface McpToolInputs {
    // @ts-ignore TS2717 when the generated types also declare it (our server was connected at save).
    'mcp__herdr-agents__start_agent': Record<string, unknown>
  }
}

export const START_TOOL: ToolSpec = {
  name: 'start_agent',
  description: 'Start one Claude Code or pi agent in a new Herdr pane, tab, or workspace. In Herdr, use this tool to start agents in new locations, not direct herdr CLI commands. Include an initial task prompt unless the user explicitly requests an agent without one. This tool does not wait for task completion. The child automatically injects a subagent report into your session; do not poll for results.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Lowercase Herdr agent name: [a-z][a-z0-9_-]{0,31}.' },
      kind: { type: 'string', enum: AGENT_KINDS, description: 'Agent to start. Defaults to pi.' },
      prompt: { type: 'string', description: 'Initial task for the agent.' },
      placement: { type: 'string', enum: PLACEMENTS, description: 'Defaults to tab. Use pane only when the user explicitly requests a split pane; it splits the calling agent\'s own pane.' },
      workspace: { type: 'string', description: 'Workspace ID for tab placement. Defaults to the current workspace.' },
      direction: { type: 'string', enum: DIRECTIONS, description: 'Pane split direction. Defaults to right.' },
      cwd: { type: 'string', description: 'Existing directory for the new location. Defaults to the session directory.' },
      model: { type: 'string', description: 'claude: Claude Code model alias or ID (opus, sonnet, ...); defaults to the user\'s configured model. pi: configured alias from ~/.pi/agent/herdr-agents.json or exact provider/model-id; defaults to the configured fallback.' },
      thinking: { type: 'string', enum: THINKING_LEVELS, description: 'Thinking effort; overrides the alias or default. claude accepts low, medium, high, xhigh, max.' },
      permissionMode: { type: 'string', enum: PERMISSION_MODES, description: 'claude only. Defaults to bypassPermissions.' },
    },
  },
}
