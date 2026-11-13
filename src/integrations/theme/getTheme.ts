import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import { convertTheme } from "monaco-vscode-textmate-theme-converter/lib/cjs"
import type { IVSCodeTheme } from "monaco-vscode-textmate-theme-converter/lib/cjs"

import { Package } from "../../shared/package"

const defaultThemes: Record<string, string> = {
	"Default Dark Modern": "dark_modern",
	"Dark+": "dark_plus",
	"Default Dark+": "dark_plus",
	"Dark (Visual Studio)": "dark_vs",
	"Visual Studio Dark": "dark_vs",
	"Dark High Contrast": "hc_black",
	"Default High Contrast": "hc_black",
	"Light High Contrast": "hc_light",
	"Default High Contrast Light": "hc_light",
	"Default Light Modern": "light_modern",
	"Light+": "light_plus",
	"Default Light+": "light_plus",
	"Light (Visual Studio)": "light_vs",
	"Visual Studio Light": "light_vs",
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type JsonObject = { [key: string]: JsonValue }

// Theme JSON is free-form VS Code theme data; model the members this module reads.
type ParsedTheme = JsonObject & { include?: string }

function parseThemeString(themeString: string | undefined): ParsedTheme {
	themeString = themeString
		?.split("\n")
		.filter((line) => {
			return !line.trim().startsWith("//")
		})
		.join("\n")
	return JSON.parse(themeString ?? "{}") as ParsedTheme
}

export async function getTheme() {
	let currentTheme = undefined
	const colorTheme = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme") || "Default Dark Modern"

	try {
		for (let i = vscode.extensions.all.length - 1; i >= 0; i--) {
			if (currentTheme) {
				break
			}
			const extension = vscode.extensions.all[i]
			if (extension.packageJSON?.contributes?.themes?.length > 0) {
				for (const theme of extension.packageJSON.contributes.themes) {
					if (theme.label === colorTheme) {
						const themePath = path.join(extension.extensionPath, theme.path)
						currentTheme = await fs.readFile(themePath, "utf-8")
						break
					}
				}
			}
		}

		if (currentTheme === undefined && defaultThemes[colorTheme]) {
			const filename = `${defaultThemes[colorTheme]}.json`
			currentTheme = await fs.readFile(
				path.join(getExtensionUri().fsPath, "integrations", "theme", "default-themes", filename),
				"utf-8",
			)
		}

		// Strip comments from theme
		let parsed = parseThemeString(currentTheme)

		if (parsed.include) {
			const includeThemeString = await fs.readFile(
				path.join(getExtensionUri().fsPath, "integrations", "theme", "default-themes", parsed.include),
				"utf-8",
			)
			const includeTheme = parseThemeString(includeThemeString)
			parsed = mergeJson(parsed, includeTheme) as ParsedTheme
		}

		// The converter validates and normalizes free-form theme JSON at runtime.
		const converted = convertTheme(parsed as unknown as IVSCodeTheme)

		converted.base = ["vs", "hc-black"].includes(converted.base)
			? converted.base
			: colorTheme.includes("Light")
				? "vs"
				: "vs-dark"

		return converted
	} catch (e) {
		console.log("Error loading color theme: ", e)
	}
	return undefined
}

export function mergeJson(
	first: JsonObject,
	second: JsonObject,
	mergeBehavior?: "merge" | "overwrite",
	mergeKeys?: { [key: string]: (a: JsonValue, b: JsonValue) => boolean },
): JsonObject {
	// JSON round-trip is the deep clone of free-form theme JSON.
	const copyOfFirst = JSON.parse(JSON.stringify(first)) as JsonObject

	try {
		for (const key in second) {
			const secondValue = second[key]

			if (!(key in copyOfFirst) || mergeBehavior === "overwrite") {
				// New value
				copyOfFirst[key] = secondValue
				continue
			}

			const firstValue = copyOfFirst[key]
			if (Array.isArray(secondValue) && Array.isArray(firstValue)) {
				// Array
				if (mergeKeys?.[key]) {
					// Merge keys are used to determine whether an item form the second object should override one from the first
					const keptFromFirst: JsonValue[] = []
					firstValue.forEach((item) => {
						if (!secondValue.some((item2) => mergeKeys[key](item, item2))) {
							keptFromFirst.push(item)
						}
					})
					copyOfFirst[key] = [...keptFromFirst, ...secondValue]
				} else {
					copyOfFirst[key] = [...firstValue, ...secondValue]
				}
			} else if (typeof secondValue === "object" && typeof firstValue === "object") {
				// typeof also admits null and arrays; merge failures fall back in the catch below.
				copyOfFirst[key] = mergeJson(firstValue as JsonObject, secondValue as JsonObject, mergeBehavior)
			} else {
				// Other (boolean, number, string)
				copyOfFirst[key] = secondValue
			}
		}
		return copyOfFirst
	} catch (e) {
		console.error("Error merging JSON", e, copyOfFirst, second)
		return {
			...copyOfFirst,
			...second,
		}
	}
}

function getExtensionUri(): vscode.Uri {
	return vscode.extensions.getExtension(`${Package.publisher}.${Package.name}`)!.extensionUri
}
