import assert from "node:assert/strict";
import { test } from "node:test";
import { matchPiModel, piModelsFrom, reportText, resolveAgent } from "../core.ts";

// Pure checks only. Launching, placement and reports are verified against a real herdr-core.
const MODELS = ["openai-codex/gpt-6.1-sol", "openai-codex/gpt-5.6-sol", "openai-codex/gpt-6.1-terra", "opencode-go/deepseek-v4.1-flash"];

test("model words pick the first enabled Pi model that has them all", () => {
	assert.equal(matchPiModel("sol", MODELS), "openai-codex/gpt-6.1-sol");
	assert.equal(matchPiModel("5.6 sol", MODELS), "openai-codex/gpt-5.6-sol");
	assert.equal(matchPiModel("deepseek flash", MODELS), "opencode-go/deepseek-v4.1-flash");
	assert.equal(matchPiModel("opus", MODELS), undefined);
});

test("a provider/model-id is taken as given, never widened to a longer enabled ID", () => {
	assert.equal(matchPiModel("openai/gpt-4.1", ["openai/gpt-4.1-mini"]), undefined);
	assert.deepEqual(resolveAgent({ model: "openai/gpt-4.1" }, ["openai/gpt-4.1-mini"]), { kind: "pi", model: "openai/gpt-4.1" });
});

test("patterns in enabledModels are not offered as models", () => {
	assert.deepEqual(piModelsFrom('{"enabledModels":["openai/*","*sonnet*","sonnet","x/y-1",3]}'), ["x/y-1"]);
	assert.deepEqual(piModelsFrom("not json"), []);
});

test("kind is inferred from the model unless given", () => {
	assert.deepEqual(resolveAgent({ model: "terra" }, MODELS), { kind: "pi", model: "openai-codex/gpt-6.1-terra" });
	assert.deepEqual(resolveAgent({ model: "opus" }, MODELS), { kind: "claude", model: "opus" });
	assert.deepEqual(resolveAgent({ model: "x/y-1" }, MODELS), { kind: "pi", model: "x/y-1" });
	assert.deepEqual(resolveAgent({ kind: "claude", model: "sol" }, MODELS), { kind: "claude", model: "sol" });
	assert.deepEqual(resolveAgent({}, MODELS), { kind: "pi" });
	assert.throws(() => resolveAgent({ model: "nonsense" }, MODELS), /unknown model "nonsense".*gpt-6\.1-sol/);
});

test("a report is the answer, marked when the turn did not end normally", () => {
	assert.equal(reportText("all done", "stop"), "all done");
	assert.equal(reportText("half", "error"), "[The turn ended: error]\nhalf");
	assert.equal(reportText("", "aborted"), "(No answer text. The turn ended: aborted.)");
});
