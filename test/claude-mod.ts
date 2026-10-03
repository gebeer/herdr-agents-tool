import assert from "node:assert/strict";
import { reportToOrchestrator, subagentSection } from "../hooks/child.ts";
import { herdrContext } from "../hooks/context.ts";
import type { Host } from "../hooks/host.ts";
import { startAgent } from "../hooks/start.ts";
import type { RunResult } from "../core/herdr.ts";
import { validateStartRequest } from "../core/request.ts";
import { piChildArgv } from "../protocol/pi-child.ts";

const ORCHESTRATOR = { pane: "w:parent", workspace: "w" };
const PI_CONFIG = JSON.stringify({
	fallback: { model: "test/fallback", thinking: "low" },
	aliases: { terra: { model: "test/terra", thinking: "medium" } },
});

type Responder = (args: string[]) => RunResult | "throw";

const ok = (result: Record<string, unknown>): RunResult => ({ exitCode: 0, stdout: JSON.stringify({ id: "r", result }), stderr: "" });

/** A Herdr that creates tab w:t2 with root pane w:p2 and starts whatever it is asked to. */
function herdr(overrides: Partial<Record<"create" | "start" | "prompt" | "close", Responder>> = {}): Responder {
	return (args) => {
		const [noun, verb] = args;
		if (noun === "tab" || noun === "pane" && verb === "split" || noun === "workspace") {
			return overrides.create?.(args) ?? ok({ type: "tab_created", root_pane: { pane_id: "w:p2" }, tab: { tab_id: "w:t2" } });
		}
		if (noun === "agent" && verb === "start") {
			const kind = args[args.indexOf("--kind") + 1];
			return overrides.start?.(args) ?? ok({
				type: "agent_started",
				agent: { name: args[2], pane_id: args[args.indexOf("--pane") + 1], agent: kind, interactive_ready: true },
				argv: [kind, ...args.slice(args.indexOf("--") + 1)],
			});
		}
		if (noun === "agent" && verb === "prompt") {
			return overrides.prompt?.(args) ?? ok({ type: "agent_prompted", agent: { name: args[2], pane_id: "w:p2", agent: "claude" } });
		}
		if (noun === "pane" && verb === "close") return overrides.close?.(args) ?? ok({ type: "ok" });
		throw new Error(`unexpected herdr call: ${args.join(" ")}`);
	};
}

function fakeHost(respond: Responder, files: Record<string, string> = {}): Host & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		run: async (argv) => {
			assert.equal(argv[0], "/bin/herdr");
			const args = argv.slice(1);
			calls.push(args);
			const response = respond(args);
			if (response === "throw") throw new Error("timeout");
			return response;
		},
		herdrBinary: "/bin/herdr",
		pluginRoot: "/plugin",
		home: "/home/me",
		sessionCwd: "/work",
		realDirectory: async (path) => (path === "/work" || path === "/work/sub" ? path : undefined),
		readFile: async (path) => files[path],
	};
}

const piFiles = { "/home/me/.pi/agent/herdr-agents.json": PI_CONFIG };

function contextChecks(): void {
	const base = { HERDR_ENV: "1", HERDR_PANE_ID: "w:p1", HERDR_WORKSPACE_ID: "w", HERDR_AGENTS_PARENT_PANE: undefined, HERDR_AGENTS_NAME: undefined };
	assert.deepEqual(herdrContext(base), { role: "orchestrator", pane: "w:p1", workspace: "w" });
	assert.deepEqual(herdrContext({ ...base, HERDR_AGENTS_PARENT_PANE: "w:p0", HERDR_AGENTS_NAME: "worker" }), {
		role: "child", pane: "w:p1", parentPane: "w:p0", name: "worker",
	});
	assert.equal(herdrContext({ ...base, HERDR_ENV: undefined }), undefined);
	assert.equal(herdrContext({ ...base, HERDR_PANE_ID: " w:p1" }), undefined);
	assert.equal(herdrContext({ ...base, HERDR_WORKSPACE_ID: undefined }), undefined);
}

