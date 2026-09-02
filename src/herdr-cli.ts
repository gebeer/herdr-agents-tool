import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StartAgentError } from "./types.js";

export interface HerdrEnvelope {
	id: string;
	result: Record<string, unknown>;
	/** A complete successful create response arrived after its normal deadline/abort. */
	lateCompletion?: "aborted" | "timed out";
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

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

function structuredCode(raw: string): string | undefined {
	for (const candidate of [raw]) {
		try {
			const parsed = record(JSON.parse(candidate));
			const error = parsed && record(parsed.error);
			const code = error?.code ?? parsed?.code;
			if (typeof code === "string" && /^[a-z0-9_:-]+$/i.test(code)) return code;
			if (typeof parsed?.error === "string" && /^[a-z0-9_:-]+$/i.test(parsed.error)) return parsed.error;
		} catch {
			// Herdr's structured error is optional; never scrape display text.
		}
	}
	return undefined;
}

function parseSuccess(stage: string, kind: "uncertain-create" | "startup", stdout: string): HerdrEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new StartAgentError(kind, `${stage}: malformed Herdr JSON response`);
	}
	const envelope = record(parsed);
	const result = envelope && record(envelope.result);
	if (!result || typeof envelope.id !== "string" || envelope.id.length === 0) {
		throw new StartAgentError(kind, `${stage}: malformed Herdr response envelope`);
	}
	return { id: envelope.id, result };
}

/** Execute one Herdr CLI request through Pi's argument-array API without a shell. */
export async function runHerdr(
	pi: Pick<ExtensionAPI, "exec">,
	binary: string,
	args: string[],
	options: { cwd: string; signal?: AbortSignal; timeout: number; stage: string },
): Promise<HerdrEnvelope> {
	let result: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	try {
		result = await pi.exec(binary, args, {
			cwd: options.cwd,
			signal: options.signal,
			timeout: options.timeout,
		});
	} catch {
		throw new StartAgentError(
			options.stage === "layout create" ? "uncertain-create" : "startup",
			`${options.stage}: Herdr transport failure`,
		);
	}
	const interrupted = result.killed || options.signal?.aborted;
	const lateCompletion = options.signal?.aborted ? "aborted" : "timed out";
	if (options.stage === "layout create" && interrupted) {
		// A timed-out CLI can still have completed the create. Parse its complete response
		// before trusting the exit code so start.ts can prove ownership and compensate.
		return { ...parseSuccess(options.stage, "uncertain-create", result.stdout), lateCompletion };
	}
	if (interrupted) {
		throw new StartAgentError("startup", `${options.stage}: ${lateCompletion}`);
	}
	if (result.code !== 0) {
		const code = structuredCode(result.stdout) ?? structuredCode(result.stderr) ?? "command_failed";
		throw new StartAgentError(
			options.stage === "layout create" ? "layout" : "startup",
			`${options.stage}: Herdr ${code}`,
		);
	}
	return parseSuccess(options.stage, options.stage === "layout create" ? "uncertain-create" : "startup", result.stdout);
}

/** Herdr 0.8.2 acknowledges a successful pane close with exactly `{ type: "ok" }`. */
export function requirePaneCloseSuccess(envelope: HerdrEnvelope): void {
	if (envelope.result.type !== "ok") {
		throw new StartAgentError("compensation", "compensation: malformed Herdr response: expected ok");
	}
}
