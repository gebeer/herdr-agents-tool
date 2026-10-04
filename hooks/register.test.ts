import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ORCHESTRATOR_ENV = { HERDR_ENV: '1', HERDR_PANE_ID: 'w:p1', HERDR_WORKSPACE_ID: 'w', HERDR_BIN_PATH: '/bin/herdr', HOME: '/home/me' }
const CHILD_ENV = { ...ORCHESTRATOR_ENV, HERDR_PANE_ID: 'w:p2', HERDR_AGENTS_PARENT_PANE: 'w:p1', HERDR_AGENTS_NAME: 'worker' }

const reply = (result: Record<string, unknown>) => ({
  value: { exitCode: 0, stdout: JSON.stringify({ id: 'r', result }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** The world beneath the plugin: a session in /work and a Herdr that records each call. */
function host(on: On, env: Record<string, string>): string[][] {
  const calls: string[][] = []
  mock.env(on, env)
  on('session.cwd', () => ({ value: '/work' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: '/work' } }))
  on('fs.exists', () => ({ value: false }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.compose', () => ({ sections: [{ id: 'engine:base', text: 'base', scope: 'shared' }] }))
  on('process.run', (_$, e) => {
    const args = e.argv.slice(1)
    calls.push(args)
    if (args[0] === 'tab') return reply({ type: 'tab_created', root_pane: { pane_id: 'w:p2' }, tab: { tab_id: 'w:t2' } })
    if (args[1] === 'start') {
      return reply({
        type: 'agent_started',
        agent: { name: args[2], pane_id: 'w:p2', agent: 'claude', interactive_ready: true },
        argv: ['claude', ...args.slice(args.indexOf('--') + 1)],
      })
    }
    return reply({ type: 'agent_prompted', agent: { name: args[2], pane_id: args[2] === 'w:p1' ? 'w:p1' : 'w:p2', agent: 'claude' } })
  })
  return calls
}

const SESSION = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const COMPOSE = { model: 'haiku', promptModel: 'haiku', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const

test('an orchestrator pane gets start_agent and starts a Claude child', async ($, on) => {
  const calls = host(on, ORCHESTRATOR_ENV)
  const registered: string[] = []
  on('tool.register', (_$, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__herdr-agents__${e.name}` } }
  })
  await $.session.start(SESSION)
  expect(registered).toEqual(['start_agent'])

  const started = await $.tool.call({ tool: 'mcp__herdr-agents__start_agent', name: 'worker', kind: 'claude', prompt: 'Do it.' })
  expect(started.isError).toBeUndefined()
  expect(JSON.parse(String(started.result))).toEqual({ name: 'worker', kind: 'claude', pane: 'w:p2', promptSubmitted: true })
  expect(calls.map(args => args.slice(0, 2).join(' '))).toEqual(['tab create', 'agent start', 'agent prompt'])
  expect(calls[1]).toContain('--plugin-dir')
  expect(calls[1]).not.toContain('--append-system-prompt')

  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(section => section.id)).toEqual(['engine:base'])
})

test('a failed start reaches the model as a deny, its error channel', async ($, on) => {
  host(on, ORCHESTRATOR_ENV)
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__herdr-agents__${e.name}` } }))
  await $.session.start(SESSION)
  const failed = await $.tool.call({ tool: 'mcp__herdr-agents__start_agent', name: 'Bad' })
  expect(failed.deny).toContain('invalid name')
  expect(failed.result).toBeUndefined()
})

test('a child registers no tool, gets subagent instructions, and reports each main-loop turn', async ($, on) => {
  const calls = host(on, CHILD_ENV)
  const registered: string[] = []
  on('tool.register', (_$, e) => {
    registered.push(e.name)
    return { value: { tool: e.name } }
  })
  await $.session.start(SESSION)
  expect(registered).toEqual([])

  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(section => section.id)).toEqual(['engine:base', 'herdr-agents:subagent'])
  expect(sections[1]?.text).toContain('Herdr pane w:p1')

  await $.turn.complete({ answer: 'Done.', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(calls).toHaveLength(1)
  expect(calls[0]?.slice(0, 3)).toEqual(['agent', 'prompt', 'w:p1'])
  expect(calls[0]?.[3]).toContain('Done.')

  await $.turn.complete({ answer: 'inner', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'sub' })
  expect(calls).toHaveLength(1)
})

test('outside Herdr the plugin stays silent', async ($, on) => {
  const calls = host(on, { HOME: '/home/me' })
  const registered: string[] = []
  on('tool.register', (_$, e) => {
    registered.push(e.name)
    return { value: { tool: e.name } }
  })
  await $.session.start(SESSION)
  await $.turn.complete({ answer: 'x', reason: 'answer', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(registered).toEqual([])
  expect(calls).toEqual([])
})
