import { THINKING_LEVELS, type RequestedThinking } from '../protocol/model-config.ts'
import { HerdrError, herdrId, record, runHerdr, type HerdrResult } from './herdr.ts'
import type { Host } from './host.ts'
import { AGENT_KINDS, PERMISSION_MODES, prepareLaunch, type AgentKind, type Launch, type PermissionMode } from './launch.ts'

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
export const PLACEMENTS = ['pane', 'tab', 'workspace'] as const
export const DIRECTIONS = ['right', 'down'] as const
const INPUT_FIELDS = ['name', 'kind', 'prompt', 'placement', 'workspace', 'direction', 'cwd', 'model', 'thinking', 'permissionMode']
const CREATE_TIMEOUT_MS = 10_000
const START_TIMEOUT_MS = 35_000
const HERDR_READY_TIMEOUT_MS = 30_000
const PROMPT_TIMEOUT_MS = 10_000
const COMPENSATION_TIMEOUT_MS = 5_000

type Placement = (typeof PLACEMENTS)[number]
type Direction = (typeof DIRECTIONS)[number]

export type StartRequest = {
  name: string
  kind: AgentKind
  placement: Placement
  workspace?: string
  direction?: Direction
  cwd?: string
  model?: string
  thinking?: RequestedThinking
  permissionMode?: PermissionMode
  prompt?: string
}

type Orchestrator = { pane: string; workspace: string }
type OwnedLocation = { paneId: string; tabId?: string; workspaceId?: string }

/** A failure after layout creation proved which pane this call owns, so that pane is closed. */
class OwnedPaneError extends Error {
  constructor(message: string, readonly paneId: string) {
    super(message)
  }
}

function oneOf<T extends string>(values: readonly T[], value: unknown, label: string): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error(`invalid ${label}`)
  return value as T
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  if (value !== undefined && typeof value !== 'string') throw new Error(`invalid ${key}: expected a string`)
  return value
}

/** Shape checks shared by every kind; kind-specific checks live in launch.ts. */
export function validateStartInput(source: Record<string, unknown>, defaultWorkspace: string): StartRequest {
  for (const key of Object.keys(source)) {
    if (!INPUT_FIELDS.includes(key)) throw new Error(`invalid input field: ${key}`)
  }
  const name = source.name
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw new Error('invalid name: use [a-z][a-z0-9_-]{0,31}')
  const placement = oneOf(PLACEMENTS, source.placement, 'placement') ?? 'tab'
  const direction = oneOf(DIRECTIONS, source.direction, 'direction')
  const workspace = optionalString(source, 'workspace')
  const prompt = optionalString(source, 'prompt')
  if (prompt !== undefined && (!prompt.trim() || prompt.includes('\0'))) {
    throw new Error('invalid prompt: expected nonblank text without NUL bytes')
  }
  if (workspace !== undefined && placement !== 'tab') throw new Error('invalid field combination: workspace applies only to tab placement')
  if (direction !== undefined && placement !== 'pane') throw new Error('invalid field combination: direction applies only to pane placement')
  const request: StartRequest = {
    name,
    kind: oneOf(AGENT_KINDS, source.kind, 'kind') ?? 'pi',
    placement,
    cwd: optionalString(source, 'cwd'),
    model: optionalString(source, 'model'),
    thinking: oneOf(THINKING_LEVELS, source.thinking, 'thinking level'),
    permissionMode: oneOf(PERMISSION_MODES, source.permissionMode, 'permissionMode'),
    prompt,
  }
  if (placement === 'pane') return { ...request, direction: direction ?? 'right' }
  if (placement === 'tab') {
    const target = workspace ?? defaultWorkspace
    if (!herdrId(target)) throw new Error('invalid workspace')
    return { ...request, workspace: target }
  }
  return request
}

/** The requested directory, absolute and canonical, relative to the session's. */
async function resolveCwd(host: Host, requested: string | undefined): Promise<string> {
  const base = host.sessionCwd
  const candidate = requested === undefined ? base : requested.startsWith('/') ? requested : `${base}/${requested}`
  const directory = await host.realDirectory(candidate)
  if (!directory) throw new Error('invalid cwd: must be an existing directory')
  return directory
}

