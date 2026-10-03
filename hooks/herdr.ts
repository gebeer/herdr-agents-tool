import type { Host } from './host.ts'

export type HerdrResult = Record<string, unknown>

/**
 * A failed Herdr CLI request. `isUncertain`: the command may still have taken
 * effect (transport failure, timeout, or a malformed success response).
 */
export class HerdrError extends Error {
  constructor(message: string, readonly isUncertain: boolean) {
    super(message)
    this.name = 'HerdrError'
  }
}

export function record(value: unknown): HerdrResult | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as HerdrResult)
    : undefined
}

/** A Herdr id: nonblank, trimmed, single line. */
export function herdrId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\0\r\n]/.test(value)
    ? value
    : undefined
}

function parseJson(text: string): HerdrResult | undefined {
  try {
    return record(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** Herdr's structured error code, when present; display text is never scraped. */
function structuredCode(raw: string): string | undefined {
  const parsed = parseJson(raw)
  const code = record(parsed?.error)?.code ?? parsed?.code ?? parsed?.error
  return typeof code === 'string' && /^[a-z0-9_:-]+$/i.test(code) ? code : undefined
}

/** Runs one Herdr CLI request by argv (no shell) and returns its envelope's `result`. */
export async function runHerdr(
  host: Pick<Host, 'run' | 'herdrBinary'>,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; stage: string },
): Promise<HerdrResult> {
  let ran
  try {
    ran = await host.run([host.herdrBinary, ...args], { cwd: options.cwd, timeoutMs: options.timeoutMs })
  } catch {
    throw new HerdrError(`${options.stage}: Herdr transport failure or timeout`, true)
  }
  if (ran.exitCode !== 0) {
    const code = structuredCode(ran.stdout) ?? structuredCode(ran.stderr) ?? 'command_failed'
    throw new HerdrError(`${options.stage}: Herdr ${code}`, false)
  }
  const envelope = parseJson(ran.stdout)
  const result = record(envelope?.result)
  if (!result || typeof envelope?.id !== 'string' || envelope.id.length === 0) {
    throw new HerdrError(`${options.stage}: malformed Herdr response`, true)
  }
  return result
}
