import { describe, expect, it } from "vitest"

import { areValuesEqual } from "../areValuesEqual"

describe("areValuesEqual", () => {
	it.each<[string, unknown, unknown, boolean]>([
		["the same string", "a", "a", true],
		["the same number", 1, 1, true],
		["null and undefined", null, undefined, true],
		["undefined and null", undefined, null, true],
		["objects with equal content", { a: { b: [1] } }, { a: { b: [1] } }, true],
		["an undefined property and a missing property", { a: 1, b: undefined }, { a: 1 }, true],
		["different strings", "a", "b", false],
		["a string and a number", "1", 1, false],
		["undefined and an empty string", undefined, "", false],
		["undefined and false", undefined, false, false],
		["false and null", false, null, false],
		["zero and undefined", 0, undefined, false],
		["null and an object", null, {}, false],
		["objects with different content", { a: 1 }, { a: 2 }, false],
		["arrays with different content", ["a"], ["a", "b"], false],
	])("%s", (_name, a, b, expected) => {
		expect(areValuesEqual(a, b)).toBe(expected)
	})
})
