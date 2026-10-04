import type { EngineInterface, Register } from 'claude-code'
import { reportToOrchestrator, subagentSection } from './child.ts'
import { herdrContext } from './context.ts'
import type { Host } from './host.ts'
import { startAgent } from './start.ts'
import { START_TOOL, START_TOOL_NAME } from './tool.ts'

/**
 * The imperative shell: the only file that touches `$` (the engine allows it
 * nowhere else). One plugin, two roles, chosen by the pane's environment: an
 * orchestrator gets the start tool; a child it launched gets its subagent
 * instructions and reports each finished turn back. Outside Herdr it does nothing.
 */
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if ((await readContext($))?.role === 'orchestrator') await $.tool.register(START_TOOL)
    return next(e)
  })

  on('tool.call', { tool: START_TOOL_NAME }, async ($, e, next) => {
    const context = await readContext($)
    if (context?.role !== 'orchestrator') return { deny: 'start_agent runs only in a Herdr orchestrator pane.' }
    const { tool: _tool, tool_use_id: _id, consent: _consent, agentId: _agent, ...input } = e
    try {
      return { result: await startAgent(await readHost($), input, context, next.signal) }
    } catch (error) {
      // A hook cannot set isError (core sets it); deny is how its failure reaches the model as an error.
      return { deny: error instanceof Error ? error.message : 'start_agent failed' }
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const context = await readContext($)
    if (context?.role !== 'child') return composed
    return { sections: [...composed.sections, subagentSection(context)] }
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId !== undefined) return completed
    const context = await readContext($)
    if (context?.role !== 'child') return completed
    const failure = await reportToOrchestrator(await readHost($), e, context)
    if (failure) $.ui.toast(failure)
    return completed
  })
}

async function readContext($: EngineInterface) {
  return herdrContext({
    HERDR_ENV: await $.env.get('HERDR_ENV'),
    HERDR_PANE_ID: await $.env.get('HERDR_PANE_ID'),
    HERDR_WORKSPACE_ID: await $.env.get('HERDR_WORKSPACE_ID'),
    HERDR_AGENTS_PARENT_PANE: await $.env.get('HERDR_AGENTS_PARENT_PANE'),
    HERDR_AGENTS_NAME: await $.env.get('HERDR_AGENTS_NAME'),
  }, (await $.session.surfaces()).includes('terminal'))
}

async function readHost($: EngineInterface): Promise<Host> {
  return {
    run: (argv, { cwd, timeoutMs }) => $.process.run(argv, { cwd, timeoutMs }),
    herdrBinary: (await $.env.get('HERDR_BIN_PATH')) ?? 'herdr',
    pluginRoot: $.plugin.root,
    home: await $.env.get('HOME'),
    sessionCwd: await $.session.cwd(),
    realDirectory: async path => {
      const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
      return stat?.kind === 'dir' ? stat.realPath : undefined
    },
    readFile: async path => ((await $.fs.exists(path)) ? $.fs.read(path) : undefined),
  }
}
