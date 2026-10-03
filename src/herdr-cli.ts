import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StartAgentError } from "../core/errors.js";
import { runHerdr as runHerdrOn, type HerdrEnvelope, type HerdrHost } from "../core/herdr.js";

function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Resolve only an executable supplied by Herdr or a concrete PATH entry. */
export function resolveHerdrBinary(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.HERDR_BIN_PATH;
	if (configured !== undefined) {
		if (!isAbsolute(configured) || !executable(configured)) {
			throw new StartAgentError("validation", "invalid Herdr context: HERDR_BIN_PATH is not an executable absolute path");
		}
		return configured;
	}
	for (const entry of (env.PATH ?? "").split(delimiter)) {
		if (!entry) continue;
		const candidate = join(entry, "herdr");
		if (executable(candidate)) return candidate;
	}
	throw new StartAgentError("validation", "invalid Herdr context: herdr executable was not found on PATH");
}

/** Pi's exec keeps a killed command's output, so this host supports late-completion proof. */
export function piHerdrHost(pi: Pick<ExtensionAPI, "exec">, binary: string): HerdrHost {
	return {
		herdrBinary: binary,
		run: async ([command, ...args], options) => {
			const result = await pi.exec(command!, args, { cwd: options.cwd, signal: options.signal, timeout: options.timeoutMs });
			return {
				exitCode: result.code,
				stdout: result.stdout,
				stderr: result.stderr,
				...(result.killed ? { interrupted: "timed out" as const } : {}),
			};
		},
	};
}

/** Execute one Herdr CLI request through Pi's argument-array API without a shell. */
export function runHerdr(
	pi: Pick<ExtensionAPI, "exec">,
	binary: string,
	args: string[],
	options: { cwd: string; signal?: AbortSignal; timeout: number; stage: string },
): Promise<HerdrEnvelope> {
	return runHerdrOn(piHerdrHost(pi, binary), args, {
		cwd: options.cwd, signal: options.signal, timeoutMs: options.timeout, stage: options.stage,
	});
}
