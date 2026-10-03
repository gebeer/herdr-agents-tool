import { AGENT_KINDS, oneOf, resolveCwd, validateStartRequest } from '../core/request.ts'
import { startInNewLocation } from '../core/transaction.ts'
import { PERMISSION_MODES } from '../protocol/claude-child.ts'
import type { Host } from './host.ts'
import { prepareLaunch } from './launch.ts'

type Orchestrator = { pane: string; workspace: string }

/**
 * The mod's start tool: its own `kind` and `permissionMode`, then the request rules and
 * Herdr transaction it shares with the pi tool. Resolves the tool's result text. An abort
 * (the user interrupted) rolls back a created pane and skips the prompt.
 */
export async function startAgent(host: Host, input: Record<string, unknown>, orchestrator: Orchestrator, signal?: AbortSignal): Promise<string> {
  const { kind: rawKind, permissionMode: rawPermissionMode, ...shared } = input
  const kind = oneOf(AGENT_KINDS, rawKind, 'kind') ?? 'pi'
  const permissionMode = oneOf(PERMISSION_MODES, rawPermissionMode, 'permissionMode')
  const request = validateStartRequest(shared, orchestrator.workspace)
  const cwd = await resolveCwd(host.realDirectory, host.sessionCwd, request.cwd)
  const launch = await prepareLaunch(host, {
    kind, name: request.name, parentPane: orchestrator.pane, model: request.model, thinking: request.thinking, permissionMode,
  })
  const started = await startInNewLocation(host, request, cwd, launch, signal)
  return JSON.stringify({
    name: request.name,
    kind: launch.kind,
    pane: started.paneId,
    ...(launch.model ? { model: launch.model } : {}),
    ...(launch.thinking ? { thinking: launch.thinking } : {}),
    ...(request.prompt !== undefined ? { promptSubmitted: true } : {}),
  })
}
