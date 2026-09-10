import fs from "fs/promises"

import * as vscode from "vscode"

import type { RooCodeTestAPI, WebviewThemeFixture } from "@roo-code/types"

import { themeFixtureDefinitions, type ThemeFixtureDefinition } from "./definitions"

const POLL_INTERVAL_MS = 100
const THEME_TIMEOUT_MS = 20_000

const colorThemeKinds: Record<ThemeFixtureDefinition["kind"], vscode.ColorThemeKind> = {
	dark: vscode.ColorThemeKind.Dark,
	light: vscode.ColorThemeKind.Light,
	"high-contrast": vscode.ColorThemeKind.HighContrast,
	"high-contrast-light": vscode.ColorThemeKind.HighContrastLight,
}

async function poll<T>(capture: () => Promise<T>, matches: (value: T) => boolean, description: string): Promise<T> {
	const deadline = Date.now() + THEME_TIMEOUT_MS
	let latest: T | undefined

	while (Date.now() < deadline) {
		latest = await capture()
		if (matches(latest)) {
			return latest
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
	}

	throw new Error(`Timed out waiting for ${description}; latest value: ${JSON.stringify(latest)}`)
}

function matchesTheme(fixture: WebviewThemeFixture, theme: ThemeFixtureDefinition): boolean {
	return fixture.themeId === theme.themeId && fixture.bodyClass.split(/\s+/).includes(theme.bodyClass)
}

export async function run(): Promise<void> {
	if (process.env.ROO_CODE_THEME_FIXTURE_PROBE !== "1") {
		throw new Error("ROO_CODE_THEME_FIXTURE_PROBE must be set to 1")
	}

	const outputPath = process.env.ROO_CODE_THEME_FIXTURE_CAPTURE_PATH
	const expectedVersion = process.env.ROO_CODE_THEME_FIXTURE_VSCODE_VERSION
	if (!outputPath || !expectedVersion) {
		throw new Error("Theme fixture output path and VS Code version are required")
	}
	if (vscode.version !== expectedVersion) {
		throw new Error(`Expected VS Code ${expectedVersion}, launched ${vscode.version}`)
	}

	const extension = vscode.extensions.getExtension<RooCodeTestAPI>("ZooCodeOrganization.zoo-code")
	if (!extension) {
		throw new Error("Zoo Code extension not found")
	}
	const api = extension.isActive ? extension.exports : await extension.activate()

	await vscode.commands.executeCommand("zoo-code.SidebarProvider.focus")
	await poll(async () => api.isReady(), Boolean, "Zoo Code webview activation")

	const captures: Record<string, WebviewThemeFixture> = {}
	for (const theme of themeFixtureDefinitions) {
		await vscode.workspace
			.getConfiguration("workbench")
			.update("colorTheme", theme.themeId, vscode.ConfigurationTarget.Global)
		await poll(
			async () => vscode.window.activeColorTheme.kind,
			(kind) => kind === colorThemeKinds[theme.kind],
			`${theme.themeId} color theme kind`,
		)
		captures[theme.name] = await poll(
			() => api.captureWebviewThemeFixture(),
			(fixture) => matchesTheme(fixture, theme),
			`${theme.themeId} webview identity`,
		)
	}

	await fs.writeFile(outputPath, `${JSON.stringify(captures, null, 2)}\n`, "utf8")
}
