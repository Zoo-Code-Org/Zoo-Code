import assert from "node:assert/strict"
import test from "node:test"

import type { WebviewThemeFixture } from "@roo-code/types"

import { themeFixtureDefinitions } from "./definitions"
import { createSerializedFixtures, findDriftedFixtures, serializeThemeFixture } from "./fixtures"

test("serializeThemeFixture sorts variables and emits stable metadata", () => {
	const fixture: WebviewThemeFixture = {
		themeId: "Default Dark Modern",
		bodyClass: "vscode-dark",
		variables: {
			"--vscode-z-last": "rgb(2, 2, 2)",
			"--vscode-a-first": "#010101",
		},
	}

	assert.equal(
		serializeThemeFixture(themeFixtureDefinitions[0], fixture, "1.100.0"),
		[
			"/* Generated from Default Dark Modern by VS Code 1.100.0. Do not edit manually. */",
			".vscode-dark {",
			"\tcolor-scheme: dark;",
			"\t--vscode-a-first: #010101;",
			"\t--vscode-z-last: rgb(2, 2, 2);",
			"}",
			"",
		].join("\n"),
	)
})

test("findDriftedFixtures reports missing and changed files in sorted order", () => {
	const expected = new Map([
		["vscode-theme-light.css", "light"],
		["vscode-theme-dark.css", "dark"],
	])
	const actual = new Map<string, string | undefined>([["vscode-theme-light.css", "stale"]])

	assert.deepEqual(findDriftedFixtures(expected, actual), ["vscode-theme-dark.css", "vscode-theme-light.css"])
})

test("createSerializedFixtures rejects incomplete captures", () => {
	const fixture: WebviewThemeFixture = {
		themeId: "Default Dark Modern",
		bodyClass: "vscode-dark",
		variables: {
			"--vscode-foreground": "#cccccc",
			"--vscode-editor-background": "#1f1f1f",
		},
	}

	assert.throws(
		() => createSerializedFixtures(new Map([["dark", fixture]]), "1.100.0", [themeFixtureDefinitions[0]]),
		/--vscode-button-foreground/,
	)
})
