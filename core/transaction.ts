import { StartAgentError } from "./errors.ts";
import { herdrId, record, requirePaneCloseSuccess, runHerdr, type HerdrHost, type HerdrResult } from "./herdr.ts";
import type { Placement, StartRequest } from "./request.ts";

const CREATE_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 35_000;
const HERDR_READY_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 10_000;
const COMPENSATION_TIMEOUT_MS = 5_000;

/** How Herdr starts one child: its agent kind, the arguments after its executable, and its pane's env. */
export type Launch = {
	kind: string;
	argv: readonly string[];
	env: Readonly<Record<string, string>>;
};

export interface OwnedLocation {
	paneId: string;
	tabId?: string;
	workspaceId?: string;
}

export type StartedAgent = OwnedLocation & { herdr: HerdrResult };

function requireId(value: unknown, label: string, ownedPaneId?: string): string {
	const found = herdrId(value);
	if (!found) throw new StartAgentError("layout", `malformed create response: missing ${label}`, ownedPaneId);
	return found;
}

function requireRecord(value: unknown, label: string, ownedPaneId?: string): HerdrResult {
	const found = record(value);
	if (!found) throw new StartAgentError("layout", `malformed create response: missing ${label}`, ownedPaneId);
	return found;
}

function requireResultType(result: HerdrResult, expected: string): void {
	if (result.type !== expected) throw new StartAgentError("layout", `malformed create response: expected ${expected}`);
}

/** Proves ownership of the created root pane first, so any later malformation still rolls it back. */
function parseCreatedLocation(placement: Placement, result: HerdrResult): OwnedLocation {
	try {
		switch (placement) {
			case "pane": {
				requireResultType(result, "pane_info");
				const pane = requireRecord(result.pane, "pane");
				return { paneId: requireId(pane.pane_id, "pane.pane_id") };
			}
			case "tab": {
				requireResultType(result, "tab_created");
				const rootPane = requireRecord(result.root_pane, "root_pane");
				const paneId = requireId(rootPane.pane_id, "root_pane.pane_id");
				const tab = requireRecord(result.tab, "tab", paneId);
				return { paneId, tabId: requireId(tab.tab_id, "tab.tab_id", paneId) };
			}
			case "workspace": {
				requireResultType(result, "workspace_created");
				const rootPane = requireRecord(result.root_pane, "root_pane");
				const paneId = requireId(rootPane.pane_id, "root_pane.pane_id");
				const tab = requireRecord(result.tab, "tab", paneId);
				const workspace = requireRecord(result.workspace, "workspace", paneId);
				return {
					paneId,
					tabId: requireId(tab.tab_id, "tab.tab_id", paneId),
					workspaceId: requireId(workspace.workspace_id, "workspace.workspace_id", paneId),
				};
			}
		}
	} catch (error) {
		if (error instanceof StartAgentError && error.ownedPaneId) throw error;
		throw new StartAgentError("uncertain-create", "malformed create response: ownership was not proven");
	}
}

function createArgs(request: StartRequest, cwd: string, env: Launch["env"]): string[] {
	const envArgs = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
	switch (request.placement) {
		case "pane": return ["pane", "split", "--current", "--direction", request.direction!, "--cwd", cwd, "--no-focus", ...envArgs];
		case "tab": return ["tab", "create", "--workspace", request.workspace!, "--cwd", cwd, "--label", request.name, "--no-focus", ...envArgs];
		case "workspace": return ["workspace", "create", "--cwd", cwd, "--label", request.name, "--no-focus", ...envArgs];
	}
}

