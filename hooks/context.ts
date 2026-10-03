import { herdrId } from '../core/herdr.ts'
import { AGENT_NAME_ENV, PARENT_PANE_ENV } from '../protocol/claude-child.ts'

/** register.ts reads these by literal name; the protocol's constants keep the names in step. */
export type HerdrEnv = {
  HERDR_ENV: string | undefined
  HERDR_PANE_ID: string | undefined
  HERDR_WORKSPACE_ID: string | undefined
  [PARENT_PANE_ENV]: string | undefined
  [AGENT_NAME_ENV]: string | undefined
}

/** Where this session runs in Herdr, and in which role. */
export type HerdrContext =
  | { role: 'orchestrator'; pane: string; workspace: string }
  | { role: 'child'; pane: string; parentPane: string; name: string | undefined }

/** Undefined outside a Herdr-managed pane: the plugin then does nothing. */
export function herdrContext(env: HerdrEnv): HerdrContext | undefined {
  const pane = herdrId(env.HERDR_PANE_ID)
  if (env.HERDR_ENV !== '1' || !pane) return undefined
  const parentPane = herdrId(env[PARENT_PANE_ENV])
  if (parentPane) return { role: 'child', pane, parentPane, name: env[AGENT_NAME_ENV] }
  const workspace = herdrId(env.HERDR_WORKSPACE_ID)
  return workspace ? { role: 'orchestrator', pane, workspace } : undefined
}
