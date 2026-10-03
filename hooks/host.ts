/**
 * The port between the pure core and the engine. The engine lets `$` appear only in
 * register.ts, so that shell builds a Host per call and the core works against it.
 */

export type ProcessResult = { exitCode: number; stdout: string; stderr: string }

export type Host = {
  /** Runs argv with no shell; rejects when it cannot start or outlives `timeoutMs`. */
  run: (argv: readonly string[], options: { cwd: string; timeoutMs: number }) => Promise<ProcessResult>
  herdrBinary: string
  /** This plugin's folder, absolute: the repo root that also holds the pi package. */
  pluginRoot: string
  home: string | undefined
  sessionCwd: string
  /** The canonical path of an existing directory; undefined otherwise. */
  realDirectory: (path: string) => Promise<string | undefined>
  /** A file's text; undefined when it does not exist. */
  readFile: (path: string) => Promise<string | undefined>
}