async function validationChecks(): Promise<void> {
	assert.deepEqual(validateStartRequest({ name: "worker" }, "w"), {
		name: "worker", placement: "tab", workspace: "w",
		cwd: undefined, model: undefined, thinking: undefined, prompt: undefined,
	});
	assert.equal(validateStartRequest({ name: "worker", placement: "pane" }, "w").direction, "right");
	for (const [input, error] of [
		[{ name: "Worker" }, /invalid name/],
		[{ name: "worker", extra: 1 }, /invalid input field: extra/],
		[{ name: "worker", kind: "codex" }, /invalid kind/],
		[{ name: "worker", placement: "pane", workspace: "w" }, /workspace applies only to tab/],
		[{ name: "worker", direction: "down" }, /direction applies only to pane/],
		[{ name: "worker", prompt: "  " }, /invalid prompt/],
		[{ name: "worker", thinking: "huge" }, /invalid thinking level/],
		[{ name: "worker", permissionMode: "yolo" }, /invalid permissionMode/],
	] as const) {
		const host = fakeHost(herdr());
		await assert.rejects(startAgent(host, input, ORCHESTRATOR), error);
		assert.equal(host.calls.length, 0, "invalid input must fail before any Herdr call");
	}
}

async function claudeStartChecks(): Promise<void> {
	const host = fakeHost(herdr());
	const text = await startAgent(host, { name: "worker", kind: "claude", model: "opus", thinking: "high", prompt: "Do it." }, ORCHESTRATOR);
	assert.deepEqual(JSON.parse(text), { name: "worker", kind: "claude", pane: "w:p2", model: "opus", thinking: "high", promptSubmitted: true });
	const [create, start, prompt] = host.calls;
	assert.deepEqual(create, [
		"tab", "create", "--workspace", "w", "--cwd", "/work", "--label", "worker", "--no-focus",
		"--env", "HERDR_AGENTS_PARENT_PANE=w:parent", "--env", "HERDR_AGENTS_NAME=worker",
	]);
	assert.deepEqual(start!.slice(0, 9), ["agent", "start", "worker", "--kind", "claude", "--pane", "w:p2", "--timeout", "30000"]);
	const argv = start!.slice(start!.indexOf("--") + 1);
	assert.deepEqual(argv, ["--name", "worker", "--model", "opus", "--effort", "high", "--permission-mode", "acceptEdits", "--plugin-dir", "/plugin"]);
	assert.deepEqual(prompt, ["agent", "prompt", "worker", "Do it."]);
	assert.equal(host.calls.length, 3);

	const bare = fakeHost(herdr());
	await startAgent(bare, { name: "idle", kind: "claude", cwd: "sub", permissionMode: "plan" }, ORCHESTRATOR);
	const bareArgv = bare.calls[1]!.slice(bare.calls[1]!.indexOf("--") + 1);
	assert.ok(!bareArgv.includes("--model") && !bareArgv.includes("--effort"));
	assert.equal(bareArgv[bareArgv.indexOf("--permission-mode") + 1], "plan");
	assert.ok(bare.calls[0]!.includes("/work/sub"));
	assert.equal(bare.calls.length, 2, "no prompt, no submission");

	await assert.rejects(startAgent(fakeHost(herdr()), { name: "w", kind: "claude", thinking: "minimal" }, ORCHESTRATOR), /unsupported thinking level for claude/);
	await assert.rejects(startAgent(fakeHost(herdr()), { name: "w", kind: "claude", model: "bad model" }, ORCHESTRATOR), /invalid model for claude/);
	await assert.rejects(startAgent(fakeHost(herdr()), { name: "w", cwd: "missing" }, ORCHESTRATOR), /invalid cwd/);
}

