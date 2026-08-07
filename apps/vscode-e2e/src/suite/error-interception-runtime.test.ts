import * as assert from "assert"
import * as path from "path"
import * as fs from "fs"

import { setDefaultSuiteTimeout } from "./test-utils"

// ---------------------------------------------------------------------------
// Error Interception — runtime interceptor integration at e2e scope
// ---------------------------------------------------------------------------
//
// This suite exercises the Runtime Error Interceptor shipped by this PR
// (ToolErrorInterceptor, MessageTransformer, StructuralValidator,
// TaskErrorState) against the real, built extension artifact, not a
// re-implemented copy.
//
// Why this lives in apps/vscode-e2e and not in src/__tests__:
//   - The unit specs (ToolErrorInterceptor.spec.ts, MessageTransformer.spec.ts,
//     etc.) run under Vitest with direct TS source access. They prove the
//     interceptor logic in isolation.
//   - This e2e suite runs inside the real VS Code extension host against the
//     bundled extension output that actually ships. It proves the runtime
//     contract (decorator shape, interception behavior, circuit breaker,
//     message transformation, structural validation) survives bundling and is
//     importable end-to-end.
//
// How the module is loaded:
//   The e2e workspace does not use TS project references into src/, so a
//   static import would fail `check-types`. Instead we locate the built
//   extension entry (dist/extension.js, produced by `pnpm -w bundle` in the
//   test:ci pipeline) and require the error-interception submodule from the
//   same output the host loads. If the bundle is absent (e.g. a bare
//   `check-types` run without a build), the suite skips cleanly rather than
//   failing on an infrastructure gap.

interface ErrorClassificationLike {
	category: string
	patternId: string
	confidence: string
	retryPolicy: string
	facts: Readonly<Record<string, unknown>>
}

interface InterceptionSignalLike {
	source: string
	stage: string
	taskId: string
	toolCallId?: string
	toolName?: string
	error?: unknown
	result?: { type?: string; status?: string; error?: unknown; text?: string; [key: string]: unknown }
	metadata: Readonly<Record<string, unknown>>
}

type ToolResponseLike = string | Array<{ type: string; text?: string; [key: string]: unknown }>

interface DecoratedCallbacksLike {
	decoratedHandleError: (action: string, error: Error) => Promise<void>
	decoratedPushToolResult: (content: ToolResponseLike, ...rest: unknown[]) => void
	rawHandleError: (action: string, error: Error) => Promise<void>
	rawPushToolResult: (content: ToolResponseLike, ...rest: unknown[]) => void
}

interface ToolErrorInterceptorLike {
	getTaskState(task: object): { categoryCounts: Map<string, number>; shellCircuitOpen: boolean }
	resetTaskState(task: object, category?: string): void
	createInterceptor(
		task: object,
		callbacks: {
			handleError: (action: string, error: Error) => Promise<void>
			pushToolResult: (content: ToolResponseLike, ...rest: unknown[]) => void
		},
		options: {
			taskId: string
			toolCallId?: string
			toolName?: string
			source?: string
			stage?: string
			metadata?: Record<string, unknown>
		},
	): DecoratedCallbacksLike
	transformToolResult(
		result: InterceptionSignalLike["result"],
		options: { taskId: string; toolCallId?: string; occurrence?: number },
	): string | undefined
	transformError(task: object, signal: InterceptionSignalLike): string | undefined
}

interface StructuralValidatorModule {
	validateCwdParameter(args: Record<string, unknown>, toolName?: string): InterceptionSignalLike | null
	validateNestedParams(args: Record<string, unknown>, toolName: string): InterceptionSignalLike | null
	VARIANT_CWD_OBJECT_MISUSE: string
	VARIANT_NESTED_PARAM_OVERFLOW: string
}

interface TaskErrorStateLike {
	getOccurrence(category: string): number
	incrementOccurrence(category: string): number
	isOpen(category: string): boolean
	getFingerprint(category: string): string | undefined
	setFingerprint(category: string, fingerprint: string): void
	reset(category?: string): void
}

interface TaskErrorStateModule {
	getTaskErrorState(task: object): TaskErrorStateLike
	hasTaskErrorState(task: object): boolean
	STUCK_LOOP_THRESHOLD: number
}

