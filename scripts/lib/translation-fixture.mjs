// Test helper for the translation scripts: runs a real script against a throwaway repository layout.

import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// The scripts resolve the locale directories relative to themselves, so a copy sees only these files.
// `files` maps a path relative to the repository root to JSON content, or to raw text.
export function runScript(script, files, args) {
	const root = mkdtempSync(path.join(tmpdir(), "zoo-translations-check-"))
	try {
		cpSync(path.join(scriptsDir, script), path.join(root, "scripts", script))
		cpSync(path.join(scriptsDir, "lib"), path.join(root, "scripts", "lib"), { recursive: true })
		for (const [file, content] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
			writeFileSync(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content))
		}
		const result = spawnSync(process.execPath, [path.join("scripts", script), ...args], {
			cwd: root,
			encoding: "utf8",
		})
		return { status: result.status, output: result.stdout + result.stderr }
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

// { ru: { "common.json": {...} } } -> files under src/i18n/locales (core) or webview-ui/src/i18n/locales
export function locales(area, byLocale) {
	const dir = area === "core" ? "src/i18n/locales" : "webview-ui/src/i18n/locales"
	return Object.fromEntries(
		Object.entries(byLocale).flatMap(([locale, files]) =>
			Object.entries(files).map(([file, content]) => [`${dir}/${locale}/${file}`, content]),
		),
	)
}

// { ru: {...} } -> one common.json per locale under src/i18n/locales
export function commonFiles(byLocale) {
	return locales(
		"core",
		Object.fromEntries(Object.entries(byLocale).map(([locale, content]) => [locale, { "common.json": content }])),
	)
}

// Plural fixtures shared by both test files
export const en = { files_one: "{{count}} file", files_other: "{{count}} files" }
export const ru = {
	files_one: "{{count}} файл",
	files_few: "{{count}} файла",
	files_many: "{{count}} файлов",
	files_other: "{{count}} файла",
}
export const ja = { files_other: "{{count}} ファイル" }

// nest("chat.time_ago", {...}) -> { chat: { time_ago: {...} } }, like the real locale files
export function nest(dottedPath, content) {
	return dottedPath.split(".").reduceRight((inner, key) => ({ [key]: inner }), content)
}
