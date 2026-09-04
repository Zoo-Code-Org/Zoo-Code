import assert from "node:assert/strict"
import test from "node:test"

import type { WebviewThemeFixture } from "@roo-code/types"

import { themeFixtureDefinitions } from "./definitions"
import { createSerializedFixtures, findDriftedFixtures, serializeThemeFixture } from "./fixtures"

const validVariables = Object.fromEntries(
	Array.from({ length: 100 }, (_, index) => [`--vscode-test-${index}`, "#000000"]),
)
const validFixture: WebviewThemeFixture = {
	themeId: "Default Dark Modern",
	bodyClass: "vscode-dark",
	variables: {
		...validVariables,
		"--vscode-foreground": "#cccccc",
		"--vscode-editor-background": "#1f1f1f",
		"--vscode-button-foreground": "#ffffff",
	},
}

void test("serializeThemeFixture sorts variables and emits stable metadata", () => {
	const fixture: WebviewThemeFixture = {
		themeId: "Default Dark Modern",
		bodyClass: "vscode-dark",
		variables: {
			"--vscode-z-last": "rgb(2, 2, 2)",
			"--vscode-a-first": "#010101",
			"--vscode-font-family": "platform-dependent",
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

void test("findDriftedFixtures reports missing and changed files in sorted order", () => {
	const expected = new Map([
		["vscode-theme-light.css", "light"],
		["vscode-theme-dark.css", "dark"],
	])
	const actual = new Map<string, string | undefined>([["vscode-theme-light.css", "stale"]])

	assert.deepEqual(findDriftedFixtures(expected, actual), ["vscode-theme-dark.css", "vscode-theme-light.css"])
})

void test("createSerializedFixtures rejects incomplete captures", () => {
	const fixture: WebviewThemeFixture = {
		...validFixture,
		variables: {
			...validVariables,
			"--vscode-foreground": "#cccccc",
			"--vscode-editor-background": "#1f1f1f",
		},
	}

	assert.throws(
		() => createSerializedFixtures(new Map([["dark", fixture]]), "1.100.0", [themeFixtureDefinitions[0]]),
		/--vscode-button-foreground/,
	)
})

void test("createSerializedFixtures rejects an empty capture", () => {
	assert.throws(
		() =>
			createSerializedFixtures(new Map([["dark", { ...validFixture, variables: {} }]]), "1.100.0", [
				themeFixtureDefinitions[0],
			]),
		/fewer than 100/,
	)
})

void test("createSerializedFixtures rejects the wrong theme identity", () => {
	assert.throws(
		() =>
			createSerializedFixtures(
				new Map([["dark", { ...validFixture, themeId: "Default Light Modern" }]]),
				"1.100.0",
				[themeFixtureDefinitions[0]],
			),
		/Expected Default Dark Modern/,
	)
})