function sameArgv(actual: unknown, expected: readonly string[]): boolean {
	return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

function validateAgentStarted(result: HerdrResult, name: string, paneId: string, launch: Launch): void {
	if (result.type !== "agent_started") throw new StartAgentError("startup", "malformed start response: expected agent_started", paneId);
	const agent = record(result.agent);
	if (!agent) throw new StartAgentError("startup", "malformed start response: missing agent", paneId);
	if (agent.name !== name || agent.pane_id !== paneId || agent.agent !== launch.kind) {
		throw new StartAgentError("startup", "mismatched start response: agent name, kind, or pane", paneId);
	}
	if (agent.interactive_ready !== true || agent.launch_pending === true) {
		throw new StartAgentError("startup", "agent_not_ready", paneId);
	}
	if (!sameArgv(result.argv, [launch.kind, ...launch.argv])) {
		throw new StartAgentError("startup", "mismatched start response: argv", paneId);
	}
}

/**
 * One fresh attempt to close exactly the owned pane, accepted only on Herdr's `ok`. It never
 * reuses the caller's signal, which may be the reason for the rollback.
 */
async function compensate(host: HerdrHost, paneId: string, cwd: string): Promise<string | undefined> {
	try {
		const closed = await runHerdr(host, ["pane", "close", paneId], {
			cwd, timeoutMs: COMPENSATION_TIMEOUT_MS, stage: "compensation", signal: new AbortController().signal,
		});
		requirePaneCloseSuccess(closed);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : "compensation failed";
	}
}

async function rolledBack(host: HerdrHost, primary: Error, paneId: string, cwd: string): Promise<Error> {
	const cleanupFailure = await compensate(host, paneId, cwd);
	return cleanupFailure
		? new Error(`${primary.message}; compensation failed for pane ${paneId}: ${cleanupFailure}`)
		: new Error(`${primary.message}; compensation closed created pane`);
}

/** Once ready, the agent is never rolled back or retried: a failed acknowledgement may hide delivered work. */
async function submitPrompt(host: HerdrHost, request: StartRequest, launch: Launch, paneId: string, prompt: string, cwd: string, signal?: AbortSignal): Promise<void> {
	try {
		signal?.throwIfAborted();
		const prompted = await runHerdr(host, ["agent", "prompt", request.name, prompt], {
			cwd, signal, timeoutMs: PROMPT_TIMEOUT_MS, stage: "prompt submission",
		});
		const agent = record(prompted.result.agent);
		if (prompted.result.type !== "agent_prompted" || agent?.name !== request.name ||
			agent.pane_id !== paneId || agent.agent !== launch.kind) {
			throw new Error("malformed or mismatched agent_prompted response");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "prompt submission failed";
		throw new Error(`${message}; agent ${request.name} in pane ${paneId} left running; prompt delivery may be uncertain; inspect before retrying`);
	}
}

/**
 * One bounded create → start → optional prompt transaction in a new Herdr location.
 * A pane is closed only once this call has proven it created it; it keeps no state after returning.
 */
export async function startInNewLocation(
	host: HerdrHost,
	request: StartRequest,
	cwd: string,
	launch: Launch,
	signal?: AbortSignal,
): Promise<StartedAgent> {
	let owned: OwnedLocation;
	try {
		const created = await runHerdr(host, createArgs(request, cwd, launch.env), {
			cwd, signal, timeoutMs: CREATE_TIMEOUT_MS, stage: "layout create",
		});
		owned = parseCreatedLocation(request.placement, created.result);
		if (created.lateCompletion) {
			throw new StartAgentError("layout", `layout create: ${created.lateCompletion}`, owned.paneId);
		}
	} catch (error) {
		const failure = error instanceof StartAgentError ? error : new StartAgentError("layout", "layout failure");
		if (!failure.ownedPaneId) {
			if (failure.kind === "uncertain-create") throw new Error(`${failure.message}; creation outcome is uncertain and no pane was closed`);
			throw new Error(failure.message);
		}
		throw await rolledBack(host, failure, failure.ownedPaneId, cwd);
	}

	let started: HerdrResult;
	try {
		const response = await runHerdr(host, [
			"agent", "start", request.name, "--kind", launch.kind, "--pane", owned.paneId,
			"--timeout", String(HERDR_READY_TIMEOUT_MS), "--", ...launch.argv,
		], { cwd, signal, timeoutMs: START_TIMEOUT_MS, stage: "agent startup" });
		validateAgentStarted(response.result, request.name, owned.paneId, launch);
		started = response.result;
	} catch (error) {
		throw await rolledBack(host, error instanceof Error ? error : new Error("agent startup failed"), owned.paneId, cwd);
	}

	if (request.prompt !== undefined) await submitPrompt(host, request, launch, owned.paneId, request.prompt, cwd, signal);
	return { ...owned, herdr: started };
}
