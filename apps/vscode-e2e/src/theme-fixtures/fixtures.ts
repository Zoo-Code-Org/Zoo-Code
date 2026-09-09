import type { WebviewThemeFixture } from "@roo-code/types"

import { getThemeFixtureFileName, type ThemeFixtureDefinition } from "./definitions"

const requiredVariables = ["--vscode-foreground", "--vscode-editor-background", "--vscode-button-foreground"]
const minimumVariableCount = 100
const environmentVariables = new Set(["--vscode-font-family", "--vscode-editor-font-family"])

export function validateThemeFixture(theme: ThemeFixtureDefinition, fixture: WebviewThemeFixture): void {
	if (fixture.themeId !== theme.themeId) {
		throw new Error(`Expected ${theme.themeId}, captured ${fixture.themeId || "an unknown theme"}`)
	}
	if (!fixture.bodyClass.split(/\s+/).includes(theme.bodyClass)) {
		throw new Error(`Expected ${theme.bodyClass}, captured body classes: ${fixture.bodyClass || "none"}`)
	}
	if (Object.keys(fixture.variables).length < minimumVariableCount) {
		throw new Error(`${theme.themeId} exposed fewer than ${minimumVariableCount} VS Code theme variables`)
	}
	for (const property of requiredVariables) {
		if (!fixture.variables[property]) {
			throw new Error(`${theme.themeId} did not expose required variable ${property}`)
		}
	}
	for (const [property, value] of Object.entries(fixture.variables)) {
		if (!property.startsWith("--vscode-") || !value) {
			throw new Error(`${theme.themeId} exposed an invalid theme variable: ${property}`)
		}
	}
}

export function serializeThemeFixture(
	theme: ThemeFixtureDefinition,
	fixture: WebviewThemeFixture,
	vscodeVersion: string,
): string {
	const declarations = Object.entries(fixture.variables)
		.filter(([property]) => !environmentVariables.has(property))
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([property, value]) => `\t${property}: ${value};`)

	return [
		`/* Generated from ${theme.themeId} by VS Code ${vscodeVersion}. Do not edit manually. */`,
		`.${theme.bodyClass} {`,
		`\tcolor-scheme: ${theme.colorScheme};`,
		...declarations,
		"}",
		"",
	].join("\n")
}

export function createSerializedFixtures(
	captures: ReadonlyMap<string, WebviewThemeFixture>,
	vscodeVersion: string,
	themes: readonly ThemeFixtureDefinition[],
): Map<string, string> {
	return new Map(
		themes.map((theme) => {
			const capture = captures.get(theme.name)
			if (!capture) {
				throw new Error(`Missing captured theme fixture: ${theme.name}`)
			}
			validateThemeFixture(theme, capture)

			return [getThemeFixtureFileName(theme), serializeThemeFixture(theme, capture, vscodeVersion)]
		}),
	)
}

export function findDriftedFixtures(
	expected: ReadonlyMap<string, string>,
	actual: ReadonlyMap<string, string | undefined>,
): string[] {
	return [...expected.entries()]
		.filter(([fileName, contents]) => actual.get(fileName) !== contents)
		.map(([fileName]) => fileName)
		.sort()
}
