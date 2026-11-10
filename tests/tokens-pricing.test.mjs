// tokens.mjs prices: every bare alias lands on a priced model, and each
// model's five rates match the published list (USD per MTok), cache reads
// included: Fable 5.1 / 5.2, Opus 5.5 and Sonnet 5.5 read below 0.1× input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRICING, normModel, rowCost } from "../scripts/tokens.mjs";

const M = 1e6;
const row = (model, f = {}) => ({ model, input: 0, cw5m: 0, cw1h: 0, cacheRead: 0, output: 0, ...f });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} != ${b}`);

// [input, output, 5m write, 1h write, cache read], written out by hand from
// platform.claude.com's pricing page on 2026-11-10, not derived from PRICING.
const LIST = {
  "claude-fable-5-2": [8, 40, 10, 16, 0.2],
  "claude-fable-5-1": [10, 50, 12.5, 20, 0.25],
  "claude-fable-5": [10, 50, 12.5, 20, 1],
  "claude-opus-5-5": [4, 20, 5, 8, 0.2],
  "claude-opus-5": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-8": [5, 25, 6.25, 10, 0.5],
  "claude-opus-4-7": [5, 25, 6.25, 10, 0.5],
  "claude-sonnet-5-5": [2, 10, 2.5, 4, 0.1],
  "claude-sonnet-5": [2, 10, 2.5, 4, 0.2],
  "claude-sonnet-4-6": [3, 15, 3.75, 6, 0.3],
  "claude-haiku-5-5": [0.1, 0.5, 0.125, 0.2, 0.01],
  "claude-haiku-4-5": [1, 5, 1.25, 2, 0.1],
};
const FIELDS = ["input", "output", "cw5m", "cw1h", "cacheRead"];

test("every priced model has a list row, and every list row is priced", () => {
  assert.deepEqual(Object.keys(PRICING).sort(), Object.keys(LIST).sort());
});

test("each model's five rates match the list", () => {
  for (const [id, rates] of Object.entries(LIST)) {
    FIELDS.forEach((f, i) => near(rowCost(row(id, { [f]: M })), rates[i], `${id} ${f}`));
  }
});

test("a bare alias names the newest model of its line", () => {
  for (const [alias, id] of [
    ["fable", "claude-fable-5-2"],
    ["opus", "claude-opus-5-5"],
    ["sonnet", "claude-sonnet-5-5"],
    ["haiku", "claude-haiku-5-5"],
  ]) {
    assert.equal(normModel(alias), id);
    near(rowCost(row(alias, { output: M })), LIST[id][1], `${alias} prices as ${id}`);
  }
});

test("variant ids normalize: a [1m] suffix and a date suffix", () => {
  assert.equal(normModel("claude-fable-5-2[1m]"), "claude-fable-5-2");
  assert.equal(normModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
});

test("an unknown model prices at 0", () => {
  assert.equal(rowCost(row("claude-unknown-9", { input: M, output: M })), 0);
});
