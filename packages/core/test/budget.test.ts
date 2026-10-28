import { test } from "node:test";
import assert from "node:assert/strict";
import { ZERO, add, sub, fits, exhausted, remaining, isValidBudget } from "../src/budget.ts";
import type { Budget } from "../src/manifest.ts";

const b = (tokens: number, costUsd: number, wallClockSec: number): Budget => ({ tokens, costUsd, wallClockSec });

test("add / sub are per-dimension", () => {
	assert.deepEqual(add(b(1, 2, 3), b(4, 5, 6)), b(5, 7, 9));
	assert.deepEqual(sub(b(5, 7, 9), b(4, 5, 6)), b(1, 2, 3));
	assert.deepEqual(add(ZERO, b(1, 1, 1)), b(1, 1, 1));
});

test("fits is a ≤ b on every dimension", () => {
	assert.equal(fits(b(1, 1, 1), b(1, 1, 1)), true);
	assert.equal(fits(b(2, 1, 1), b(1, 1, 1)), false);
	assert.equal(fits(b(0, 0, 0), b(1, 1, 1)), true);
});

test("exhausted lists dimensions at or over the limit", () => {
	assert.deepEqual(exhausted(b(1, 0, 0), b(1, 1, 1)), ["tokens"]);
	assert.deepEqual(exhausted(b(0, 0, 0), b(1, 1, 1)), []);
	assert.deepEqual(exhausted(b(2, 2, 2), b(1, 1, 1)), ["tokens", "costUsd", "wallClockSec"]);
});

test("remaining floors at zero after subtracting used and reserved", () => {
	assert.deepEqual(remaining(b(10, 10, 10), b(3, 0, 0), b(2, 0, 0)), b(5, 10, 10));
	assert.deepEqual(remaining(b(10, 10, 10), b(8, 0, 0), b(5, 0, 0)), b(0, 10, 10));
});

test("isValidBudget rejects negative and non-finite dimensions", () => {
	assert.equal(isValidBudget(b(1, 1, 1)), true);
	assert.equal(isValidBudget(ZERO), true);
	assert.equal(isValidBudget(b(-1, 0, 0)), false);
	assert.equal(isValidBudget(b(0, Number.NaN, 0)), false);
	assert.equal(isValidBudget(b(0, 0, Infinity)), false);
});

test("zero limit: zero usage is not exhausted, positive usage is (wnk.11)", () => {
	assert.deepEqual(exhausted(b(0, 0, 0), b(0, 0, 0)), []);
	assert.deepEqual(exhausted(b(0, 0.5, 0), b(0, 0, 0)), ["costUsd"]);
	assert.deepEqual(exhausted(b(1, 0, 0), b(1, 0, 0)), ["tokens"]);
});
