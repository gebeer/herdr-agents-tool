import type { EngineInterface, Register } from 'claude-code'
import {
  type Host, KINDS, MESSAGE_DESCRIPTION, MESSAGE_FIELDS, messageAgent, PERMISSION_MODES, PLACES, piModelsFrom,
  type Run, sendReport, START_DESCRIPTION, startAgent, startFields, subagentNote, THINKING_LEVELS,
} from '../core.ts'

/** The model calls the tools as `mcp__<plugin>__<name>`; the matchers need the full names as literals. */
const START_TOOL = 'mcp__herdr-agents__start_agent'
const MESSAGE_TOOL = 'mcp__herdr-agents__message_agent'

// The engine's generated MCP types list only the session's connected servers; declare our own
// tools so their names typecheck either way. Loose arguments: the core validates them.
declare module 'claude-code' {
  interface McpToolInputs {
    // @ts-ignore TS2717 when the generated types also declare it (our server was connected at save).
    'mcp__herdr-agents__start_agent': Record<string, unknown>
    // @ts-ignore TS2717, as above.
    'mcp__herdr-agents__message_agent': Record<string, unknown>
  }
}

/**
 * One plugin, two roles, chosen by the terminal's environment: a session in an hc terminal
 * gets the tools; a child it started gets its subagent note and sends each finished turn
 * back. Outside herdr-core it does nothing.
 */
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const role = await readRole($)
    if (role && !role.parent) {
      const fields = startFields(await piModels($))
      const text = (description: string) => ({ type: 'string', description })
      await $.tool.register({
        name: 'start_agent',
        description: START_DESCRIPTION,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: text(fields.name),
            prompt: text(fields.prompt),
            model: text(fields.model),
            kind: { ...text(fields.kind), enum: KINDS },
            thinking: { ...text(fields.thinking), enum: THINKING_LEVELS },
            place: { ...text(fields.place), enum: PLACES },
            focus: { type: 'boolean', description: fields.focus },
            cwd: text(fields.cwd),
            permissionMode: { ...text(fields.permissionMode), enum: PERMISSION_MODES },
          },
        },
      })
      await $.tool.register({
        name: 'message_agent',
        description: MESSAGE_DESCRIPTION,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['to', 'text'],
          properties: { to: text(MESSAGE_FIELDS.to), text: text(MESSAGE_FIELDS.text) },
        },
      })
    }
    return next(e)
  })

  // A hook cannot set isError (core sets it); deny is how a failure reaches the model as an error.
  on('tool.call', { tool: START_TOOL }, async ($, e) => {
    try {
      const role = await readRole($)
      if (!role || role.parent) return { deny: 'start_agent runs only in an hc terminal that is not itself a started agent.' }
      const { tool: _tool, tool_use_id: _id, consent: _consent, agentId: _agent, ...input } = e
      const host: Host = {
        me: role.me,
        cwd: await $.session.cwd(),
        root: $.plugin.root,
        piModels: await piModels($),
        piAgentDir: await $.env.get('PI_CODING_AGENT_DIR'),
        run: runner($),
      }
      return { result: await startAgent(host, input as never) }
    } catch (error) {
      return denied(error)
    }
  })

  on('tool.call', { tool: MESSAGE_TOOL }, async ($, e) => {
    try {
      if (!(await readRole($))) return { deny: 'message_agent runs only in an hc terminal.' }
      return { result: await messageAgent(runner($), e as never) }
    } catch (error) {
      return denied(error)
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const role = await readRole($)
    if (!role?.parent) return composed
    return { sections: [...composed.sections, { id: 'herdr-agents:subagent', scope: 'session', text: subagentNote(role.parent) } as const] }
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId !== undefined) return completed
    const role = await readRole($)
    if (!role?.parent) return completed
    const failure = await sendReport(runner($), role.parent, e.answer, e.reason)
    if (failure) $.ui.toast(failure)
    return completed
  })
}

function denied(error: unknown) {
  return { deny: error instanceof Error ? error.message : 'the hc command failed' }
}

/**
 * Undefined outside an hc terminal. The report variable reaches everything in a child's
 * terminal, so only the interactive session there is the child; anything else in it
 * (such as `claude -p` from its Bash) gets no role.
 */
async function readRole($: EngineInterface): Promise<{ me: string; parent?: string } | undefined> {
  const me = await $.env.get('HC_TERMINAL_ID')
  if (!me) return undefined
  const parent = await $.env.get('HERDR_AGENTS_REPORT_TO')
  if (!parent || parent === me) return { me }
  return (await $.session.surfaces()).includes('terminal') ? { me, parent } : undefined
}

function runner($: EngineInterface): Run {
  return (argv, timeoutMs) => $.process.run(argv, { timeoutMs })
}

/** Pi's enabled models, read fresh so a settings change needs no restart. */
async function piModels($: EngineInterface): Promise<string[]> {
  const dir = (await $.env.get('PI_CODING_AGENT_DIR')) ?? `${await $.env.get('HOME')}/.pi/agent`
  const path = `${dir}/settings.json`
  return piModelsFrom((await $.fs.exists(path)) ? await $.fs.read(path) : undefined)
}
