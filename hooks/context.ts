import { herdrId } from '../core/herdr.ts'

/** Variables the orchestrator sets on a Claude child's pane; register.ts reads them back by literal name. */
export const PARENT_PANE_ENV = 'HERDR_AGENTS_PARENT_PANE'
export const AGENT_NAME_ENV = 'HERDR_AGENTS_NAME'

export type HerdrEnv = {
  HERDR_ENV: string | undefined
  HERDR_PANE_ID: string | undefined
  HERDR_WORKSPACE_ID: string | undefined
  HERDR_AGENTS_PARENT_PANE: string | undefined
  HERDR_AGENTS_NAME: string | undefined
}

/** Where this session runs in Herdr, and in which role. */
export type HerdrContext =
  | { role: 'orchestrator'; pane: string; workspace: string }
  | { role: 'child'; pane: string; parentPane: string; name: string | undefined }

/** Undefined outside a Herdr-managed pane: the plugin then does nothing. */
export function herdrContext(env: HerdrEnv): HerdrContext | undefined {
  const pane = herdrId(env.HERDR_PANE_ID)
  if (env.HERDR_ENV !== '1' || !pane) return undefined
  const parentPane = herdrId(env.HERDR_AGENTS_PARENT_PANE)
  if (parentPane) return { role: 'child', pane, parentPane, name: env.HERDR_AGENTS_NAME }
  const workspace = herdrId(env.HERDR_WORKSPACE_ID)
  return workspace ? { role: 'orchestrator', pane, workspace } : undefined
}