function createArgs(request: StartRequest, cwd: string, env: Record<string, string>): string[] {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`])
  switch (request.placement) {
    case 'pane': return ['pane', 'split', '--current', '--direction', request.direction!, '--cwd', cwd, '--no-focus', ...envArgs]
    case 'tab': return ['tab', 'create', '--workspace', request.workspace!, '--cwd', cwd, '--label', request.name, '--no-focus', ...envArgs]
    case 'workspace': return ['workspace', 'create', '--cwd', cwd, '--label', request.name, '--no-focus', ...envArgs]
  }
}

/** Proves ownership of the created root pane first, so any later malformation still rolls it back. */
function parseCreatedLocation(placement: Placement, result: HerdrResult): OwnedLocation {
  const expected = { pane: 'pane_info', tab: 'tab_created', workspace: 'workspace_created' }[placement]
  const paneId = result.type === expected
    ? herdrId(record(placement === 'pane' ? result.pane : result.root_pane)?.pane_id)
    : undefined
  if (!paneId) throw new Error('layout create: malformed response, ownership was not proven; creation outcome is uncertain and no pane was closed')
  if (placement === 'pane') return { paneId }
  const tabId = herdrId(record(result.tab)?.tab_id)
  if (!tabId) throw new OwnedPaneError('layout create: malformed response, missing tab.tab_id', paneId)
  if (placement === 'tab') return { paneId, tabId }
  const workspaceId = herdrId(record(result.workspace)?.workspace_id)
  if (!workspaceId) throw new OwnedPaneError('layout create: malformed response, missing workspace.workspace_id', paneId)
  return { paneId, tabId, workspaceId }
}

async function createLayout(host: Host, request: StartRequest, cwd: string, launch: Launch): Promise<OwnedLocation> {
  let result: HerdrResult
  try {
    result = await runHerdr(host, createArgs(request, cwd, launch.env), { cwd, timeoutMs: CREATE_TIMEOUT_MS, stage: 'layout create' })
  } catch (error) {
    if (error instanceof HerdrError && error.isUncertain) {
      throw new Error(`${error.message}; creation outcome is uncertain and no pane was closed`)
    }
    throw error
  }
  return parseCreatedLocation(request.placement, result)
}

function sameArgv(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index])
}

async function startInPane(host: Host, request: StartRequest, launch: Launch, paneId: string, cwd: string): Promise<void> {
  const result = await runHerdr(host, [
    'agent', 'start', request.name, '--kind', launch.kind, '--pane', paneId,
    '--timeout', String(HERDR_READY_TIMEOUT_MS), '--', ...launch.argv,
  ], { cwd, timeoutMs: START_TIMEOUT_MS, stage: 'agent startup' })
  const agent = record(result.agent)
  if (result.type !== 'agent_started' || !agent) throw new Error('malformed start response: expected agent_started')
  if (agent.name !== request.name || agent.pane_id !== paneId || agent.agent !== launch.kind) {
    throw new Error('mismatched start response: agent name, kind, or pane')
  }
  if (agent.interactive_ready !== true || agent.launch_pending === true) throw new Error('agent_not_ready')
  if (!sameArgv(result.argv, [launch.kind, ...launch.argv])) throw new Error('mismatched start response: argv')
}

/** One fresh attempt to close exactly the owned pane; accepted only on Herdr's `ok`. */
async function closeOwnedPane(host: Host, paneId: string, cwd: string): Promise<string> {
  try {
    const closed = await runHerdr(host, ['pane', 'close', paneId], { cwd, timeoutMs: COMPENSATION_TIMEOUT_MS, stage: 'compensation' })
    if (closed.type !== 'ok') return 'compensation failed: malformed Herdr response: expected ok'
    return 'compensation closed created pane'
  } catch (error) {
    return `compensation failed: ${error instanceof Error ? error.message : 'unknown error'}`
  }
}

async function rolledBack(host: Host, error: unknown, paneId: string, cwd: string): Promise<Error> {
  const message = error instanceof Error ? error.message : 'agent startup failed'
  return new Error(`${message}; ${await closeOwnedPane(host, paneId, cwd)}`)
}

/** Once the agent is ready it is never rolled back or retried: a failed acknowledgement may hide delivered work. */
async function submitPrompt(host: Host, request: StartRequest, launch: Launch, paneId: string, prompt: string, cwd: string): Promise<void> {
  try {
    const result = await runHerdr(host, ['agent', 'prompt', request.name, prompt], { cwd, timeoutMs: PROMPT_TIMEOUT_MS, stage: 'prompt submission' })
    const agent = record(result.agent)
    if (result.type !== 'agent_prompted' || agent?.name !== request.name || agent.pane_id !== paneId || agent.agent !== launch.kind) {
      throw new Error('malformed or mismatched agent_prompted response')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'prompt submission failed'
    throw new Error(`${message}; agent ${request.name} in pane ${paneId} left running; prompt delivery may be uncertain; inspect before retrying`)
  }
}

/** One bounded create/start transaction; it keeps no state after returning. Resolves the tool's result text. */
export async function startAgent(host: Host, input: Record<string, unknown>, orchestrator: Orchestrator): Promise<string> {
  const request = validateStartInput(input, orchestrator.workspace)
  const cwd = await resolveCwd(host, request.cwd)
  const launch = await prepareLaunch(host, { ...request, parentPane: orchestrator.pane })

  let owned: OwnedLocation
  try {
    owned = await createLayout(host, request, cwd, launch)
  } catch (error) {
    if (error instanceof OwnedPaneError) throw await rolledBack(host, error, error.paneId, cwd)
    throw error
  }
  try {
    await startInPane(host, request, launch, owned.paneId, cwd)
  } catch (error) {
    throw await rolledBack(host, error, owned.paneId, cwd)
  }

  if (request.prompt !== undefined) await submitPrompt(host, request, launch, owned.paneId, request.prompt, cwd)

  return JSON.stringify({
    name: request.name,
    kind: launch.kind,
    pane: owned.paneId,
    ...(launch.model ? { model: launch.model } : {}),
    ...(launch.thinking ? { thinking: launch.thinking } : {}),
    ...(request.prompt !== undefined ? { promptSubmitted: true } : {}),
  })
}
