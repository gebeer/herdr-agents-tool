import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { TOOL_NAME } from "../src/types.js";

if (process.env.RUN_HERDR_INTEGRATION !== "1") {
	console.log("integration skipped (set RUN_HERDR_INTEGRATION=1 for the disposable Herdr flow)");
	process.exit(0);
}

if (process.env.HERDR_ENV !== "1") throw new Error("integration requires a Herdr-managed caller pane");
const agentDir = join(homedir(), ".pi", "agent");

const cwd = process.cwd();
const session = `herdr-agents-tool-${randomUUID().slice(0, 8)}`;
const name = `check_${randomUUID().slice(0, 8)}`;
const socketPath = join(process.env.HOME ?? "/tmp", ".config", "herdr", "sessions", session, "herdr.sock");
let createdPane: string | undefined;
let childSessionFile: string | undefined;
let primaryError: unknown;

function herdr(args: string[]): Record<string, unknown> {
	const result = spawnSync("herdr", ["--session", session, ...args], { cwd, encoding: "utf8", shell: false, timeout: 40_000 });
	if (result.error || result.status !== 0) throw new Error(`Herdr command failed: ${result.error?.message ?? result.stderr}`);
	const value: unknown = JSON.parse(result.stdout);
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
	assert.ok(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}

function maybeRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function childSessionReference(value: unknown): string | undefined {
	const agent = maybeRecord(value);
	const reference = maybeRecord(agent?.agent_session);
	return reference?.kind === "path" && reference.source === "herdr:pi" && typeof reference.value === "string"
		? reference.value
		: undefined;
}

function control(args: string[], label: string): void {
	const result = spawnSync("herdr", args, { cwd, encoding: "utf8", shell: false, timeout: 10_000 });
	if (result.error || result.status !== 0) throw new Error(`${label} failed: ${result.error?.message ?? result.stderr}`);
}

function removeChildSessionArtifact(file: string): void {
	const sessionsRoot = `${resolve(agentDir, "sessions")}${sep}`;
	const canonical = resolve(file);
	if (!canonical.startsWith(sessionsRoot)) throw new Error("child session reference is outside the default profile sessions directory");
	if (existsSync(canonical)) unlinkSync(canonical);
	const parent = dirname(canonical);
	if (!parent.startsWith(sessionsRoot) || !existsSync(parent)) return;
	if (readdirSync(parent).length === 0) {
		rmdirSync(parent);
		return;
	}
	// Other sessions share this directory; leave their artifacts intact.
}

async function startDisposableServer(): Promise<void> {
	const serverEnv = { ...process.env };
	delete serverEnv.PI_SESSION_FILE;
	delete serverEnv.PI_SESSION_ID;
	const server = spawn("herdr", ["--session", session, "server"], { cwd, env: serverEnv, detached: true, stdio: "ignore", shell: false });
	server.unref();
	for (let attempt = 0; attempt < 25; attempt++) {
		const probe = spawnSync("herdr", ["--session", session, "workspace", "list"], { cwd, encoding: "utf8", timeout: 1_000 });
		if (probe.status === 0) return;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("disposable Herdr server did not become ready");
}

async function readChildSession(file: string): Promise<Record<string, unknown>[]> {
	for (let attempt = 0; attempt < 25; attempt++) {
		if (existsSync(file)) return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("Herdr reported a child session reference that Pi did not persist");
}

try {
	await startDisposableServer();
	const previousSocket = process.env.HERDR_SOCKET_PATH;
	process.env.HERDR_SOCKET_PATH = socketPath;
	let sdkSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const runtime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const model = runtime.getModel("openai-codex", "gpt-5.6-terra");
		assert.ok(model, "test profile must contain the integration model");
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [cwd],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, [], "package must load cleanly through Pi's resource runtime");
		const created = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			model,
			thinkingLevel: "high",
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			tools: [TOOL_NAME],
		});
		sdkSession = created.session;
		await sdkSession.bindExtensions({ mode: "print" });
		const tool = sdkSession.agent.state.tools.find((candidate) => candidate.name === TOOL_NAME);
		assert.ok(tool, "Pi must assemble the package's registered tool");
		const result = await tool.execute("integration", {
			name,
			placement: "workspace",
			cwd,
			model: "openai-codex/gpt-5.6-terra",
			thinking: "high",
			prompt: "Do not use tools or memory. Reply exactly OK",
		});
		const details = result.details as { pane: string; model: string; thinking: string; promptSubmitted?: true; herdr: { argv: string[]; agent?: unknown } };
		createdPane = details.pane;
		childSessionFile = childSessionReference(details.herdr.agent);
		assert.deepEqual(details.herdr.argv, ["pi", "--name", name, "--model", details.model, "--thinking", details.thinking]);
		assert.equal(details.promptSubmitted, true);
		assert.equal(JSON.parse(result.content[0].type === "text" ? result.content[0].text : "{}").promptSubmitted, true);
		herdr(["agent", "wait", name, "--until", "done", "--timeout", "30000"]);
		const agent = record(record(herdr(["agent", "get", name]).result).agent);
		const reference = record(agent.agent_session);
		assert.equal(reference.kind, "path");
		assert.equal(reference.source, "herdr:pi");
		assert.equal(typeof reference.value, "string");
		childSessionFile = childSessionReference(agent);
		assert.ok(childSessionFile, "Herdr must report the child session reference");
		const entries = await readChildSession(childSessionFile);
		assert.ok(entries.some((entry) => entry.type === "model_change" && entry.provider === details.model.split("/")[0] && entry.modelId === details.model.split("/")[1]));
		assert.ok(entries.some((entry) => entry.type === "thinking_level_change" && entry.thinkingLevel === details.thinking));
		assert.ok(entries.some((entry) => {
			const message = entry.type === "message" ? record(entry.message) : undefined;
			const content = Array.isArray(message?.content) ? message.content : [];
			return message?.role === "assistant" && message.provider === details.model.split("/")[0] &&
				message.model === details.model.split("/")[1] &&
				content.filter((part) => record(part).type === "text").map((part) => record(part).text).join("").trim() === "OK";
		}));
		const closed = herdr(["pane", "close", details.pane]);
		assert.equal(record(closed.result).type, "ok");
		createdPane = undefined;
		console.log("disposable Herdr integration passed: Pi resource-loaded package, assembled tool, exact provider ping, and child effective model/thinking session entries");
	} finally {
		sdkSession?.dispose();
		if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
		else process.env.HERDR_SOCKET_PATH = previousSocket;
	}
} catch (error) {
	primaryError = error;
	throw error;
} finally {
	const cleanupErrors: string[] = [];
	if (!childSessionFile && createdPane) {
		try {
			childSessionFile = childSessionReference(record(herdr(["agent", "get", name]).result).agent);
		} catch (error) {
			cleanupErrors.push(`could not recover child session reference: ${error instanceof Error ? error.message : "unknown error"}`);
		}
	}
	try {
		if (createdPane) herdr(["pane", "close", createdPane]);
	} catch (error) {
		cleanupErrors.push(`could not close created pane: ${error instanceof Error ? error.message : "unknown error"}`);
	}
	try {
		if (childSessionFile) removeChildSessionArtifact(childSessionFile);
	} catch (error) {
		cleanupErrors.push(`could not remove child session artifact: ${error instanceof Error ? error.message : "unknown error"}`);
	}
	let stopped = false;
	try {
		control(["--session", session, "server", "stop"], "disposable Herdr server stop");
		stopped = true;
	} catch (error) {
		cleanupErrors.push(error instanceof Error ? error.message : "disposable Herdr server stop failed");
	}
	if (stopped) {
		try {
			control(["session", "delete", "--json", session], "disposable Herdr session delete");
		} catch (error) {
			cleanupErrors.push(error instanceof Error ? error.message : "disposable Herdr session delete failed");
		}
	}
	if (cleanupErrors.length > 0) {
		const message = `disposable integration cleanup incomplete for ${session}: ${cleanupErrors.join("; ")}`;
		if (primaryError) console.error(message);
		else throw new Error(message);
	}
}