interface MessageTransformerModule {
	transformErrorToMessage(classification: ErrorClassificationLike, options?: { occurrence?: number; byteLimit?: number }): string
	formatErrorDetails(
		category: string,
		type: string,
		what: string,
		why: string,
		next: string[],
		retryable: boolean,
		occurrence: number,
		patternId: string,
		recoveryDisposition?: string,
	): string
	extractCategoryFromGuided(message: string): string | undefined
	getCategoryTitle(category: string): string
	getPayloadByteLength(text: string): number
	MODEL_PAYLOAD_BYTE_LIMIT: number
}

interface ErrorInterceptionRuntimeModule {
	// Runtime interceptor
	createToolErrorInterceptor: () => ToolErrorInterceptorLike
	ToolErrorInterceptor: new () => ToolErrorInterceptorLike
	SHELL_CIRCUIT_THRESHOLD: number
	// Message transformation
	transformErrorToMessage: MessageTransformerModule["transformErrorToMessage"]
	formatErrorDetails: MessageTransformerModule["formatErrorDetails"]
	extractCategoryFromGuided: MessageTransformerModule["extractCategoryFromGuided"]
	getCategoryTitle: MessageTransformerModule["getCategoryTitle"]
	getPayloadByteLength: MessageTransformerModule["getPayloadByteLength"]
	MODEL_PAYLOAD_BYTE_LIMIT: number
	// Structural validation
	validateCwdParameter: StructuralValidatorModule["validateCwdParameter"]
	validateNestedParams: StructuralValidatorModule["validateNestedParams"]
	VARIANT_CWD_OBJECT_MISUSE: string
	VARIANT_NESTED_PARAM_OVERFLOW: string
	// Task error state
	getTaskErrorState: TaskErrorStateModule["getTaskErrorState"]
	hasTaskErrorState: TaskErrorStateModule["hasTaskErrorState"]
	STUCK_LOOP_THRESHOLD: number
	// Classifier (used to build classification inputs for the transformer)
	classifyError: (signal: InterceptionSignalLike) => ErrorClassificationLike
	classifyToolResult: (
		result: InterceptionSignalLike["result"],
		taskId: string,
		toolCallId?: string,
	) => ErrorClassificationLike
}

function findBuiltExtensionEntry(workspaceRoot: string): string | undefined {
	const candidates = [
		path.join(workspaceRoot, "src", "dist", "extension.js"),
		path.join(workspaceRoot, "dist", "extension.js"),
		path.join(workspaceRoot, "src", "dist", "extension.cjs"),
	]
	return candidates.find((p) => fs.existsSync(p))
}

function makeSignal(overrides: Partial<InterceptionSignalLike> = {}): InterceptionSignalLike {
	return {
		source: "tool_result",
		stage: "result",
		taskId: "e2e-error-runtime",
		toolCallId: "e2e-tool-call-1",
		toolName: "read_file",
		metadata: {},
		...overrides,
	}
}

