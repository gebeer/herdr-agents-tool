import { runHerdr } from '../core/herdr.ts'
import { formatSubagentReport, isReportAcknowledged, paneCloseCommand } from '../protocol/report.ts'
import type { HerdrContext } from './context.ts'
import type { Host } from './host.ts'

const NOTIFY_TIMEOUT_MS = 10_000

type Child = Extract<HerdrContext, { role: 'child' }>

/**
 * The child's own system-prompt section. Added by the plugin rather than passed as
 * `--append-system-prompt`, so it never displaces a prompt the user's launcher appends.
 */
export function subagentSection(child: Child) {
  return {
    id: 'herdr-agents:subagent',
    scope: 'session',
    text: `You are a subagent. Do not start further Herdr agents. Your orchestrator is in Herdr pane ${child.parentPane}. Automatic completion reporting is installed; do not send a separate completion notification.`,
  } as const
}

/** The end of a main-loop turn, as `turn.complete` carries it. */
export type FinishedTurn = { reason: string; answer: string }

/**
 * Sends the turn's final answer to the orchestrator pane once, never retried.
 * Resolves the failure notice to show in the child, or undefined once delivered.
 */
export async function reportToOrchestrator(host: Host, turn: FinishedTurn, child: Child): Promise<string | undefined> {
  const report = formatSubagentReport({
    name: child.name,
    pane: child.pane,
    status: turn.reason,
    text: turn.answer,
    cleanup: paneCloseCommand(child.pane),
  })
  try {
    const { result } = await runHerdr(host, ['agent', 'prompt', child.parentPane, report], {
      cwd: host.sessionCwd, timeoutMs: NOTIFY_TIMEOUT_MS, stage: 'completion notification',
    })
    if (!isReportAcknowledged(result, child.parentPane)) throw new Error('malformed or mismatched notification acknowledgement')
    return undefined
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error'
    return `Completion notification failed: ${reason}. Delivery may be uncertain; no retry was made.`
  }
}
