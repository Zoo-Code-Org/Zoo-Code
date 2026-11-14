import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Linter } from "eslint"
import typescriptEslint from "typescript-eslint"

import { createI18nLiteralStringConfig, i18nLiteralSelectors } from "./i18n-literal-strings.js"

const linter = new Linter({ configType: "flat" })
const languageOptions = { parser: typescriptEslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } }
const config = [
	{ ...createI18nLiteralStringConfig({ files: ["**/*.tsx"] }), languageOptions },
	{ files: ["**/*.tsx"], rules: { "no-restricted-syntax": ["error", ...i18nLiteralSelectors] } },
]

const lint = (code) => linter.verify(code, config, { filename: "example.tsx" }).map((message) => message.message)

describe("i18n literal strings: JSX text", () => {
	for (const code of ["<p>Sign out</p>", "<>Add Todo</>", "<span>{n}ms</span>"]) {
		it(`flags: ${code}`, () => {
			assert.equal(lint(code).length, 1)
		})
	}

	for (const code of [
		'<p>{t("chat:signOut")}</p>',
		"<p>{count} • {total}</p>",
		"<span>⚠️ {error}</span>",
		"<span>✓</span>",
		"<span>v{version}</span>",
		"<span>{seconds}s</span>",
		"<p>&nbsp;</p>",
		'<Trans i18nKey="mcp:description"><a href="#">Learn More</a></Trans>',
		"<li>arn:aws:bedrock:us-west-2:123456789012:provisioned-model/my-model</li>",
		"<div>• https://gateway.my-company.com/route/app/bedrock</div>",
		"<a>openrouter.ai/keys</a>",
	]) {
		it(`allows: ${code}`, () => {
			assert.deepEqual(lint(code), [])
		})
	}
})

describe("i18n literal strings: user-facing attributes and children expressions", () => {
	for (const code of [
		'<img alt="Logo" />',
		'<input placeholder="Search" />',
		'<button aria-label={"Close"} />',
		'<ToggleSwitch ariaLabel="Toggle server" />',
		'<button title={saved ? "Saved" : t("chat:save")} />',
		'<Item label={name || "Unknown"} />',
		"<button aria-label={`Open ${path}`} />",
		'<StandardTooltip content="Copy as markdown"><button /></StandardTooltip>',
		'<input placeholder="Default: https://openrouter.ai/api/v1" />',
		'<p>{t("x") || "Fallback text"}</p>',
		'<code>{item.mimeType || "Unknown"}</code>',
		"<p>{`${count} hidden lines`}</p>",
	]) {
		it(`flags: ${code}`, () => {
			assert.equal(lint(code).length, 1)
		})
	}

	for (const code of [
		'<img alt="" />',
		'<div className="flex gap-2" data-testid="row" />',
		'<a href="https://example.com/docs" />',
		'<Markdown content="# Heading" />',
		'<input placeholder={t("common:ui.search_placeholder")} />',
		'<button title={t(open ? "chat:collapse" : "chat:expand")} />',
		'<button aria-label={mode === "edit" ? t("chat:edit") : t("chat:view")} />',
		'<input placeholder="%" />',
		'<input placeholder="https://api.openai.com/v1" />',
		'<input placeholder="api.moonshot.ai" />',
		'<input placeholder={branch || "worktree/feature-name"} />',
		'<input placeholder={dir || "/path/to/worktree"} />',
		`<textarea placeholder={'{\\n  "metadata": {}\\n}'} />`,
		"<style>{`@keyframes fadeIn { from { opacity: 0; } }`}</style>",
		'<p>{" "}</p>',
	]) {
		it(`allows: ${code}`, () => {
			assert.deepEqual(lint(code), [])
		})
	}
})