async function piStartChecks(): Promise<void> {
	const host = fakeHost(herdr({ prompt: (args) => ok({ type: "agent_prompted", agent: { name: args[2], pane_id: "w:p2", agent: "pi" } }) }), piFiles);
	const text = await startAgent(host, { name: "piworker", kind: "pi", model: "terra", prompt: "Go." }, ORCHESTRATOR);
	assert.deepEqual(JSON.parse(text), { name: "piworker", kind: "pi", pane: "w:p2", model: "test/terra", thinking: "medium", promptSubmitted: true });
	assert.deepEqual(host.calls[0]!.slice(-2), ["--env", "PI_CODING_AGENT_DIR=/home/me/.pi/agent"]);
	const start = host.calls[1]!;
	assert.deepEqual(start.slice(start.indexOf("--") + 1), piChildArgv({
		name: "piworker", model: "test/terra", thinking: "medium", parentPane: "w:parent", notifierPath: "/plugin/src/child-notify.ts",
	}));

	const fallback = fakeHost(herdr(), piFiles);
	assert.equal(JSON.parse(await startAgent(fallback, { name: "fb", kind: "pi", thinking: "high" }, ORCHESTRATOR)).model, "test/fallback");
	const exact = fakeHost(herdr(), piFiles);
	assert.equal(JSON.parse(await startAgent(exact, { name: "ex", kind: "pi", model: "x/y" }, ORCHESTRATOR)).thinking, "low");
	const defaults = fakeHost(herdr());
	const byDefault = JSON.parse(await startAgent(defaults, { name: "df" }, ORCHESTRATOR));
	assert.equal(byDefault.kind, "pi", "pi is the default kind");
	assert.equal(byDefault.model, "openai-codex/gpt-5.6-sol");

	await assert.rejects(startAgent(fakeHost(herdr(), piFiles), { name: "w", kind: "pi", model: "opus" }, ORCHESTRATOR), /invalid model for pi/);
	await assert.rejects(startAgent(fakeHost(herdr(), piFiles), { name: "w", kind: "pi", permissionMode: "plan" }, ORCHESTRATOR), /permissionMode applies only to claude/);
	await assert.rejects(
		startAgent(fakeHost(herdr(), { "/home/me/.pi/agent/herdr-agents.json": "{" }), { name: "w", kind: "pi" }, ORCHESTRATOR),
		/invalid config \/home\/me\/.pi\/agent\/herdr-agents.json/,
	);
	await assert.rejects(
		startAgent(fakeHost(herdr(), { "/home/me/.pi/agent/herdr-agents.json": '{"aliases":{"Bad":{}}}' }), { name: "w", kind: "pi" }, ORCHESTRATOR),
		/alias: Bad/,
	);
}

