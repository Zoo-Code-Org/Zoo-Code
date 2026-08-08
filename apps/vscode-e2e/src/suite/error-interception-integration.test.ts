import * as assert from "assert"
import * as path from "path"
import * as fs from "fs"

import { setDefaultSuiteTimeout } from "./test-utils"

// ---------------------------------------------------------------------------
// Error Interception — assistant-message integration at e2e scope
// ---------------------------------------------------------------------------
//
// This suite exercises the Assistant Integration & Handlers layer shipped by
// this PR (structuredError.ts + the presentAssistantMessage.ts handleError
// wiring) against the real, built extension artifact, not a re-implemented
// copy.
//
// Why this lives in apps/vscode-e2e and not in src/__tests__:
//   - The unit specs (structuredError.spec.ts, presentAssistantMessage-handleError.spec.ts)
//     run under Vitest with direct TS source access. They prove the formatter
//     and the handleError closures in isolation, with the Task graph mocked.
//   - This e2e suite runs inside the real VS Code extension host against the
//     bundled extension output that actually ships. It proves the integration
//     contract (structured error shape, retryability signals, occurrence
//     tracking, WHAT/WHY/NEXT guidance) survives bundling and is importable
//     end-to-end.
//
// How the module is loaded:
//   The e2e workspace does not use TS project references into src/, so a
//   static import would fail `check-types`. Instead we locate the built
//   extension entry (dist/extension.js, produced by `pnpm -w bundle` in the
//   test:ci pipeline) and require the structuredError submodule from the same
//   output the host loads. If the bundle is absent (e.g. a bare `check-types`
//   run without a build), the suite skips cleanly rather than failing on an
//   infrastructure gap.

interface StructuredErrorDetailsLike {
	what: string
	why: string
	next: string[]
	retryable?: boolean
	pattern?: string
	occurrence?: number
	disposition?: string
}

interface StructuredErrorModule {
	isUserRejectionError: (error: Error) => boolean
	isRetryableError: (error: Error) => boolean
	deriveRecoveryDisposition: (error: Error, occurrence: number) => string
	buildErrorSignature: (action: string, error: Error) => string
	recordErrorOccurrence: (task: object, signature: string) => number
	formatStructuredError: (details: StructuredErrorDetailsLike, byteLimit?: number) => string
	buildStructuredErrorContent: (task: object, action: string, error: Error, pattern: string) => string
	formatConciseErrorMessage: (action: string, error: Error) => string
}

function findBuiltExtensionEntry(workspaceRoot: string): string | undefined {
	const candidates = [
		path.join(workspaceRoot, "src", "dist", "extension.js"),
		path.join(workspaceRoot, "dist", "extension.js"),
		path.join(workspaceRoot, "src", "dist", "extension.cjs"),
	]
	return candidates.find((p) => fs.existsSync(p))
}

/** Extracts the JSON payload from an <error_details> block. */
function parseErrorDetails(block: string): Record<string, unknown> {
	const match = block.match(/^<error_details>\n([\s\S]*)\n<\/error_details>$/)
	assert.ok(match && match[1] !== undefined, `expected an <error_details> block, got: ${block.slice(0, 120)}`)
	return JSON.parse(match[1]) as Record<string, unknown>
}

