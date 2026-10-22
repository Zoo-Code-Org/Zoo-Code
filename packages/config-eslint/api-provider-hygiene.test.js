import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Linter } from "eslint"
import typescriptEslint from "typescript-eslint"

import { apiProviderHygieneConfig } from "./api-provider-hygiene.js"

const linter = new Linter({ configType: "flat" })
const config = [{ files: ["**/*.ts"], languageOptions: { parser: typescriptEslint.parser } }, apiProviderHygieneConfig]

const lint = (code, filename = "api/providers/example.ts") =>
	linter.verify(code, config, { filename }).map((message) => message.message)

describe("api provider hygiene: shared abort helpers", () => {
	for (const code of [
		"function createAbortError(name: string) { return new Error(name) }",
		"const rejectOnAbort = () => {}",
		"async function resolveModelWithAbort() {}",
	]) {
		it(`flags a local copy: ${code}`, () => {
			assert.equal(lint(code).length, 1)
		})
	}

	it("allows importing the helper", () => {
		assert.deepEqual(lint('import { createAbortError } from "./utils/abort-signal"\ncreateAbortError("x")'), [])
	})

	it("does not apply to the helper module", () => {
		assert.deepEqual(lint("export function createAbortError() {}", "api/providers/utils/abort-signal.ts"), [])
	})

	it("does not apply to tests", () => {
		assert.deepEqual(lint("function createAbortError() {}", "api/providers/__tests__/example.spec.ts"), [])
	})

	it("does not apply outside src/api", () => {
		assert.deepEqual(lint("function createAbortError() {}", "services/example.ts"), [])
	})
})

describe("api provider hygiene: AbortSignal.timeout", () => {
	for (const code of [
		"AbortSignal.timeout(timeoutMs)",
		"AbortSignal.timeout(options.timeoutMs)",
		"AbortSignal.timeout(seconds * 1000)",
	]) {
		it(`flags a variable delay: ${code}`, () => {
			assert.equal(lint(code).length, 1)
		})
	}

	for (const code of [
		"AbortSignal.timeout(10_000)",
		"AbortSignal.timeout(MODEL_CATALOG_FETCH_TIMEOUT_MS)",
		"AbortSignal.any([a, b])",
	]) {
		it(`allows: ${code}`, () => {
			assert.deepEqual(lint(code), [])
		})
	}
})

describe("api provider hygiene: sensitive values in logs", () => {
	for (const code of [
		"console.warn(`Error connecting at ${baseUrl}`)",
		"console.warn(`Error connecting at ${this.options.ollamaBaseUrl}`)",
		"console.error(`refresh failed for ${this._serverUrl}`)",
		"console.log(`key ${apiKey}`)",
		"console.log(`auth ${accessToken}`)",
		"console.log(`from ${url}`)",
	]) {
		it(`flags: ${code}`, () => {
			assert.equal(lint(code).length, 1)
		})
	}

	for (const code of [
		"console.error(`Error writing ${cacheKey} to disk`)",
		"console.warn(`Current tokens: ${contextTokens}`)",
		"console.warn(`Endpoint ${endpointOrigin} is not secure`)",
		"const message = `at ${baseUrl}`",
		'console.warn("static message")',
	]) {
		it(`allows: ${code}`, () => {
			assert.deepEqual(lint(code), [])
		})
	}
})
