import { StartAgentError } from "./errors.ts";

export type HerdrResult = Record<string, unknown>;

export type RunResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** Set by a host that kept the output of a command it had to kill. */
	interrupted?: "timed out";
};

/**
 * The port each orchestrator host provides: pi over `pi.exec`, Claude Code over `$.process.run`.
 * A host that cannot keep a killed command's output rejects instead of reporting `interrupted`;
 * it then loses only the late-completion proof of a timed-out create.
 */
export type HerdrHost = {
	/** Runs argv with no shell; rejects when the command cannot run. */
	run: (argv: readonly string[], options: { cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<RunResult>;
	herdrBinary: string;
};

export interface HerdrEnvelope {
	id: string;
	result: HerdrResult;
	/** A complete successful create response arrived after its normal deadline/abort. */
	lateCompletion?: "aborted" | "timed out";
}

export function record(value: unknown): HerdrResult | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as HerdrResult)
		: undefined;
}

/** A Herdr id: nonblank, trimmed, single line. */
export function herdrId(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value === value.trim() && !/[\0\r\n]/.test(value)
		? value
		: undefined;
}

function structuredCode(raw: string): string | undefined {
	try {
		const parsed = record(JSON.parse(raw));
		const error = parsed && record(parsed.error);
		const code = error?.code ?? parsed?.code;
		if (typeof code === "string" && /^[a-z0-9_:-]+$/i.test(code)) return code;
		if (typeof parsed?.error === "string" && /^[a-z0-9_:-]+$/i.test(parsed.error)) return parsed.error;
	} catch {
		// Herdr's structured error is optional; never scrape display text.
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

/**
 * Executes one Herdr CLI request through the host's argv API, without a shell. `isCreate`
 * marks a layout create, whose interrupted or failed run may still have created a pane.
 */
export async function runHerdr(
	host: HerdrHost,
	args: readonly string[],
	options: { cwd: string; timeoutMs: number; stage: string; signal?: AbortSignal; isCreate?: boolean },
): Promise<HerdrEnvelope> {
	const { stage, signal, isCreate = false } = options;
	let ran: RunResult;
	try {
		ran = await host.run([host.herdrBinary, ...args], { cwd: options.cwd, timeoutMs: options.timeoutMs, signal });
	} catch {
		throw new StartAgentError(isCreate ? "uncertain-create" : "startup", `${stage}: Herdr transport failure`);
	}
	const interrupted = signal?.aborted ? "aborted" : ran.interrupted;
	if (isCreate && interrupted) {
		// An interrupted create can still have completed. Parse its complete response before
		// trusting the exit code, so the transaction can prove ownership and compensate.
		return { ...parseSuccess(stage, "uncertain-create", ran.stdout), lateCompletion: interrupted };
	}
	if (interrupted) throw new StartAgentError("startup", `${stage}: ${interrupted}`);
	if (ran.exitCode !== 0) {
		const code = structuredCode(ran.stdout) ?? structuredCode(ran.stderr) ?? "command_failed";
		throw new StartAgentError(isCreate ? "layout" : "startup", `${stage}: Herdr ${code}`);
	}
	return parseSuccess(stage, isCreate ? "uncertain-create" : "startup", ran.stdout);
}

/** Herdr acknowledges a successful pane close with exactly `{ type: "ok" }`. */
export function requirePaneCloseSuccess(envelope: HerdrEnvelope): void {
	if (envelope.result.type !== "ok") {
		throw new StartAgentError("compensation", "compensation: malformed Herdr response: expected ok");
	}
}
