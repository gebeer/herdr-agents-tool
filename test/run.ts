import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentSessionServices, SettingsManager } from "@earendil-works/pi-coding-agent";
import { StartAgentError } from "../core/errors.js";
import { runHerdr } from "../core/herdr.js";
import { resolveModelProfile, type ModelConfig } from "../protocol/model-config.js";
import { verifyChildProfile } from "../src/child-profile.js";
import { piHerdrHost } from "../src/herdr-cli.js";
import { loadModelConfig, selectModel, selectProfileFromConfig, startHerdrPiAgent } from "../src/start.js";
import type { SelectedProfile } from "../src/types.js";
import { childNotifyChecks } from "./child-notify.js";
import { claudeModChecks } from "./claude-mod.js";

const previousPane = process.env.HERDR_PANE_ID;
process.env.HERDR_PANE_ID = "w-test:parent";
const root = mkdtempSync(join(tmpdir(), "herdr-agents-tool-test-"));
const profile: SelectedProfile = {
	model: "test/model",
	thinking: "high",
};

const fakePiRuntime = join(root, "fake-pi-runtime.mjs");
const fakeAiRuntime = join(root, "fake-pi-ai.mjs");

writeFileSync(fakePiRuntime, `
import { readFileSync } from "node:fs";
import { join } from "node:path";
const credentialFor = (agentDir) => JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).test;
export const readStoredCredential = (_provider, authPath) => JSON.parse(readFileSync(authPath, "utf8")).test;
export class SettingsManager {
  static create(_cwd, _agentDir, options) {
    if (options?.projectTrusted !== false) throw new Error("project trust was not disabled");
    return {};
  }
}
export async function createAgentSessionServices(options) {
  const { agentDir, settingsManager, resourceLoaderOptions } = options;
  if (!settingsManager || !resourceLoaderOptions?.noExtensions || !resourceLoaderOptions?.noSkills ||
      !resourceLoaderOptions?.noPromptTemplates || !resourceLoaderOptions?.noThemes || !resourceLoaderOptions?.noContextFiles) {
    throw new Error("untrusted project resources were not disabled");
  }
  const credential = credentialFor(agentDir);
  const model = { provider: "test", id: "model", reasoning: true };
  const modelRuntime = {
    getError: () => undefined,
    getModel: (provider, id) => provider === "test" && id === "model" ? model : undefined,
    getAuth: async () => {
      if (credential.type === "oauth") {
        if (credential.expires < Date.now()) {
          if (credential.refresh === "refresh-fails") throw new Error("refresh failed");
          if (credential.refresh !== "refresh-ok") return undefined;
          return { auth: { headers: { authorization: "Bearer refreshed" } }, source: "OAuth" };
        }
        return credential.access ? { auth: { headers: { authorization: "Bearer " + credential.access } }, source: "OAuth" } : undefined;
      }
      return credential.key ? { auth: { apiKey: credential.key } } : undefined;
    },
  };
  return { modelRuntime };
}
export const resolveCliModel = ({ cliModel, modelRuntime }) => {
  const [provider, ...id] = cliModel.split("/");
  const model = modelRuntime.getModel(provider, id.join("/"));
  return { model, warning: undefined, error: undefined };
};
`);
writeFileSync(fakeAiRuntime, `export const getSupportedThinkingLevels = () => ["off", "minimal", "low", "medium", "high", "xhigh", "max"];\n`);
const fakeRuntimeUrls = { codingAgent: pathToFileURL(fakePiRuntime).href, ai: pathToFileURL(fakeAiRuntime).href };

function writeCredential(credential: unknown): void {
	writeFileSync(join(root, "auth.json"), JSON.stringify({ test: credential }));
}

async function expectReject(work: () => Promise<unknown>, message: string): Promise<void> {
	await assert.rejects(work, (error: unknown) => error instanceof Error && error.message.includes(message));
}

