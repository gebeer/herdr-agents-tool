import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
const inheritedProfile = mkdtempSync(join(tmpdir(), "herdr-nondefault-profile-"));
const session = `herdr-agents-tool-${randomUUID().slice(0, 8)}`;
const name = `check_${randomUUID().slice(0, 8)}`;
const socketPath = join(process.env.HOME ?? "/tmp", ".config", "herdr", "sessions", session, "herdr.sock");
let createdPane: string | undefined;
let childSessionFile: string | undefined;
let parentSessionFile: string | undefined;
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
	const serverEnv: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: inheritedProfile };
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
	const previousPane = process.env.HERDR_PANE_ID;
	process.env.HERDR_SOCKET_PATH = socketPath;
	const parentLocation = record(herdr(["workspace", "create", "--cwd", cwd, "--no-focus", "--env", `PI_CODING_AGENT_DIR=${agentDir}`]).result);
	const parentPane = String(record(parentLocation.root_pane).pane_id);
	const parent = record(herdr(["agent", "start", `${name}_parent`, "--kind", "pi", "--pane", parentPane,
		"--", "--name", `${name}_parent`, "--model", "openai-codex/gpt-5.6-sol", "--thinking", "minimal",
		"--append-system-prompt", "You are a test report receiver. Do not use tools or memory. Reply exactly ACK to reports.",
	]).result);
	parentSessionFile = childSessionReference(parent.agent);
	process.env.HERDR_PANE_ID = parentPane;
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
		assert.deepEqual(details.herdr.argv.slice(0, 7), ["pi", "--name", name, "--model", details.model, "--thinking", details.thinking]);
		assert.equal(details.herdr.argv[details.herdr.argv.indexOf("--herdr-parent-pane") + 1], parentPane);
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
		assert.ok(childSessionFile.startsWith(`${join(agentDir, "sessions")}${sep}`), "child must use the default profile, not the server's inherited profile");
		assert.equal(agent.cwd, cwd, "profile pinning must preserve the requested working directory");
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
		assert.ok(parentSessionFile);
		for (const expected of ["OK", "FOLLOW_UP_OK"]) {
			if (expected === "FOLLOW_UP_OK") {
				const prompted = record(herdr(["agent", "prompt", details.pane,
					"Do not use tools or memory. Reply exactly FOLLOW_UP_OK", "--wait", "--timeout", "30000",
				]).result);
				assert.equal(prompted.type, "agent_prompted");
				const sameChild = record(prompted.agent);
				assert.equal(sameChild.name, name);
				assert.equal(sameChild.pane_id, details.pane);
				assert.equal(childSessionReference(sameChild), childSessionFile, "follow-up must reuse the child session");
			}
			const header = `[Subagent report ${JSON.stringify({ name, pane: details.pane })}; stop]`;
			let report = "";
			for (let attempt = 0; attempt < 40 && !report; attempt++) {
				const parentEntries = await readChildSession(parentSessionFile);
				for (const entry of parentEntries) {
					const message = entry.type === "message" ? record(entry.message) : undefined;
					if (message?.role !== "user" || !Array.isArray(message.content)) continue;
					const text = message.content.filter((part) => record(part).type === "text").map((part) => record(part).text).join("");
					if (text.includes(`${header}\n${expected}\n\nFollow-up:`)) report = text;
				}
				if (!report) await new Promise((resolve) => setTimeout(resolve, 250));
			}
			assert.ok(report, `parent must receive the ${expected} report from the same child`);
			assert.ok(report.includes(`herdr agent prompt ${details.pane} "<task>"`));
			console.log("parent received automatic report:", report.trim());
		}
		const closed = herdr(["pane", "close", details.pane]);
		assert.equal(record(closed.result).type, "ok");
		createdPane = undefined;
		console.log("disposable Herdr integration passed: Pi resource-loaded tool, effective model/thinking, initial report, and follow-up report from the same child session");
	} finally {
		sdkSession?.dispose();
		if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = previousPane;
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
			if (parentSessionFile) removeChildSessionArtifact(parentSessionFile);
			control(["session", "delete", "--json", session], "disposable Herdr session delete");
		} catch (error) {
			cleanupErrors.push(error instanceof Error ? error.message : "disposable Herdr session delete failed");
		}
	}
	if (stopped) rmSync(inheritedProfile, { recursive: true, force: true });
	if (cleanupErrors.length > 0) {
		const message = `disposable integration cleanup incomplete for ${session}: ${cleanupErrors.join("; ")}`;
		if (primaryError) console.error(message);
		else throw new Error(message);
	}
}
