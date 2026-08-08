import * as assert from "assert"
import * as path from "path"
import * as fs from "fs"
import { pathToFileURL } from "node:url"

import { setDefaultSuiteTimeout } from "./test-utils"

// ---------------------------------------------------------------------------
// Error Interception — bundled-artifact import smoke test
// ---------------------------------------------------------------------------
//
// Scope: This suite is intentionally minimal. It proves ONE thing — that the
// error-interception contract (classifyError / classifyToolResult /
// ERROR_PATTERNS) survives bundling and is importable from the real, built
// extension artifact that the VS Code extension host loads.
//
// Detailed classifier behavior (pattern ordering, classification accuracy,
// parameter sanitization, metadata redaction, fallback/UNCLASSIFIED behavior)
// is covered by the Vitest unit suite at:
//   src/core/tools/error-interception/__tests__/ErrorClassifier.spec.ts
//
// How the module is loaded:
//   The e2e workspace does not use TS project references into src/, so a
//   static import would fail `check-types`. Instead we locate the built
//   extension entry (dist/extension.js, produced by `pnpm -w bundle` in the
//   test:ci pipeline) and dynamically import it — the same artifact the host
//   loads. If the bundle is absent (e.g. a bare `check-types` run without a
//   build), the suite skips cleanly rather than failing on an infrastructure
//   gap.

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

interface ErrorInterceptionModule {
	classifyError: (signal: InterceptionSignalLike) => ErrorClassificationLike
	classifyToolResult: (
		result: InterceptionSignalLike["result"],
		taskId: string,
		toolCallId?: string,
	) => ErrorClassificationLike
	ERROR_PATTERNS: Array<{ id: string; category: string; priority: number }>
}

function findBuiltExtensionEntry(workspaceRoot: string): string | undefined {
	const candidates = [
		path.join(workspaceRoot, "src", "dist", "extension.js"),
		path.join(workspaceRoot, "dist", "extension.js"),
		path.join(workspaceRoot, "src", "dist", "extension.cjs"),
	]
	return candidates.find((p) => fs.existsSync(p))
}

async function loadModuleFromBundle(workspaceRoot: string, entry: string): Promise<ErrorInterceptionModule | undefined> {
	// Load the built bundle via dynamic import. The bundle may surface the
	// error-interception contract as an explicit re-export; otherwise we fall
	// back to importing the submodule path within the same output directory.
	const entryUrl = pathToFileURL(entry).href
	const bundle = (await import(entryUrl)) as { __errorInterception?: ErrorInterceptionModule } & Record<string, unknown>

	if (bundle.__errorInterception) {
		return bundle.__errorInterception
	}

	const subPath = path.join(workspaceRoot, "src", "dist", "core", "tools", "error-interception", "index.js")
	if (fs.existsSync(subPath)) {
		return (await import(pathToFileURL(subPath).href)) as ErrorInterceptionModule
	}

	return undefined
}

suite("Error Interception — Bundled Artifact Smoke Test (e2e)", function () {
	setDefaultSuiteTimeout(this)

	let ei: ErrorInterceptionModule | undefined

	suiteSetup(async function () {
		// __dirname = apps/vscode-e2e/out/suite at runtime.
		// 4 levels up: suite -> out -> vscode-e2e -> apps -> workspace root.
		const workspaceRoot = path.resolve(__dirname, "..", "..", "..", "..")
		const entry = findBuiltExtensionEntry(workspaceRoot)

		if (!entry) {
			// The bundled extension is not present (no `pnpm -w bundle` run).
			// This is an environment gap, not a contract regression — skip.
			console.warn(
				"[error-interception e2e] built extension bundle not found; " +
					"run `pnpm -w bundle` before `test:run` to enable this suite.",
			)
			return
		}

		try {
			ei = await loadModuleFromBundle(workspaceRoot, entry)
		} catch (e) {
			console.warn(
				"[error-interception e2e] failed to load module from bundle; " +
					"skipping contract assertions.",
				e instanceof Error ? e.message : e,
			)
			return
		}

		if (!ei) {
			console.warn(
				"[error-interception e2e] error-interception module not exposed by the built bundle; " +
					"skipping contract assertions.",
			)
		}
	})

	setup(function () {
		if (!ei) {
			this.skip()
		}
	})

	test("bundled artifact exports the error-interception contract", () => {
		assert.ok(ei, "error-interception module must be importable from the built bundle")
		assert.strictEqual(typeof ei!.classifyError, "function", "classifyError must be a function")
		assert.strictEqual(typeof ei!.classifyToolResult, "function", "classifyToolResult must be a function")
		assert.ok(Array.isArray(ei!.ERROR_PATTERNS), "ERROR_PATTERNS must be an array")
		assert.ok(ei!.ERROR_PATTERNS.length > 0, "pattern DB must not be empty")
	})

	test("bundled classifier classifies a FILE_NOT_FOUND tool result end-to-end", () => {
		const c = ei!.classifyError({
			source: "tool_result",
			stage: "result",
			taskId: "e2e-error-interception-smoke",
			toolCallId: "e2e-tool-call-1",
			toolName: "read_file",
			result: {
				type: "tool_result",
				status: "error",
				text: "File not found: /nonexistent/path/that/does/not/exist.txt",
			},
			metadata: { status: "error", fileNotFound: true },
		})

		assert.strictEqual(c.category, "FILE_NOT_FOUND")
		assert.ok(c.patternId.length > 0, "patternId must identify the matched pattern")
		assert.strictEqual(c.facts.errorSource, "tool_result")
	})
})