function modelAliasChecks(): void {
	const aliases = [
		["sol", "openai-codex", "gpt-5.6-sol"],
		["terra", "openai-codex", "gpt-5.6-terra"],
		["luna", "openai-codex", "gpt-5.6-luna"],
	] as const;
	const lookups: string[] = [];
	const context = {
		modelRegistry: {
			find: (provider: string, id: string) => {
				lookups.push(`${provider}/${id}`);
				return aliases.some(([, expectedProvider, expectedId]) => provider === expectedProvider && id === expectedId)
					? { provider, id }
					: undefined;
			},
		},
	} as never;
	for (const [alias, provider, id] of aliases) {
		const model = selectModel(context, alias);
		assert.equal(model.provider, provider);
		assert.equal(model.id, id);
	}
	assert.deepEqual(lookups, aliases.map(([, provider, id]) => `${provider}/${id}`));
	for (const invalid of ["unknown", "constructor", "toString", "__proto__"]) {
		assert.throws(() => selectModel(context, invalid), /invalid model: use one exact provider\/model-id or configured alias/);
	}
}

function modelConfigChecks(): void {
	const emptyAgentDir = join(root, "empty-agent-config");
	const defaults = loadModelConfig(root, false, emptyAgentDir);
	assert.deepEqual(defaults, {
		fallback: { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
		aliases: {
			sol: { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
			terra: { model: "openai-codex/gpt-5.6-terra", thinking: "medium" },
			luna: { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
		},
	});

	const agentDir = join(root, "agent-config");
	const project = join(root, "config-project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "herdr-agents.json"), JSON.stringify({
		fallback: { model: "global/fallback", thinking: "low" },
		aliases: { fast: { model: "global/fast", thinking: "minimal" } },
	}));
	writeFileSync(join(project, ".pi", "herdr-agents.json"), JSON.stringify({
		fallback: { model: "project/fallback", thinking: "high" },
		aliases: { fast: { model: "project/fast", thinking: "medium" } },
	}));

	const global = loadModelConfig(project, false, agentDir);
	assert.deepEqual(resolveModelProfile(global, undefined, undefined), { model: "global/fallback", thinking: "low" });
	assert.deepEqual(resolveModelProfile(global, "fast", "high"), { model: "global/fast", thinking: "high" });

	const projectConfig = loadModelConfig(project, true, agentDir);
	assert.deepEqual(resolveModelProfile(projectConfig, undefined, undefined), { model: "project/fallback", thinking: "high" });
	assert.deepEqual(resolveModelProfile(projectConfig, "fast", undefined), { model: "project/fast", thinking: "medium" });
	assert.deepEqual(resolveModelProfile(projectConfig, "exact/model", undefined), { model: "exact/model", thinking: "high" });
}

async function profileFallbackChecks(): Promise<void> {
	const config: ModelConfig = {
		fallback: { model: "test/fallback", thinking: "medium" },
		aliases: { requested: { model: "test/requested", thinking: "medium" } },
	};
	const models = new Map([
		["test/fallback", { provider: "test", id: "fallback", reasoning: true }],
		["test/requested", { provider: "test", id: "requested", reasoning: true }],
		["test/no-reasoning", { provider: "test", id: "no-reasoning", reasoning: false }],
	]);
	const context = {
		modelRegistry: { find: (provider: string, id: string) => models.get(`${provider}/${id}`) },
	} as never;
	const checks: string[] = [];
	const verify = async (checked: SelectedProfile): Promise<void> => { checks.push(`${checked.model}:${checked.thinking}`); };

	const ordinary = await selectProfileFromConfig(context, config, "requested", undefined, root, undefined, verify);
	assert.equal(ordinary.fallback, undefined);
	assert.deepEqual(checks.splice(0), ["test/requested:medium"]);

	for (const [requested, thinking, reason] of [
		["unknown", undefined, "invalid model"],
		["bad model", undefined, "invalid model"],
		["test/unavailable", undefined, "canonical model unavailable"],
		["test/no-reasoning", "high", "unsupported thinking level"],
	] as const) {
		const selected = await selectProfileFromConfig(context, config, requested, thinking, root, undefined, verify);
		assert.equal(selected.model, "test/fallback");
		assert.equal(selected.fallback?.requested.model, requested);
		assert.match(selected.fallback?.reason ?? "", new RegExp(reason));
		assert.deepEqual(checks.splice(0), ["test/fallback:medium"]);
	}

	const preflight = await selectProfileFromConfig(context, config, "requested", undefined, root, undefined, async (checked) => {
		checks.push(checked.model);
		if (checked.model === "test/requested") throw new Error("requested auth unavailable");
	});
	assert.equal(preflight.fallback?.reason, "requested auth unavailable");
	assert.deepEqual(checks.splice(0), ["test/requested", "test/fallback"]);

	const omitted = await selectProfileFromConfig(context, config, undefined, "high", root, undefined, verify);
	assert.equal(omitted.thinking, "high");
	assert.equal(omitted.fallback?.reason, "model omitted");
	assert.deepEqual(omitted.fallback?.requested, { thinking: "high" });
	assert.deepEqual(checks.splice(0), ["test/fallback:high"]);

	const bothFailed = () => selectProfileFromConfig(context, config, "requested", undefined, root, undefined, async (checked) => {
		throw new Error(checked.model === "test/requested" ? "requested preflight" : "fallback preflight");
	});
	await expectReject(bothFailed, "requested profile test/requested (medium) failed: requested preflight; fallback profile test/fallback (medium) failed: fallback preflight");

	let layoutCalls = 0;
	await expectReject(() => startHerdrPiAgent(
		{ exec: async () => { layoutCalls++; throw new Error("must not mutate layout"); } } as never,
		{ name: "fallbackfailure", placement: "workspace", model: "requested" },
		undefined,
		{ cwd: root } as never,
		bothFailed,
	), "requested profile test/requested (medium) failed: requested preflight; fallback profile test/fallback (medium) failed: fallback preflight");
	assert.equal(layoutCalls, 0, "both profile failures must happen before layout mutation");
}

async function untrustedProjectCheck(): Promise<void> {
	const project = join(root, "untrusted-project");
	const marker = join(root, "untrusted-extension-ran");
	mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(project, ".pi", "extensions", "marker.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
	await createAgentSessionServices({
		cwd: project,
		agentDir: root,
		settingsManager: SettingsManager.create(project, root, { projectTrusted: false }),
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});
	assert.equal(existsSync(marker), false, "untrusted project extension must not execute during preflight");
}

async function commandAuthCheck(): Promise<void> {
	const commandProfile = join(root, "command-auth-profile");
	const marker = join(root, "command-auth-ran");
	mkdirSync(commandProfile, { recursive: true });
	writeFileSync(join(commandProfile, "auth.json"), JSON.stringify({ command: { type: "api_key", key: "stored-literal" } }));
	writeFileSync(join(commandProfile, "models.json"), JSON.stringify({
		providers: {
			command: {
				baseUrl: "http://127.0.0.1:1/v1",
				api: "openai-completions",
				headers: { Authorization: `!${process.execPath} -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")'` },
				models: [{
					id: "model", name: "Command model", reasoning: true, input: ["text"],
					contextWindow: 1_024, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}],
			},
		},
	}));
	await expectReject(() => verifyChildProfile({
		model: "command/model",
		thinking: "high",
	}, commandProfile, root, undefined), "must not use environment- or command-sourced provider/model configuration");
	assert.equal(existsSync(marker), false, "command-backed model auth must not execute during preflight");
}

async function childProfileChecks(): Promise<void> {
	writeCredential({ type: "oauth", access: "old", refresh: "refresh-ok", expires: Date.now() - 1 });
	await verifyChildProfile(profile, root, root, undefined, fakeRuntimeUrls);

	writeCredential({ type: "oauth", access: "", refresh: "refresh-ok", expires: Date.now() + 60_000 });
	await expectReject(() => verifyChildProfile(profile, root, root, undefined, fakeRuntimeUrls), "stored literal API key or OAuth credential");

	writeCredential({ type: "oauth", access: "old", refresh: "refresh-fails", expires: Date.now() - 1 });
	await expectReject(() => verifyChildProfile(profile, root, root, undefined, fakeRuntimeUrls), "refresh failed");

	writeCredential({ type: "oauth", access: "valid", refresh: "refresh-unused", expires: Date.now() + 3_600_000 });
	await verifyChildProfile(profile, root, root, undefined, fakeRuntimeUrls);
}

async function herdrEnvelopeChecks(): Promise<void> {
	let timeout: number | undefined;
	const replying = (stdout: string) => piHerdrHost({
		exec: async (_command, _args, options) => {
			timeout = options?.timeout;
			return { code: 0, killed: false, stderr: "", stdout };
		},
	}, "/not-run");
	const success = await runHerdr(replying(JSON.stringify({ id: "rpc-1", result: { type: "ok" } })), [], { cwd: root, timeoutMs: 100, stage: "compensation" });
	assert.equal(timeout, 100, "runner must receive the bounded deadline");
	assert.equal(success.result.type, "ok");
	await expectReject(() => runHerdr(replying(JSON.stringify({ result: { type: "ok" } })), [], { cwd: root, timeoutMs: 100, stage: "compensation" }), "malformed Herdr response envelope");
	await expectReject(() => runHerdr(replying("{}"), [], { cwd: root, timeoutMs: 100, stage: "layout create" }), "malformed Herdr response envelope");
}

async function inputValidationChecks(): Promise<void> {
	let calls = 0;
	const pi = { exec: async () => { calls++; throw new Error("must not execute"); } };
	const context = {} as never;
	for (const input of [
		...["", " \n\t", "hello\0world", 123, null].map((prompt) => ({ name: "reviewer", prompt })),
		{ name: "reviewer", placement: "unknown" },
		{ name: "reviewer", placement: ["workspace"] },
		{ name: "reviewer", direction: { value: "right" } },
		{ name: "reviewer", thinking: "unbounded" },
		{ name: "reviewer", kind: "codex" },
		{ name: "reviewer", placement: "workspace", injected: true },
	]) {
		await expectReject(() => startHerdrPiAgent(pi, input as never, undefined, context), "invalid");
	}
	assert.equal(calls, 0, "invalid input must fail before profile checks or layout mutation");
}

function herdrResponse(result: Record<string, unknown>): { code: number; killed: boolean; stderr: string; stdout: string } {
	return { code: 0, killed: false, stderr: "", stdout: JSON.stringify({ id: "test-rpc", result }) };
}

async function placementAndCompensationChecks(): Promise<void> {
	const selectProfile = async (): Promise<SelectedProfile> => profile;
	for (const scenario of [
		{
			input: { name: "panecheck", placement: "pane" },
			created: { type: "pane_info", pane: { pane_id: "w1:p2" } },
			createArgs: ["pane", "split", "--current", "--direction", "right", "--cwd", root, "--no-focus"],
			pane: "w1:p2",
		},
		{
			input: { name: "tabcheck", workspace: "w1" },
			created: { type: "tab_created", tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p3" } },
			createArgs: ["tab", "create", "--workspace", "w1", "--cwd", root, "--label", "tabcheck", "--no-focus"],
			pane: "w1:p3",
		},
		{
			input: { name: "workspacecheck", placement: "workspace" },
			created: { type: "workspace_created", workspace: { workspace_id: "w2" }, tab: { tab_id: "w2:t1" }, root_pane: { pane_id: "w2:p1" } },
			createArgs: ["workspace", "create", "--cwd", root, "--label", "workspacecheck", "--no-focus"],
			pane: "w2:p1",
		},
	]) {
		const calls: Array<{ args: string[]; timeout: number | undefined }> = [];
		const pi = {
			exec: async (_command: string, args: string[], options?: { timeout?: number }) => {
				calls.push({ args, timeout: options?.timeout });
				if (calls.length === 1) return herdrResponse(scenario.created);
				return herdrResponse({
					type: "agent_started",
					agent: { name: scenario.input.name, pane_id: scenario.pane, agent: "pi", interactive_ready: true, launch_pending: false },
					argv: ["pi", ...args.slice(args.indexOf("--") + 1)],
				});
			},
		};
		const started = await startHerdrPiAgent(pi as never, scenario.input as never, undefined, { cwd: root } as never, selectProfile);
		assert.deepEqual(calls[0]?.args, [...scenario.createArgs, "--env", `PI_CODING_AGENT_DIR=${join(homedir(), ".pi", "agent")}`]);
		assert.equal(calls[0]?.timeout, 10_000);
		assert.deepEqual(calls[1]?.args.slice(0, 8), ["agent", "start", scenario.input.name, "--kind", "pi", "--pane", scenario.pane, "--timeout"]);
		const launchArgs = calls[1]!.args;
		assert.equal(launchArgs[launchArgs.indexOf("--exclude-tools") + 1], "herdr_start_agent");
		assert.equal(launchArgs[launchArgs.indexOf("--herdr-parent-pane") + 1], "w-test:parent");
		assert.ok(launchArgs[launchArgs.indexOf("--extension") + 1]?.endsWith("/src/child-notify.ts"));
		assert.match(launchArgs[launchArgs.indexOf("--append-system-prompt") + 1]!, /Do not spawn additional subagents/);
		assert.equal(started.details.pane, scenario.pane);
		assert.equal(calls.length, 2, "omitted prompt must not submit anything");
		assert.equal("promptSubmitted" in started.details, false);
		assert.deepEqual(JSON.parse(started.text), { name: scenario.input.name, pane: scenario.pane });
	}

	const fallbackProfile: SelectedProfile = {
		...profile,
		fallback: {
			requested: { model: "missing", thinking: "high" },
			selected: profile,
			reason: "canonical model unavailable",
		},
	};
	let fallbackCall = 0;
	const fallbackPi = {
		exec: async (_command: string, args: string[]) => {
			fallbackCall++;
			if (fallbackCall === 1) return herdrResponse({ type: "pane_info", pane: { pane_id: "w1:p8" } });
			return herdrResponse({
				type: "agent_started",
				agent: { name: "fallbackcheck", pane_id: "w1:p8", agent: "pi", interactive_ready: true, launch_pending: false },
				argv: ["pi", ...args.slice(args.indexOf("--") + 1)],
			});
		},
	};
	const fallbackStarted = await startHerdrPiAgent(
		fallbackPi as never,
		{ name: "fallbackcheck", placement: "pane", model: "missing", thinking: "high" },
		undefined,
		{ cwd: root } as never,
		async () => fallbackProfile,
	);
	assert.deepEqual(JSON.parse(fallbackStarted.text).fallback, fallbackProfile.fallback);
	assert.deepEqual(fallbackStarted.details.fallback, fallbackProfile.fallback);

	const outer = new AbortController();
	const calls: Array<{ args: string[]; signal?: AbortSignal }> = [];
	const pi = {
		exec: async (_command: string, args: string[], options?: { signal?: AbortSignal }) => {
			calls.push({ args, signal: options?.signal });
			if (calls.length === 1) return herdrResponse({
				type: "workspace_created",
				workspace: { workspace_id: "w9" }, tab: { tab_id: "w9:t1" }, root_pane: { pane_id: "w9:p1" },
			});
			if (calls.length === 2) {
				outer.abort();
				return { code: 1, killed: false, stderr: "", stdout: "" };
			}
			return herdrResponse({ type: "pane_info" });
		},
	};
	await expectReject(() => startHerdrPiAgent(pi as never, { name: "cleanupcheck", placement: "workspace" } as never, outer.signal, { cwd: root } as never, selectProfile), "agent startup: aborted; compensation failed for pane w9:p1: compensation: malformed Herdr response: expected ok");
	assert.deepEqual(calls[2]?.args, ["pane", "close", "w9:p1"]);
	assert.equal(calls[2]?.signal, undefined, "compensation must not take the aborted caller signal");

	const lateAbort = new AbortController();
	const lateCalls: string[][] = [];
	const latePi = {
		exec: async (_command: string, args: string[]) => {
			lateCalls.push(args);
			if (lateCalls.length === 1) {
				lateAbort.abort();
				return {
					...herdrResponse({
						type: "workspace_created",
						workspace: { workspace_id: "w8" }, tab: { tab_id: "w8:t1" }, root_pane: { pane_id: "w8:p1" },
					}),
					code: 1,
					killed: true,
				};
			}
			return herdrResponse({ type: "ok" });
		},
	};
	await expectReject(() => startHerdrPiAgent(latePi as never, { name: "lateabort", placement: "workspace" } as never, lateAbort.signal, { cwd: root } as never, selectProfile), "layout create: aborted; compensation closed created pane");
	assert.deepEqual(lateCalls, [
		["workspace", "create", "--cwd", root, "--label", "lateabort", "--no-focus", "--env", `PI_CODING_AGENT_DIR=${join(homedir(), ".pi", "agent")}`],
		["pane", "close", "w8:p1"],
	]);

	const uncertainCalls: string[][] = [];
	const uncertainPi = {
		exec: async (_command: string, args: string[]) => {
			uncertainCalls.push(args);
			return herdrResponse({ type: "workspace_created", workspace: { workspace_id: "w3" }, tab: { tab_id: "w3:t1" }, root_pane: {} });
		},
	};
	await expectReject(() => startHerdrPiAgent(uncertainPi as never, { name: "uncertaincheck", placement: "workspace" } as never, undefined, { cwd: root } as never, selectProfile), "creation outcome is uncertain and no pane was closed");
	assert.equal(uncertainCalls.length, 1, "uncertain ownership must not attempt cleanup");
}

async function claudeKindChecks(): Promise<void> {
	const pluginRoot = join(import.meta.dirname, "..");
	let profileCalls = 0;
	const selectProfile = async (): Promise<SelectedProfile> => { profileCalls++; return profile; };
	for (const scenario of [
		{ input: { name: "claudecheck", model: "opus", thinking: "high" }, flags: ["--model", "opus", "--effort", "high"], reported: { model: "opus", thinking: "high" } },
		{ input: { name: "claudebare" }, flags: [], reported: {} },
	] as const) {
		const calls: string[][] = [];
		const pi = {
			exec: async (_command: string, args: string[]) => {
				calls.push(args);
				if (calls.length === 1) return herdrResponse({ type: "pane_info", pane: { pane_id: "w1:p4" } });
				return herdrResponse({
					type: "agent_started",
					agent: { name: scenario.input.name, pane_id: "w1:p4", agent: "claude", interactive_ready: true },
					argv: ["claude", ...args.slice(args.indexOf("--") + 1)],
				});
			},
		};
		const started = await startHerdrPiAgent(pi as never, { ...scenario.input, kind: "claude", placement: "pane" } as never, undefined, { cwd: root } as never, selectProfile);
		assert.deepEqual(calls[0], [
			"pane", "split", "--current", "--direction", "right", "--cwd", root, "--no-focus",
			"--env", "HERDR_AGENTS_PARENT_PANE=w-test:parent", "--env", `HERDR_AGENTS_NAME=${scenario.input.name}`,
		]);
		const start = calls[1]!;
		assert.deepEqual(start.slice(2, 7), [scenario.input.name, "--kind", "claude", "--pane", "w1:p4"]);
		assert.deepEqual(start.slice(start.indexOf("--") + 1), [
			"--name", scenario.input.name, ...scenario.flags, "--permission-mode", "bypassPermissions", "--plugin-dir", pluginRoot,
		]);
		assert.deepEqual(JSON.parse(started.text), { name: scenario.input.name, pane: "w1:p4", ...scenario.reported });
		assert.equal(started.details.model, scenario.reported.model);
		assert.equal(started.details.thinking, scenario.reported.thinking);
	}
	assert.equal(profileCalls, 0, "claude children skip pi profile selection");

	let calls = 0;
	const pi = { exec: async () => { calls++; throw new Error("must not execute"); } };
	for (const [input, message] of [
		[{ name: "claudeoff", kind: "claude", thinking: "off" }, "unsupported thinking level for claude: off"],
		[{ name: "claudebad", kind: "claude", model: "bad model" }, "invalid model for claude"],
	] as const) {
		await assert.rejects(
			() => startHerdrPiAgent(pi, input as never, undefined, { cwd: root } as never, selectProfile),
			(error: unknown) => error instanceof StartAgentError && error.kind === "validation" && error.message.includes(message),
		);
	}
	assert.equal(calls, 0, "invalid claude launch must fail before layout mutation");
}

async function promptChecks(): Promise<void> {
	const prompt = '  Review "this"; $(not-a-shell)\n日本語\n  ';
	for (const scenario of ["success", "not-ready", "wrong-type", "wrong-name", "wrong-pane", "wrong-kind", "timeout", "abort", "transport", "rejected"]) {
		const calls: string[][] = [];
		const controller = new AbortController();
		const agent = { name: "promptcheck", pane_id: "w1:p2", agent: "pi", interactive_ready: true };
		const pi = {
			exec: async (_command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => {
				calls.push(args);
				if (args[1] === "split") return herdrResponse({ type: "pane_info", pane: { pane_id: agent.pane_id } });
				if (args[1] === "start") return herdrResponse({
					type: "agent_started",
					agent: { ...agent, interactive_ready: scenario !== "not-ready" },
					argv: ["pi", ...args.slice(args.indexOf("--") + 1)],
				});
				if (args[1] === "close") return herdrResponse({ type: "ok" });
				assert.deepEqual(args, ["agent", "prompt", agent.name, prompt]);
				assert.equal(options?.timeout, 10_000);
				assert.equal(options?.signal, controller.signal);
				if (scenario === "transport") throw new Error("transport failed");
				if (scenario === "abort") controller.abort();
				if (scenario === "rejected") return { ...herdrResponse({}), code: 1, stdout: '{"error":{"code":"agent_blocked"}}' };
				return {
					...herdrResponse({
						type: scenario === "wrong-type" ? "ok" : "agent_prompted",
						agent: { ...agent,
							...(scenario === "wrong-name" ? { name: "other" } : {}),
							...(scenario === "wrong-pane" ? { pane_id: "w1:p9" } : {}),
							...(scenario === "wrong-kind" ? { agent: "claude" } : {}),
						},
					}),
					killed: scenario === "timeout",
				};
			},
		};
		const run = () => startHerdrPiAgent(pi, { name: agent.name, placement: "pane", prompt }, controller.signal, { cwd: root } as never, async () => profile);
		if (scenario === "success") {
			const result = await run();
			assert.equal(result.details.promptSubmitted, true);
			assert.deepEqual(JSON.parse(result.text), { name: agent.name, pane: agent.pane_id, promptSubmitted: true });
		} else if (scenario === "not-ready") {
			await expectReject(run, "agent_not_ready");
			assert.deepEqual(calls[2], ["pane", "close", agent.pane_id]);
		} else {
			await expectReject(run, `agent ${agent.name} in pane ${agent.pane_id} left running; prompt delivery may be uncertain`);
			assert.equal(calls.some((args) => args[1] === "close"), false, scenario);
		}
		assert.equal(calls.filter((args) => args[1] === "prompt").length, scenario === "not-ready" ? 0 : 1, scenario);
	}
}

try {
	modelAliasChecks();
	modelConfigChecks();
	await profileFallbackChecks();
	await untrustedProjectCheck();
	await commandAuthCheck();
	await childProfileChecks();
	await herdrEnvelopeChecks();
	await inputValidationChecks();
	await placementAndCompensationChecks();
	await claudeKindChecks();
	await promptChecks();
	await childNotifyChecks();
	await claudeModChecks();
	console.log("unit checks passed: child trust/auth, Herdr envelopes, placements, compensation, runtime input validation, and the Claude Code mod core");
} finally {
	rmSync(root, { recursive: true, force: true });
	if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
	else process.env.HERDR_PANE_ID = previousPane;
}