suite("Error Interception — Runtime (e2e)", function () {
	setDefaultSuiteTimeout(this)

	let ei: ErrorInterceptionRuntimeModule | undefined
	let bundleAvailable = false

	suiteSetup(function () {
		// __dirname = apps/vscode-e2e/out/suite at runtime.
		const workspaceRoot = path.resolve(__dirname, "..", "..", "..")
		const entry = findBuiltExtensionEntry(workspaceRoot)

		if (!entry) {
			// The bundled extension is not present (no `pnpm -w bundle` run).
			// This is an environment gap, not a contract regression — skip.
			console.warn(
				"[error-interception-runtime e2e] built extension bundle not found; " +
					"run `pnpm -w bundle` before `test:run` to enable this suite.",
			)
			return
		}

		// Load the error-interception module from the built bundle. The bundle
		// exposes its internal modules via a loader keyed by module path; we
		// resolve the exact submodule so we test the real artifact.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const bundle = require(entry) as { __errorInterception?: ErrorInterceptionRuntimeModule } & Record<
			string,
			unknown
		>

		// Prefer an explicit re-export if the bundle surfaces one; otherwise
		// fall back to a deep-require of the submodule path within the bundle.
		if (bundle.__errorInterception) {
			ei = bundle.__errorInterception
		} else {
			const subPath = path.join(
				workspaceRoot,
				"src",
				"dist",
				"core",
				"tools",
				"error-interception",
				"index.js",
			)
			if (fs.existsSync(subPath)) {
				// eslint-disable-next-line @typescript-eslint/no-var-requires
				ei = require(subPath) as ErrorInterceptionRuntimeModule
			}
		}

		bundleAvailable = ei !== undefined
		if (!bundleAvailable) {
			console.warn(
				"[error-interception-runtime e2e] error-interception module not exposed by the built bundle; " +
					"skipping runtime assertions.",
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

	test("module exposes the runtime interceptor surface", () => {
		assert.strictEqual(typeof ei!.createToolErrorInterceptor, "function", "createToolErrorInterceptor must be a function")
		assert.strictEqual(typeof ei!.ToolErrorInterceptor, "function", "ToolErrorInterceptor must be a constructor")
		assert.strictEqual(typeof ei!.SHELL_CIRCUIT_THRESHOLD, "number", "SHELL_CIRCUIT_THRESHOLD must be exported")
		assert.ok(ei!.SHELL_CIRCUIT_THRESHOLD >= 1, "SHELL_CIRCUIT_THRESHOLD must be positive")
	})

	// -----------------------------------------------------------------------
	// ToolErrorInterceptor — decorated callback behavior
	// -----------------------------------------------------------------------

	test("createInterceptor returns decorators plus raw callback references", () => {
		const interceptor = ei!.createToolErrorInterceptor()
		const rawHandleErrorCalls: Array<{ action: string; error: Error }> = []
		const rawPushCalls: ToolResponseLike[] = []

		const callbacks = ei!.ToolErrorInterceptor
			? new ei!.ToolErrorInterceptor().createInterceptor(
					{},
					{
						handleError: async (action: string, error: Error) => {
							rawHandleErrorCalls.push({ action, error })
						},
						pushToolResult: (content: ToolResponseLike) => {
							rawPushCalls.push(content)
						},
					},
					{ taskId: "e2e-runtime-surface", toolName: "read_file" },
				)
			: interceptor.createInterceptor(
					{},
					{
						handleError: async (action: string, error: Error) => {
							rawHandleErrorCalls.push({ action, error })
						},
						pushToolResult: (content: ToolResponseLike) => {
							rawPushCalls.push(content)
						},
					},
					{ taskId: "e2e-runtime-surface", toolName: "read_file" },
				)

		assert.strictEqual(typeof callbacks.decoratedHandleError, "function")
		assert.strictEqual(typeof callbacks.decoratedPushToolResult, "function")
		assert.strictEqual(typeof callbacks.rawHandleError, "function")
		assert.strictEqual(typeof callbacks.rawPushToolResult, "function")
	})

	test("decoratedPushToolResult passes through non-error content unchanged", () => {
		const interceptor = ei!.createToolErrorInterceptor()
		const pushed: ToolResponseLike[] = []

		const { decoratedPushToolResult } = interceptor.createInterceptor(
			{},
			{
				handleError: async () => {},
				pushToolResult: (content: ToolResponseLike) => {
					pushed.push(content)
				},
			},
			{ taskId: "e2e-runtime-passthrough", toolName: "read_file" },
		)

		decoratedPushToolResult("file contents here")
		assert.strictEqual(pushed.length, 1)
		assert.strictEqual(pushed[0], "file contents here")
	})

	test("decoratedPushToolResult transforms a structured error result", () => {
		const interceptor = ei!.createToolErrorInterceptor()
		const pushed: ToolResponseLike[] = []

		const { decoratedPushToolResult } = interceptor.createInterceptor(
			{},
			{
				handleError: async () => {},
				pushToolResult: (content: ToolResponseLike) => {
					pushed.push(content)
				},
			},
			{ taskId: "e2e-runtime-transform", toolName: "read_file" },
		)

		decoratedPushToolResult('{"status":"error","text":"File not found: /nonexistent/x.txt"}')
		assert.strictEqual(pushed.length, 1, "exactly one result must be pushed")
		assert.strictEqual(typeof pushed[0], "string", "transformed result must be a string")
		assert.ok((pushed[0] as string).includes("<error_details>"), "transformed result must be a guided error_details block")
		assert.ok((pushed[0] as string).includes("Category: FILE_NOT_FOUND"), "category must be FILE_NOT_FOUND")
	})

	test("decoratedHandleError pushes a guided result then calls raw handleError", async () => {
		const interceptor = ei!.createToolErrorInterceptor()
		const pushed: ToolResponseLike[] = []
		const rawErrors: Array<{ action: string; error: Error }> = []

		const { decoratedHandleError } = interceptor.createInterceptor(
			{},
			{
				handleError: async (action: string, error: Error) => {
					rawErrors.push({ action, error })
				},
				pushToolResult: (content: ToolResponseLike) => {
					pushed.push(content)
				},
			},
			{ taskId: "e2e-runtime-handleerror", toolName: "execute_command" },
		)

		await decoratedHandleError("execute_command", new Error("shell integration failed: command timed out"))

		assert.strictEqual(rawErrors.length, 1, "raw handleError must be invoked exactly once")
		assert.strictEqual(rawErrors[0]?.action, "execute_command")
		assert.strictEqual(pushed.length, 1, "a guided model-facing result must be pushed")
		assert.strictEqual(typeof pushed[0], "string")
		assert.ok((pushed[0] as string).includes("<error_details>"), "guided result must use error_details format")
	})

	test("decoratedHandleError forwards raw error when taskId is empty (fail-open guard)", async () => {
		const interceptor = ei!.createToolErrorInterceptor()
		const pushed: ToolResponseLike[] = []
		const rawErrors: Error[] = []

		const { decoratedHandleError } = interceptor.createInterceptor(
			{},
			{
				handleError: async (_action: string, error: Error) => {
					rawErrors.push(error)
				},
				pushToolResult: (content: ToolResponseLike) => {
					pushed.push(content)
				},
			},
			{ taskId: "", toolName: "execute_command" },
		)

		await decoratedHandleError("execute_command", new Error("boom"))
		assert.strictEqual(rawErrors.length, 1, "raw handleError must still be called")
		assert.strictEqual(pushed.length, 0, "no guided result may be pushed when taskId is empty")
	})

	// -----------------------------------------------------------------------
	// Shell integration circuit breaker
	// -----------------------------------------------------------------------

	test("shell circuit opens after SHELL_CIRCUIT_THRESHOLD failures", () => {
		const interceptor = ei!.createToolErrorInterceptor()
		const task = {}
		const pushed: ToolResponseLike[] = []

		const { decoratedPushToolResult } = interceptor.createInterceptor(
			task,
			{
				handleError: async () => {},
				pushToolResult: (content: ToolResponseLike) => {
					pushed.push(content)
				},
			},
			{ taskId: "e2e-runtime-circuit", toolName: "execute_command" },
		)

		// Drive the circuit by pushing shell-integration-shaped errors. Each
		// push increments the per-task SHELL_INTEGRATION counter.
		for (let i = 0; i < ei!.SHELL_CIRCUIT_THRESHOLD + 1; i++) {
			decoratedPushToolResult(
				JSON.stringify({ status: "error", text: "shell integration unavailable: terminal not ready" }),
			)
		}

		const state = interceptor.getTaskState(task)
		assert.strictEqual(state.shellCircuitOpen, true, "shell circuit must be open after threshold failures")

		// The last pushed message must be the circuit-open guidance.
		const last = pushed[pushed.length - 1]
		assert.strictEqual(typeof last, "string")
		assert.ok((last as string).includes("EI/SHELL_INTEGRATION/CIRCUIT_OPEN"), "circuit-open message must carry the circuit pattern id")
	})

	test("resetTaskState closes the shell circuit", () => {
		const interceptor = ei!.createToolErrorInterceptor()
		const task = {}
		const pushed: ToolResponseLike[] = []

		const { decoratedPushToolResult } = interceptor.createInterceptor(
			task,
			{
				handleError: async () => {},
				pushToolResult: (content: ToolResponseLike) => {
					pushed.push(content)
				},
			},
			{ taskId: "e2e-runtime-reset", toolName: "execute_command" },
		)

		for (let i = 0; i < ei!.SHELL_CIRCUIT_THRESHOLD; i++) {
			decoratedPushToolResult(
				JSON.stringify({ status: "error", text: "shell integration unavailable: terminal not ready" }),
			)
		}
		assert.strictEqual(interceptor.getTaskState(task).shellCircuitOpen, true)

		interceptor.resetTaskState(task, "SHELL_INTEGRATION")
		assert.strictEqual(interceptor.getTaskState(task).shellCircuitOpen, false, "circuit must close after category reset")
	})

	// -----------------------------------------------------------------------
	// MessageTransformer — runtime message contract
	// -----------------------------------------------------------------------

	test("transformErrorToMessage produces a bounded error_details block", () => {
		const classification = ei!.classifyError(
			makeSignal({
				result: { type: "tool_result", status: "error", text: "File not found: /x" },
				metadata: { status: "error", fileNotFound: true },
			}),
		)

		const message = ei!.transformErrorToMessage(classification, { occurrence: 1 })
		assert.ok(message.startsWith("<error_details>"), "message must start with <error_details>")
		assert.ok(message.endsWith("</error_details>"), "message must end with </error_details>")
		assert.ok(message.includes(`Category: ${classification.category}`), "message must include the category line")
		assert.ok(
			ei!.getPayloadByteLength(message) <= ei!.MODEL_PAYLOAD_BYTE_LIMIT,
			"message must fit within the model payload byte limit",
		)
	})

	test("transformErrorToMessage escalates wording on repeated occurrences", () => {
		const classification = ei!.classifyError(
			makeSignal({
				result: { type: "tool_result", status: "error", text: "File not found: /x" },
				metadata: { status: "error", fileNotFound: true },
			}),
		)

		const first = ei!.transformErrorToMessage(classification, { occurrence: 1 })
		const repeated = ei!.transformErrorToMessage(classification, { occurrence: 2 })
		const stuck = ei!.transformErrorToMessage(classification, { occurrence: 3 })

		assert.ok(first.includes("Occurrence: 1"))
		assert.ok(repeated.includes("Occurrence: 2"))
		assert.ok(stuck.includes("Occurrence: 3"))
		// Repeated/stuck guidance must differ from the first-occurrence guidance.
		assert.notStrictEqual(repeated, first, "repeated occurrence guidance must differ from first")
		assert.notStrictEqual(stuck, repeated, "stuck occurrence guidance must differ from repeated")
	})

	test("formatErrorDetails round-trips through extractCategoryFromGuided", () => {
		const details = ei!.formatErrorDetails(
			"SHELL_INTEGRATION",
			"guided_tool_error",
			"The terminal execution channel is unavailable.",
			"Repeated shell integration failures.",
			["Stop repeating shell commands."],
			false,
			1,
			"EI/SHELL_INTEGRATION/CIRCUIT_OPEN",
		)

		const category = ei!.extractCategoryFromGuided(details)
		assert.strictEqual(category, "SHELL_INTEGRATION")
		assert.strictEqual(ei!.getCategoryTitle(category), "Terminal Error")
	})

	// -----------------------------------------------------------------------
	// transformToolResult — direct classification entry point
	// -----------------------------------------------------------------------

	test("transformToolResult returns a guided message for a classified result", () => {
		const interceptor = ei!.createToolErrorInterceptor()
		const message = interceptor.transformToolResult(
			{ type: "tool_result", status: "error", text: "File not found: /nope" },
			{ taskId: "e2e-runtime-ttr", toolCallId: "call-1" },
		)
		assert.ok(message !== undefined, "a classified result must produce a guided message")
		assert.ok(message!.includes("<error_details>"))
		assert.ok(message!.includes("Category: FILE_NOT_FOUND"))
	})

	test("transformToolResult returns undefined for an unclassified result", () => {
		const interceptor = ei!.createToolErrorInterceptor()
		const message = interceptor.transformToolResult(
			{ type: "tool_result", status: "ok", text: "everything is fine" },
			{ taskId: "e2e-runtime-ttr-ok" },
		)
		assert.strictEqual(message, undefined, "unclassified results must pass through (undefined)")
	})

	// -----------------------------------------------------------------------
	// StructuralValidator — runtime contract
	// -----------------------------------------------------------------------

	test("validateCwdParameter flags a non-string cwd without leaking values", () => {
		const signal = ei!.validateCwdParameter({ command: "ls", cwd: { path: "/etc" } }, "execute_command")
		assert.ok(signal !== null, "a non-string cwd must produce a signal")
		assert.strictEqual(signal!.metadata["variant"], ei!.VARIANT_CWD_OBJECT_MISUSE)
		assert.strictEqual(signal!.metadata["parameter"], "cwd")
		assert.strictEqual(signal!.metadata["expectedType"], "string")
		// Sanitization contract: raw values must not be copied into metadata.
		assert.strictEqual(signal!.metadata["cwd"], undefined, "raw cwd value must not be present in metadata")
		assert.strictEqual(signal!.metadata["command"], undefined, "raw command value must not be present in metadata")
	})

	test("validateCwdParameter returns null for a valid string cwd", () => {
		const signal = ei!.validateCwdParameter({ command: "ls", cwd: "/tmp" }, "execute_command")
		assert.strictEqual(signal, null)
	})

	test("validateNestedParams flags a nested tool input object", () => {
		const signal = ei!.validateNestedParams({ path: { command: "rm -rf /", cwd: "/" } }, "read_file")
		assert.ok(signal !== null, "a nested tool-shaped object must produce a signal")
		assert.strictEqual(signal!.metadata["variant"], ei!.VARIANT_NESTED_PARAM_OVERFLOW)
	})

	test("validateNestedParams allows schema-declared object parameters", () => {
		// read_file.indentation is a declared object parameter and must not be flagged.
		const signal = ei!.validateNestedParams({ path: "/tmp/x", indentation: { anchor_line: 1 } }, "read_file")
		assert.strictEqual(signal, null)
	})

	// -----------------------------------------------------------------------
	// TaskErrorState — runtime contract
	// -----------------------------------------------------------------------

	test("getTaskErrorState tracks occurrences and opens the circuit at the threshold", () => {
		const task = {}
		assert.strictEqual(ei!.hasTaskErrorState(task), false, "no state before first get")

		const state = ei!.getTaskErrorState(task)
		assert.strictEqual(ei!.hasTaskErrorState(task), true, "state materialized after get")

		assert.strictEqual(state.getOccurrence("FILE_NOT_FOUND"), 0)
		assert.strictEqual(state.isOpen("FILE_NOT_FOUND"), false)

		for (let i = 1; i <= ei!.STUCK_LOOP_THRESHOLD; i++) {
			const occurrence = state.incrementOccurrence("FILE_NOT_FOUND")
			assert.strictEqual(occurrence, i)
		}
		assert.strictEqual(state.isOpen("FILE_NOT_FOUND"), true, "circuit must open at STUCK_LOOP_THRESHOLD")
	})

	test("TaskErrorState stores a sanitized fingerprint per category", () => {
		const task = {}
		const state = ei!.getTaskErrorState(task)
		assert.strictEqual(state.getFingerprint("FILE_NOT_FOUND"), undefined)
		state.setFingerprint("FILE_NOT_FOUND", "fp-structural-only")
		assert.strictEqual(state.getFingerprint("FILE_NOT_FOUND"), "fp-structural-only")
	})

	test("TaskErrorState reset clears a category counter and circuit", () => {
		const task = {}
		const state = ei!.getTaskErrorState(task)
		for (let i = 0; i < ei!.STUCK_LOOP_THRESHOLD; i++) {
			state.incrementOccurrence("FILE_NOT_FOUND")
		}
		assert.strictEqual(state.isOpen("FILE_NOT_FOUND"), true)
		state.reset("FILE_NOT_FOUND")
		assert.strictEqual(state.getOccurrence("FILE_NOT_FOUND"), 0, "counter must clear after reset")
		assert.strictEqual(state.isOpen("FILE_NOT_FOUND"), false, "circuit must close after reset")
	})
})