async function rollbackChecks(): Promise<void> {
	const failedStart = fakeHost(herdr({ start: () => ({ exitCode: 1, stdout: JSON.stringify({ error: { code: "agent_not_detected" } }), stderr: "" }) }));
	await assert.rejects(startAgent(failedStart, { name: "w" }, ORCHESTRATOR), /agent startup: Herdr agent_not_detected; compensation closed created pane/);
	assert.deepEqual(failedStart.calls.at(-1), ["pane", "close", "w:p2"]);

	const notReady = fakeHost(herdr({ start: (args) => ok({ type: "agent_started", agent: { name: args[2], pane_id: "w:p2", agent: "claude", interactive_ready: false } }) }));
	await assert.rejects(startAgent(notReady, { name: "w", kind: "claude" }, ORCHESTRATOR), /agent_not_ready; compensation closed created pane/);

	const closeFails = fakeHost(herdr({ start: () => "throw", close: () => ok({ type: "nope" }) }));
	await assert.rejects(startAgent(closeFails, { name: "w" }, ORCHESTRATOR), /agent startup: Herdr transport failure; compensation failed for pane w:p2: compensation: malformed Herdr response: expected ok/);

	// The user interrupts while create runs: $.process.run cannot be cut, so the created pane is closed afterwards.
	const interrupt = new AbortController();
	const interrupted = fakeHost(herdr({ create: () => (interrupt.abort(), ok({ type: "tab_created", root_pane: { pane_id: "w:p2" }, tab: { tab_id: "w:t2" } })) }));
	await assert.rejects(startAgent(interrupted, { name: "w", prompt: "x" }, ORCHESTRATOR, interrupt.signal), /layout create: aborted; compensation closed created pane/);
	assert.deepEqual(interrupted.calls.map(([noun, verb]) => `${noun} ${verb}`), ["tab create", "pane close"]);

	const uncertain = fakeHost(herdr({ create: () => "throw" }));
	await assert.rejects(startAgent(uncertain, { name: "w" }, ORCHESTRATOR), /creation outcome is uncertain and no pane was closed/);
	assert.equal(uncertain.calls.length, 1);

	const unproven = fakeHost(herdr({ create: () => ok({ type: "tab_created" }) }));
	await assert.rejects(startAgent(unproven, { name: "w" }, ORCHESTRATOR), /ownership was not proven; creation outcome is uncertain and no pane was closed/);
	assert.equal(unproven.calls.length, 1);

	const noTab = fakeHost(herdr({ create: () => ok({ type: "tab_created", root_pane: { pane_id: "w:p2" } }) }));
	await assert.rejects(startAgent(noTab, { name: "w" }, ORCHESTRATOR), /malformed create response: missing tab; compensation closed created pane/);
	assert.deepEqual(noTab.calls.at(-1), ["pane", "close", "w:p2"]);

	const layoutRefused = fakeHost(herdr({ create: () => ({ exitCode: 1, stdout: "", stderr: '{"code":"workspace_not_found"}' }) }));
	await assert.rejects(startAgent(layoutRefused, { name: "w" }, ORCHESTRATOR), /layout create: Herdr workspace_not_found$/);

	const promptFails = fakeHost(herdr({ prompt: () => "throw" }));
	await assert.rejects(startAgent(promptFails, { name: "w", prompt: "x" }, ORCHESTRATOR), /left running; prompt delivery may be uncertain/);
	assert.ok(!promptFails.calls.some(([noun, verb]) => noun === "pane" && verb === "close"), "a ready agent is never rolled back");
}

async function childReportChecks(): Promise<void> {
	const child = { role: "child" as const, pane: "w:p2", parentPane: "w:parent", name: "worker" };
	assert.deepEqual({ ...subagentSection(child), text: undefined }, { id: "herdr-agents:subagent", scope: "session", text: undefined });
	assert.ok(subagentSection(child).text.includes("Herdr pane w:parent"));
	const acknowledged = fakeHost(() => ok({ type: "agent_prompted", agent: { pane_id: "w:parent", agent: "claude" } }));
	assert.equal(await reportToOrchestrator(acknowledged, { reason: "answer", answer: "Done." }, child), undefined);
	const [args] = acknowledged.calls;
	assert.deepEqual(args!.slice(0, 3), ["agent", "prompt", "w:parent"]);
	const report = args![3]!;
	assert.ok(report.startsWith('\n[Subagent report {"name":"worker","pane":"w:p2"}; answer]\n'));
	assert.ok(report.includes("Safe Cleanup: herdr pane close w:p2\n\nDone.\n[End subagent report]\n"));

	const toPi = fakeHost(() => ok({ type: "agent_prompted", agent: { pane_id: "w:parent", agent: "pi" } }));
	assert.equal(await reportToOrchestrator(toPi, { reason: "answer", answer: "" }, child), undefined);
	assert.ok(toPi.calls[0]![3]!.includes("(No response text.)"));

	const mismatched = fakeHost(() => ok({ type: "agent_prompted", agent: { pane_id: "other", agent: "claude" } }));
	assert.match((await reportToOrchestrator(mismatched, { reason: "answer", answer: "x" }, child))!, /mismatched notification acknowledgement.*no retry/);
	const offline = fakeHost(() => "throw");
	assert.match((await reportToOrchestrator(offline, { reason: "error", answer: "x" }, child))!, /transport failure/);
	assert.equal(offline.calls.length, 1);
}

export async function claudeModChecks(): Promise<void> {
	contextChecks();
	await validationChecks();
	await claudeStartChecks();
	await piStartChecks();
	await rollbackChecks();
	await childReportChecks();
}
