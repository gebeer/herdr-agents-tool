import type { HerdrHost } from '../core/herdr.ts'

/**
 * The port between the mod's pure core and the engine. The engine lets `$` appear only in
 * register.ts, so that shell builds a Host per call. `$.process.run` rejects on timeout
 * without output, so this host reports no `interrupted` result.
 */
export type Host = HerdrHost & {
  /** This plugin's folder, absolute: the repo root that also holds the pi package. */
  pluginRoot: string
  home: string | undefined
  sessionCwd: string
  /** The canonical path of an existing directory; undefined otherwise. */
  realDirectory: (path: string) => Promise<string | undefined>
  /** A file's text; undefined when it does not exist. */
  readFile: (path: string) => Promise<string | undefined>
}
