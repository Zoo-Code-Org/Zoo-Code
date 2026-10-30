import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Linter } from "eslint"
import typescriptEslint from "typescript-eslint"

import { apiProviderHygieneConfig, apiProviderTestSelectors, apiSpecTsIgnoreConfig } from "./api-provider-hygiene.js"

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

describe("api provider hygiene: request timeout forwarding", () => {
	for (const code of [
		"create(body, { timeout: options.timeoutMs })",
		"create(body, { timeout: options?.timeoutMs })",
		"create(body, { signal, timeout: timeoutMs })",
		"requestOptions.timeout = options.timeoutMs",
		"requestOptions.timeout = timeoutMs",
	]) {
		it(`flags: ${code}`, () => {
			assert.equal(lint(code).length, 1)
		})
	}

	for (const code of [
		"new OpenAI({ timeout: this.timeoutMs })",
		"requestOptions.timeout = toSdkTimeoutMs(timeoutMs)",
		"create(body, { timeout: toSdkTimeoutMs(options.timeoutMs) })",
		"if (hasUsableTimeout(timeoutMs)) requestOptions.timeout = toSdkTimeoutMs(timeoutMs)",
		"const timeoutMs = options?.timeoutMs",
		"mergeAbortSignalAndTimeout(signal, options?.timeoutMs)",
	]) {
		it(`allows: ${code}`, () => {
			assert.deepEqual(lint(code), [])
		})
	}
})

describe("api provider hygiene: timeout helpers", () => {
	for (const code of [
		"const MAX = 2147483647",
		"Math.min(Math.ceil(timeoutMs), 2_147_483_647)",
		"function hasUsableTimeout(t?: number) { return true }",
		"const toSdkTimeoutMs = (t: number) => t",
		"function bridgeExternalAbortSignal() {}",
	]) {
		it(`flags: ${code}`, () => {
			assert.equal(lint(code).length, 1)
		})
	}

	it("allows importing the timeout helpers", () => {
		assert.deepEqual(
			lint('import { hasUsableTimeout, toSdkTimeoutMs } from "./utils/abort-signal"\ntoSdkTimeoutMs(1)'),
			[],
		)
	})

	it("allows the literal in the helper module", () => {
		assert.deepEqual(lint("export const MAX_TIMEOUT_MS = 2_147_483_647", "api/providers/utils/abort-signal.ts"), [])
	})
})

describe("api provider hygiene: spec loops", () => {
	const testLinter = new Linter({ configType: "flat" })
	const testConfig = [
		{ files: ["**/*.ts"], languageOptions: { parser: typescriptEslint.parser } },
		{
			files: ["api/**/__tests__/**/*.spec.ts"],
			rules: { "no-restricted-syntax": ["error", ...apiProviderTestSelectors] },
		},
	]
	const lintSpec = (code) =>
		testLinter
			.verify(code, testConfig, { filename: "api/providers/__tests__/example.spec.ts" })
			.map((m) => m.message)

	for (const code of [
		"it('x', () => { for (const v of [0, -5]) { expect(f(v)).toBe(1) } })",
		"it('x', async () => { for (const v of [0, -5]) { await run(v); expect(f(v)).toBe(1) } })",
	]) {
		it(`flags a loop of expects over a literal array: ${code}`, () => {
			assert.equal(lintSpec(code).length, 1)
		})
	}

	for (const code of [
		"it.each([0, -5])('x %s', (v) => { expect(f(v)).toBe(1) })",
		"it('x', () => { for (const v of [0, -5]) { run(v) } })",
		"it('x', () => { for (const v of cases) { expect(f(v)).toBe(1) } })",
	]) {
		it(`allows: ${code}`, () => {
			assert.deepEqual(lintSpec(code), [])
		})
	}
})

describe("api provider hygiene: hand-built AbortError", () => {
	for (const code of [
		'const e = new Error("x"); e.name = "AbortError"',
		'throw new DOMException("aborted", "AbortError")',
		'Object.assign(new Error("x"), {}).name = "AbortError"',
	]) {
		it(`flags: ${code}`, () => {
			assert.equal(lint(code).length, 1)
		})
	}

	for (const code of [
		'import { createAbortError } from "./utils/abort-signal"\nthrow createAbortError("X")',
		'if (error.name === "AbortError") {}',
		'const e = new Error("x"); e.name = "TimeoutError"',
		'new DOMException("timed out", "TimeoutError")',
	]) {
		it(`allows: ${code}`, () => {
			assert.deepEqual(lint(code), [])
		})
	}

	it("does not apply to the helper module", () => {
		assert.deepEqual(
			lint('const e = new Error("x"); e.name = "AbortError"', "api/providers/utils/abort-signal.ts"),
			[],
		)
	})

	it("does not apply to tests", () => {
		assert.deepEqual(lint('new DOMException("x", "AbortError")', "api/providers/__tests__/a.spec.ts"), [])
	})
})

describe("api provider hygiene: @ts-ignore in specs", () => {
	const specLinter = new Linter({ configType: "flat" })
	const specConfig = [
		{
			files: ["**/*.ts"],
			languageOptions: { parser: typescriptEslint.parser },
			plugins: { "@typescript-eslint": typescriptEslint.plugin },
		},
		apiSpecTsIgnoreConfig,
	]
	const lintSpecFile = (code, filename = "api/providers/__tests__/example.spec.ts") =>
		specLinter.verify(code, specConfig, { filename }).map((m) => m.message)

	it("flags @ts-ignore in a spec", () => {
		assert.equal(lintSpecFile("// @ts-ignore access private client\nhandler.client").length, 1)
	})

	it("allows @ts-expect-error with a description", () => {
		assert.deepEqual(lintSpecFile("// @ts-expect-error private client\nhandler.client"), [])
	})

	it("allows bracket notation", () => {
		assert.deepEqual(lintSpecFile('handler["client"]'), [])
	})

	it("skips files in the ratchet list", () => {
		assert.deepEqual(
			lintSpecFile("// @ts-ignore x\nhandler.client", "api/providers/__tests__/gemini-handler.spec.ts"),
			[],
		)
	})

	it("does not apply outside src/api", () => {
		assert.deepEqual(lintSpecFile("// @ts-ignore x\nhandler.client", "services/__tests__/example.spec.ts"), [])
	})
})