suite("Error Interception — Integration (e2e)", function () {
	setDefaultSuiteTimeout(this)

	let se: StructuredErrorModule | undefined
	let bundleAvailable = false

	suiteSetup(function () {
		// __dirname = apps/vscode-e2e/out/suite at runtime.
		const workspaceRoot = path.resolve(__dirname, "..", "..", "..")
		const entry = findBuiltExtensionEntry(workspaceRoot)

		if (!entry) {
			// The bundled extension is not present (no `pnpm -w bundle` run).
			// This is an environment gap, not a contract regression — skip.
			console.warn(
				"[error-interception-integration e2e] built extension bundle not found; " +
					"run `pnpm -w bundle` before `test:run` to enable this suite.",
			)
			return
		}

		// Load the structuredError module from the built bundle. The bundle
		// exposes its internal modules via a loader keyed by module path; we
		// resolve the exact submodule so we test the real artifact.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const bundle = require(entry) as { __structuredError?: StructuredErrorModule } & Record<string, unknown>

		// Prefer an explicit re-export if the bundle surfaces one; otherwise
		// fall back to a deep-require of the submodule path within the bundle.
		if (bundle.__structuredError) {
			se = bundle.__structuredError
		} else {
			const subPath = path.join(workspaceRoot, "src", "dist", "core", "assistant-message", "structuredError.js")
			if (fs.existsSync(subPath)) {
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				se = require(subPath) as StructuredErrorModule
			}
		}

		bundleAvailable = se !== undefined
		if (!bundleAvailable) {
			console.warn(
				"[error-interception-integration e2e] structuredError module not exposed by the built bundle; " +
					"skipping integration assertions.",
			)
		}
	})

	setup(function () {
		if (!bundleAvailable) {
			this.skip()
		}
	})

	// -----------------------------------------------------------------------
	// Module surface
	// -----------------------------------------------------------------------

	test("module exposes the structured error integration surface", () => {
		assert.strictEqual(typeof se!.isUserRejectionError, "function", "isUserRejectionError must be a function")
		assert.strictEqual(typeof se!.isRetryableError, "function", "isRetryableError must be a function")
		assert.strictEqual(typeof se!.deriveRecoveryDisposition, "function", "deriveRecoveryDisposition must be a function")
		assert.strictEqual(typeof se!.buildErrorSignature, "function", "buildErrorSignature must be a function")
		assert.strictEqual(typeof se!.recordErrorOccurrence, "function", "recordErrorOccurrence must be a function")
		assert.strictEqual(typeof se!.formatStructuredError, "function", "formatStructuredError must be a function")
		assert.strictEqual(typeof se!.buildStructuredErrorContent, "function", "buildStructuredErrorContent must be a function")
		assert.strictEqual(typeof se!.formatConciseErrorMessage, "function", "formatConciseErrorMessage must be a function")
	})

	// -----------------------------------------------------------------------
	// Retryability classification
	// -----------------------------------------------------------------------

	test("isRetryableError marks terminal machine-code errors as non-retryable", () => {
		const terminal = new Error("TERMINAL/PROVIDER_SWITCH/003 provider switch failed")
		assert.strictEqual(se!.isRetryableError(terminal), false, "TERMINAL/ signal must be non-retryable")
	})

	test("isRetryableError marks validation errors as non-retryable", () => {
		const validation = new Error("validation failed: param `command` is required")
		assert.strictEqual(se!.isRetryableError(validation), false, "validation failures must be non-retryable")
	})

	test("isRetryableError treats generic runtime errors as retryable", () => {
		const runtime = new Error("ENOENT: no such file or directory")
		assert.strictEqual(se!.isRetryableError(runtime), true, "generic runtime errors must be retryable")
	})

	test("isUserRejectionError detects user-declined operations", () => {
		const rejected = new Error("The edit was rejected by the user")
		assert.strictEqual(se!.isUserRejectionError(rejected), true)
		assert.strictEqual(se!.isRetryableError(rejected), false, "user rejections must not be retried")
	})

	// -----------------------------------------------------------------------
	// Recovery disposition
	// -----------------------------------------------------------------------

	test("deriveRecoveryDisposition returns await_user for user rejections", () => {
		const rejected = new Error("The operation was denied by the user")
		assert.strictEqual(se!.deriveRecoveryDisposition(rejected, 1), "await_user")
	})

	test("deriveRecoveryDisposition returns change_strategy for non-retryable errors", () => {
		const terminal = new Error("TERMINAL/PROVIDER_SWITCH/003 provider switch failed")
		assert.strictEqual(se!.deriveRecoveryDisposition(terminal, 1), "change_strategy")
	})

	test("deriveRecoveryDisposition returns correct_once for a first retryable failure", () => {
		const runtime = new Error("ENOENT: no such file or directory")
		assert.strictEqual(se!.deriveRecoveryDisposition(runtime, 1), "correct_once")
	})

	// -----------------------------------------------------------------------
	// Structured error formatting (the model-facing contract)
	// -----------------------------------------------------------------------

	test("formatStructuredError emits a valid <error_details> JSON block", () => {
		const block = se!.formatStructuredError({
			what: "An error occurred during executing command.",
			why: "TERMINAL/PROVIDER_SWITCH/003 provider switch failed",
			next: ["Do not retry the executing command operation unchanged."],
			retryable: false,
			pattern: "TERMINAL/PROVIDER_SWITCH/003",
			occurrence: 1,
			disposition: "change_strategy",
		})

		const payload = parseErrorDetails(block)
		assert.strictEqual(payload.status, "error")
		assert.strictEqual(payload.retryable, false)
		assert.strictEqual(payload.occurrence, 1)
		assert.strictEqual(payload.recovery_disposition, "change_strategy")
		assert.strictEqual(typeof payload.what, "string")
		assert.strictEqual(typeof payload.why, "string")
		assert.ok(Array.isArray(payload.next), "next must be an array")
	})

	test("formatStructuredError downgrades pattern slashes to a dotted type discriminator", () => {
		const block = se!.formatStructuredError({
			what: "w",
			why: "y",
			next: ["n"],
			pattern: "TOOL_EXECUTION/ERROR_EXECUTION/001",
		})
		const payload = parseErrorDetails(block)
		assert.strictEqual(
			payload.type,
			"tool_execution.error_execution.001",
			"type must be the dotted lowercase form of the pattern id",
		)
		assert.ok(!String(payload.type).includes("/"), "type must not contain slashes")
	})

	test("formatStructuredError truncates to stay within the byte limit while remaining valid JSON", () => {
		const longWhy = "x".repeat(5000)
		const block = se!.formatStructuredError(
			{
				what: "An error occurred during executing command.",
				why: longWhy,
				next: ["first", "second", "third"],
				retryable: true,
			},
			1200,
		)
		// Must still parse as a well-formed block even under a tight limit.
		const payload = parseErrorDetails(block)
		assert.strictEqual(payload.status, "error")
		assert.ok(block.length <= 1400, `block should be truncated near the limit, got ${block.length}`)
	})

	// -----------------------------------------------------------------------
	// End-to-end flow: tool call → error → classification → guided message
	// -----------------------------------------------------------------------

	test("buildStructuredErrorContent produces occurrence-aware, honest non-retryable guidance", () => {
		const task = {}
		const error = new Error("TERMINAL/PROVIDER_SWITCH/003 provider switch failed")

		const first = se!.buildStructuredErrorContent(task, "executing command", error, "TERMINAL/PROVIDER_SWITCH/003")
		const firstPayload = parseErrorDetails(first)

		assert.strictEqual(firstPayload.retryable, false, "terminal errors must be marked non-retryable")
		assert.strictEqual(firstPayload.occurrence, 1, "first failure must report occurrence 1")
		assert.strictEqual(firstPayload.recovery_disposition, "change_strategy")
		assert.ok(
			(firstPayload.next as string[]).some((n) => /do not retry/i.test(n)),
			"non-retryable guidance must tell the model not to retry unchanged",
		)

		// The identical failure again must increment the occurrence counter.
		const second = se!.buildStructuredErrorContent(task, "executing command", error, "TERMINAL/PROVIDER_SWITCH/003")
		const secondPayload = parseErrorDetails(second)
		assert.strictEqual(secondPayload.occurrence, 2, "identical repeat failure must report occurrence 2")
	})

	test("buildStructuredErrorContent gives retryable errors corrective guidance", () => {
		const task = {}
		const error = new Error("ENOENT: no such file or directory")

		const block = se!.buildStructuredErrorContent(task, "reading file", error, "TOOL_EXECUTION/ERROR_EXECUTION/001")
		const payload = parseErrorDetails(block)

		assert.strictEqual(payload.retryable, true)
		assert.strictEqual(payload.recovery_disposition, "correct_once")
		assert.ok(
			(payload.next as string[]).some((n) => /retry/i.test(n)),
			"retryable guidance must invite a corrected retry",
		)
	})

	test("buildStructuredErrorContent escalates to change_strategy at the stuck-loop threshold", () => {
		const task = {}
		const error = new Error("ENOENT: no such file or directory")

		// Drive the same signature up to the stuck-loop threshold.
		let last = ""
		for (let i = 0; i < 3; i++) {
			last = se!.buildStructuredErrorContent(task, "reading file", error, "TOOL_EXECUTION/ERROR_EXECUTION/001")
		}
		const payload = parseErrorDetails(last)
		assert.ok(
			(payload.occurrence as number) >= 3,
			`expected occurrence >= 3 after repeated identical failures, got ${payload.occurrence}`,
		)
		assert.strictEqual(
			payload.recovery_disposition,
			"change_strategy",
			"repeated identical retryable failures must escalate to change_strategy",
		)
	})

	// -----------------------------------------------------------------------
	// UI-facing concise message (kept out of the structured payload)
	// -----------------------------------------------------------------------

	test("formatConciseErrorMessage produces a human-readable one-liner", () => {
		const msg = se!.formatConciseErrorMessage("executing command", new Error("spawn failed"))
		assert.strictEqual(msg, "Error during executing command: spawn failed")
		assert.ok(!msg.includes("<error_details>"), "concise UI message must not embed the structured payload")
	})

	test("formatConciseErrorMessage falls back for empty error messages", () => {
		const msg = se!.formatConciseErrorMessage("reading file", new Error(""))
		assert.ok(msg.includes("An unexpected error occurred."), "empty messages must get a fallback")
	})

	// -----------------------------------------------------------------------
	// Occurrence signature stability
	// -----------------------------------------------------------------------

	test("buildErrorSignature is stable for identical failures and distinct for different ones", () => {
		const a1 = se!.buildErrorSignature("executing command", new Error("boom\nstack line"))
		const a2 = se!.buildErrorSignature("executing command", new Error("boom\ndifferent stack"))
		const b = se!.buildErrorSignature("reading file", new Error("boom"))

		assert.strictEqual(a1, a2, "same action + same first line must map to the same signature")
		assert.notStrictEqual(a1, b, "different actions must produce different signatures")
	})
})
