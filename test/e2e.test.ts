/**
 * End to end, with nothing faked: a private herdr-core, real `pi` and `claude` agents, real
 * model calls. Needs hc, pi and claude on PATH, credentials for the models, and this folder
 * trusted by Claude Code. Your own herdr-core and its terminals are not touched: the test core
 * is the hc session `hat-e2e`, with its state in ~/.local/state/herdr-core/hat-e2e.
 *
 *   npm run test:e2e
 *   E2E_PI_MODEL="deepseek flash" E2E_CLAUDE_MODEL=haiku npm run test:e2e
 *
 * A run that is killed leaves its core behind: HC_SESSION=hat-e2e hc server stop
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Host, matchPiModel, messageAgent, piModelsFrom, startAgent } from "../core.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
/**
 * A herdr-core of its own. No scratch XDG paths: terminals inherit the core's environment, and
 * Claude Code re-links ~/.local/bin/claude into whatever XDG_DATA_HOME it is run with.
 */
const env: NodeJS.ProcessEnv = {
	...process.env,
	HC_SESSION: "hat-e2e",
	// `npm run` puts node_modules/.bin first, which would start this repo's dev copy of pi, not the installed one.
	PATH: process.env.PATH!.split(delimiter).filter((dir) => !dir.endsWith(join("node_modules", ".bin"))).join(delimiter),
};
for (const inherited of ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE"]) delete env[inherited];

const piModels = piModelsFrom(readSettings());
/** Words or an exact id; unset: Pi's own default model. */
const PI_MODEL = process.env.E2E_PI_MODEL;
const CLAUDE_MODEL = process.env.E2E_CLAUDE_MODEL ?? "haiku";
const TIMEOUT = { timeout: 300_000 };

function readSettings(): string | undefined {
	try {
		return readFileSync(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json"), "utf8");
	} catch {
		return undefined;
	}
}

function hc(command: string, ...args: string[]): Record<string, any> {
	return JSON.parse(execFileSync("hc", [command, "--json", ...args], { env, encoding: "utf8" }));
}

function screen(terminal: string): string {
	return execFileSync("hc", ["read", terminal, "--lines", "0"], { env, encoding: "utf8" });
}

/** Waits for `check` to hold; on timeout, fails with every terminal's screen. */
async function until(what: string, check: () => boolean, seconds = 150): Promise<void> {
	for (let waited = 0; waited < seconds; waited++) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	const screens = hc("ls").terminals.map((t: Record<string, string>) => `--- ${t.address} ${t.name ?? ""} (${t.agent}, ${t.status ?? "no status"})\n${screen(t.address).trim().slice(-1500)}`);
	assert.fail(`timed out waiting for ${what}\n${screens.join("\n")}`);
}

/** A terminal that plays the starting agent: it reports idle like one and shows what is typed into it. */
function standIn(name: string): string {
	return hc("run", "--bg", "--name", name, "--", "sh", "-c", "printf '\\033]7501;state=idle\\033\\\\'; exec cat").address;
}

/** The host a tool call would build inside terminal `me`. */
function host(me: string): Host {
	return {
		me,
		cwd: root,
		root,
		piModels,
		run: (argv, timeout) => new Promise((resolve, reject) => {
			execFile(argv[0]!, argv.slice(1), { env: { ...env, HC_TERMINAL_ID: me }, timeout }, (error, stdout, stderr) => {
				if (error && typeof error.code !== "number") reject(error);
				else resolve({ exitCode: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
			});
		}),
	};
}

function addressIn(result: string): string {
	return /^Started \S+ as (\S+) /.exec(result)![1]!;
}

/** What a real session is told so that it uses its start tool, then proves the report reached it. */
function toolTask(tool: string, child: string): string {
	return `Tool test, follow exactly. Call the ${tool} tool once with ${child}, thinking 'low', place 'hidden' and prompt 'Reply with exactly: OK'. Then end your turn. When a message in <hc> tags arrives later, reply with the single word: received. Use no other tool.`;
}

/** The session started `child` with its tool, then ran a second turn: the one the child's report started. */
async function startedAndHeardBack(session: string, child: string): Promise<void> {
	await until(`${child} to be started by ${session}`, () => hc("ls").terminals.some((t: Record<string, string>) => t.name === child && t.parent === session));
	await until(`${session} to answer ${child}'s report`, () => {
		const now = hc("get", session);
		return now.turn >= 2 && now.status?.state !== "working";
	});
}

before(() => {
	hc("server", "start");
});

after(() => {
	for (const terminal of hc("ls").terminals) {
		// A terminal that already ended cannot be killed, and one still ending cannot be removed.
		for (const command of ["kill", "rm"]) try { hc(command, terminal.address); } catch {}
	}
	hc("server", "stop");
});

test("a Pi child placed in a pane reports each answer to its starter", TIMEOUT, async () => {
	const me = standIn("starter-a");
	hc("label", me, "herdr.space=spE2E", "herdr.tab=tbE2E");
	const address = addressIn(await startAgent(host(me), {
		name: "e2e-pi", kind: "pi", model: PI_MODEL, thinking: "low", place: "pane", prompt: "Reply with exactly: E2E-PI-OK",
	}));
	const child = hc("get", address);
	assert.equal(child.parent, me);
	assert.equal(child.labels["herdr.space"], "spE2E");
	assert.equal(child.labels["herdr.tab"], "tbE2E");
	assert.equal(child.die_with_parent, false);
	await until("the first report", () => new RegExp(`<hc from="${address} e2e-pi">[^<]*E2E-PI-OK`).test(screen(me)));
	assert.equal(await messageAgent(host(me).run, { to: address, text: "Reply with exactly: E2E-PI-SECOND" }), `Sent to ${address}.`);
	await until("the report on the follow-up", () => /<hc from="[^"]*">[^<]*E2E-PI-SECOND/.test(screen(me)));
});

test("a hidden Claude child reports to its starter and ends with it", TIMEOUT, async () => {
	const me = standIn("starter-b");
	const address = addressIn(await startAgent(host(me), {
		name: "e2e-claude", kind: "claude", model: CLAUDE_MODEL, thinking: "low", place: "hidden", prompt: "Reply with exactly: E2E-CLAUDE-OK",
	}));
	const child = hc("get", address);
	assert.equal(child.parent, me);
	assert.equal(child.labels["herdr.space"], undefined);
	assert.equal(child.die_with_parent, true);
	await until("the report", () => new RegExp(`<hc from="${address} e2e-claude">[^<]*E2E-CLAUDE-OK`).test(screen(me)));
});

test("a Pi session starts a Claude child with its tool and hears back", TIMEOUT, async () => {
	const model = PI_MODEL ? ["--model", matchPiModel(PI_MODEL, piModels) ?? PI_MODEL] : [];
	const task = toolTask("herdr_start_agent", `name 'kid-of-pi', kind 'claude', model '${CLAUDE_MODEL}'`);
	const session = hc("run", "--bg", "--name", "pi-session", "--cwd", root, "--", "pi", "--extension", join(root, "index.ts"), ...model, "--thinking", "low", task).address;
	await startedAndHeardBack(session, "kid-of-pi");
});

test("a Claude session starts a Pi child with its tool and hears back", TIMEOUT, async () => {
	const child = `name 'kid-of-claude', kind 'pi'${PI_MODEL ? `, model '${PI_MODEL}'` : ""}`;
	const task = toolTask("mcp__herdr-agents__start_agent (load it with ToolSearch first if it is deferred)", child);
	const session = hc("run", "--bg", "--name", "claude-session", "--cwd", root, "--",
		"claude", "--model", CLAUDE_MODEL, "--effort", "low", "--permission-mode", "bypassPermissions", "--plugin-dir", root, task).address;
	await startedAndHeardBack(session, "kid-of-claude");
});
