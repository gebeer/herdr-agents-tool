import type { AgentKind } from '../core/request.ts'
import type { Launch as HerdrLaunch } from '../core/transaction.ts'
import { claudeChildLaunch, type PermissionMode } from '../protocol/claude-child.ts'
import {
  MODEL_CONFIG_FILE,
  mergeModelConfig,
  parseCanonicalModel,
  parseModelConfig,
  resolveModelProfile,
  type RequestedThinking,
} from '../protocol/model-config.ts'
import { piChildArgv } from '../protocol/pi-child.ts'
import type { Host } from './host.ts'

const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypassPermissions'

export type LaunchRequest = {
  kind: AgentKind
  name: string
  parentPane: string
  model?: string
  thinking?: RequestedThinking
  permissionMode?: PermissionMode
}

/** How Herdr starts one child, plus the profile it got for the tool result. */
export type Launch = HerdrLaunch & {
  kind: AgentKind
  model?: string
  thinking?: RequestedThinking
}

export async function prepareLaunch(host: Host, request: LaunchRequest): Promise<Launch> {
  return request.kind === 'claude' ? claudeLaunch(host, request) : piLaunch(host, request)
}

/** Claude children load this plugin (see child.ts); protocol/claude-child.ts builds their launch. */
function claudeLaunch(host: Host, request: LaunchRequest): Launch {
  const { model, thinking, name, parentPane } = request
  const permissionMode = request.permissionMode ?? DEFAULT_PERMISSION_MODE
  return { kind: 'claude', ...claudeChildLaunch(name, parentPane, host.pluginRoot, model, thinking, permissionMode), model, thinking }
}

/**
 * Pi children use the default pi profile and pi's own completion notifier. Profiles come from
 * the global `herdr-agents.json` alone: this host cannot check pi's project trust or model registry.
 */
async function piLaunch(host: Host, request: LaunchRequest): Promise<Launch> {
  if (request.permissionMode !== undefined) throw new Error('invalid field combination: permissionMode applies only to claude agents')
  if (!host.home) throw new Error('invalid environment: HOME is unset')
  const agentDir = `${host.home}/.pi/agent`
  const configPath = `${agentDir}/${MODEL_CONFIG_FILE}`
  const text = await host.readFile(configPath)
  const config = mergeModelConfig(text === undefined ? [] : [parseModelConfig(text, configPath)])
  const profile = resolveModelProfile(config, request.model, request.thinking)
  if (!parseCanonicalModel(profile.model)) {
    throw new Error('invalid model for pi: use one exact provider/model-id or configured alias')
  }
  const argv = piChildArgv({
    name: request.name, model: profile.model, thinking: profile.thinking, parentPane: request.parentPane,
    notifierPath: `${host.pluginRoot}/src/child-notify.ts`,
  })
  return { kind: 'pi', argv, env: { PI_CODING_AGENT_DIR: agentDir }, model: profile.model, thinking: profile.thinking }
}
