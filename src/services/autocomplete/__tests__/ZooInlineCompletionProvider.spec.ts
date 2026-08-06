// npx vitest run src/services/autocomplete/__tests__/ZooInlineCompletionProvider.spec.ts

import * as vscode from "vscode"

import type { ResolvedAutocompleteConfig } from "@roo-code/types"

import { ZooInlineCompletionProvider } from "../ZooInlineCompletionProvider"

vi.mock("vscode", async () => {
	const actual = await vi.importActual<typeof import("vscode")>("vscode")
	return {
		...actual,
		InlineCompletionTriggerKind: { Automatic: 0, Invoke: 1 },
		CancellationTokenSource: class {
			token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }
			cancel() {}
			dispose() {}
		},
	}
})

const resolvedConfig = (overrides: Partial<ResolvedAutocompleteConfig> = {}): ResolvedAutocompleteConfig => ({
	enabled: true,
	provider: "ollama",
	modelId: undefined,
	baseUrl: "http://localhost:11434",
	chatFallbackProvider: undefined,
	triggerMode: "automatic",
	debounceMs: 300,
	minCharsTyped: 0,
	multilineMode: "auto",
	contextLength: 8192,
	maxPrefixTokens: 1024,
	maxSuffixTokens: 512,
	maxSnippetTokens: 512,
	maxOutputTokens: 256,
	temperature: 0.01,
	requestTimeoutMs: 5_000,
	useRecentlyEdited: true,
	useOpenTabs: true,
	useImportDefinitions: true,
	useAst: true,
	fimTemplate: "auto",
	stopSequences: undefined,
	disabledLanguages: [],
	...overrides,
})

const makeDocument = () =>
	({
		uri: { fsPath: "/workspace/src/app.ts", toString: () => "file:///workspace/src/app.ts" },
		languageId: "typescript",
		getText: () => "function fib() {}\n",
	}) as unknown as vscode.TextDocument

const automaticContext: vscode.InlineCompletionContext = {
	triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
	selectedCompletionInfo: undefined,
}

const InvokeContext: vscode.InlineCompletionContext = {
	triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
	selectedCompletionInfo: undefined,
}

describe("ZooInlineCompletionProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns no completion while the feature is disabled", () => {
		const provider = new ZooInlineCompletionProvider({
			getConfig: () => resolvedConfig({ enabled: false }),
			validateAccess: () => true,
		})

		const result = provider.provideInlineCompletionItems(
			makeDocument(),
			new vscode.Position(0, 0),
			automaticContext,
			new vscode.CancellationTokenSource().token,
		)

		expect(result).toBeUndefined()
	})

	it("returns no completion when the document is excluded by .rooignore", () => {
		const validateAccess = vi.fn(() => false)
		const provider = new ZooInlineCompletionProvider({
			getConfig: () => resolvedConfig(),
			validateAccess,
		})

		const result = provider.provideInlineCompletionItems(
			makeDocument(),
			new vscode.Position(0, 0),
			automaticContext,
			new vscode.CancellationTokenSource().token,
		)

		expect(result).toBeUndefined()
		expect(validateAccess).toHaveBeenCalledWith("/workspace/src/app.ts")
	})

	it("returns no completion while the suggest widget has a selection", () => {
		const provider = new ZooInlineCompletionProvider({
			getConfig: () => resolvedConfig(),
			validateAccess: () => true,
		})

		const result = provider.provideInlineCompletionItems(
			makeDocument(),
			new vscode.Position(0, 0),
			{
				triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
				selectedCompletionInfo: { text: "fib", range: new vscode.Range(0, 0, 0, 3) },
			},
			new vscode.CancellationTokenSource().token,
		)

		expect(result).toBeUndefined()
	})

	it("suppresses automatic triggers in manual mode", () => {
		const provider = new ZooInlineCompletionProvider({
			getConfig: () => resolvedConfig({ triggerMode: "manual" }),
			validateAccess: () => true,
		})

		const result = provider.provideInlineCompletionItems(
			makeDocument(),
			new vscode.Position(0, 0),
			automaticContext,
			new vscode.CancellationTokenSource().token,
		)

		expect(result).toBeUndefined()
	})

	it("allows the Invoke trigger in manual mode", () => {
		const provider = new ZooInlineCompletionProvider({
			getConfig: () => resolvedConfig({ triggerMode: "manual" }),
			validateAccess: () => true,
		})

		const result = provider.provideInlineCompletionItems(
			makeDocument(),
			new vscode.Position(0, 0),
			InvokeContext,
			new vscode.CancellationTokenSource().token,
		)

		// Phase 1 has no engine yet, so even a passing prefilter yields nothing —
		// but it must NOT return undefined via the trigger-mode gate.
		expect(result).toBeUndefined()
	})

	it("honors a forced trigger even in manual mode with an automatic request", () => {
		const provider = new ZooInlineCompletionProvider({
			getConfig: () => resolvedConfig({ triggerMode: "manual" }),
			validateAccess: () => true,
		})

		provider.requestForcedTrigger()

		const result = provider.provideInlineCompletionItems(
			makeDocument(),
			new vscode.Position(0, 0),
			automaticContext,
			new vscode.CancellationTokenSource().token,
		)

		// The force flag is consumed: no engine exists yet, so nothing is returned,
		// but the trigger-mode gate did not reject the call.
		expect(result).toBeUndefined()

		// The flag is one-shot: the next automatic call is suppressed again.
		const second = provider.provideInlineCompletionItems(
			makeDocument(),
			new vscode.Position(0, 0),
			automaticContext,
			new vscode.CancellationTokenSource().token,
		)
		expect(second).toBeUndefined()
	})
})
