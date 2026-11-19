import { vi } from "vitest"
import type { Mock } from "vitest"
import type * as vscode from "vscode"

export function makePosition(line = 0, character = 0): vscode.Position {
	return { line, character } as vscode.Position
}

export function makeRange(startLine = 0, startCharacter = 0, endLine = startLine, endCharacter = startCharacter) {
	return {
		start: makePosition(startLine, startCharacter),
		end: makePosition(endLine, endCharacter),
	} as vscode.Range
}

export function makeSelection(line = 0, character = 0): vscode.Selection {
	const position = makePosition(line, character)
	return { anchor: position, active: position } as vscode.Selection
}

export function makeUri(
	fsPath: string,
	overrides: Partial<Pick<vscode.Uri, "scheme" | "authority" | "path" | "query" | "fragment">> = {},
): vscode.Uri {
	// Uri is class-backed in VS Code; this structural double cast keeps the fake local and explicit.
	return {
		scheme: "file",
		authority: "",
		path: fsPath,
		query: "",
		fragment: "",
		fsPath,
		with: vi.fn(),
		toString: vi.fn(() => fsPath),
		toJSON: vi.fn(() => ({ fsPath })),
		...overrides,
	} as unknown as vscode.Uri
}

export function makeTextDocument(overrides: Partial<vscode.TextDocument> = {}): vscode.TextDocument {
	const uri = overrides.uri ?? makeUri("/mock/workspace/test.txt")
	const text = overrides.getText?.() ?? ""
	const lines = text.split("\n")
	const lineAt = vi.fn((line: number) => {
		const lineText = lines[line] ?? ""
		return {
			lineNumber: line,
			text: lineText,
			range: makeRange(line, 0, line, lineText.length),
			rangeIncludingLineBreak: makeRange(line, 0, line, lineText.length),
			firstNonWhitespaceCharacterIndex: lineText.search(/\S|$/),
			isEmptyOrWhitespace: lineText.trim().length === 0,
		} as vscode.TextLine
	})

	return {
		uri,
		fileName: uri.fsPath,
		isUntitled: false,
		languageId: "plaintext",
		version: 1,
		isDirty: false,
		isClosed: false,
		save: vi.fn().mockResolvedValue(true),
		eol: 1 as vscode.EndOfLine,
		lineCount: text === "" ? 0 : lines.length,
		encoding: "utf8",
		getText: vi.fn(() => text),
		getWordRangeAtPosition: vi.fn(),
		lineAt,
		offsetAt: vi.fn(),
		positionAt: vi.fn(),
		validateRange: vi.fn((range) => range),
		validatePosition: vi.fn((position) => position),
		...overrides,
	} as unknown as vscode.TextDocument
}

export function makeTextEditor(overrides: Partial<vscode.TextEditor> = {}): vscode.TextEditor {
	const document = overrides.document ?? makeTextDocument()
	const selection = overrides.selection ?? makeSelection()

	return {
		document,
		selection,
		selections: [selection],
		visibleRanges: [makeRange()],
		options: {},
		viewColumn: 1 as vscode.ViewColumn,
		edit: vi.fn().mockResolvedValue(true),
		insertSnippet: vi.fn().mockResolvedValue(true),
		setDecorations: vi.fn(),
		revealRange: vi.fn(),
		...overrides,
	} as unknown as vscode.TextEditor
}

export function makeDisposable(overrides: Partial<vscode.Disposable> = {}): vscode.Disposable {
	return { dispose: vi.fn(), ...overrides }
}

export function makeCompositeDisposable(...subscriptions: vscode.Disposable[]): vscode.Disposable {
	return makeDisposable({
		dispose: () => subscriptions.splice(0).forEach((subscription) => subscription?.dispose()),
	})
}

export function makeEventEmitter<T>(): vscode.EventEmitter<T> {
	const listeners = new Set<(value: T) => unknown>()
	const event = ((listener: (value: T) => unknown) => {
		listeners.add(listener)
		return makeDisposable({ dispose: () => listeners.delete(listener) })
	}) as unknown as vscode.Event<T>

	return {
		event,
		fire: (value: T) => listeners.forEach((listener) => listener(value)),
		dispose: () => listeners.clear(),
	} as vscode.EventEmitter<T>
}

export function makeWorkspaceConfiguration(values: Record<string, unknown> = {}): vscode.WorkspaceConfiguration {
	return {
		get: vi.fn(
			<T>(section: string, defaultValue?: T) =>
				(section in values ? values[section] : defaultValue) as T | undefined,
		),
		has: vi.fn((section: string) => section in values),
		inspect: vi.fn(),
		update: vi.fn().mockResolvedValue(undefined),
	} as unknown as vscode.WorkspaceConfiguration
}

export type MementoDouble = vscode.Memento & {
	get: Mock
	update: Mock
	keys: Mock
	// This repo types ExtensionContext.globalState as Memento plus setKeysForSync, so the double
	// carries it: typing the double to the interface is what keeps the call sites unmodified.
	setKeysForSync: Mock
}

// This repo's vscode typings have no top-level vscode.Secrets; the secrets shape is the one
// ExtensionContext already declares, so the double is built from that rather than a name that
// does not exist in this declaration file.
export type SecretsDouble = vscode.ExtensionContext["secrets"] & {
	get: Mock
	store: Mock
	delete: Mock
	onDidChange: Mock
}

/**
 * A VS Code Memento double. Every call returns a NEW object with NEW spies, so a value stored
 * through one double is invisible to the next: a module-scope Memento in a shared test helper is a
 * silent cross-test leak, and freshness is the helper's contract rather than an inference.
 */
export function makeFreshMemento(overrides: Partial<MementoDouble> = {}): MementoDouble {
	// Each call gets its own store, so a value written through one double cannot be read back through
	// the next. A shared Memento would leak, and only an assertion that writes and re-reads can show it.
	const store = new Map<string, unknown>()
	const get = vi.fn((key: string, defaultValue?: unknown) => (store.has(key) ? store.get(key) : defaultValue))
	const update = vi.fn((key: string, value: unknown) => {
		if (value === undefined) {
			store.delete(key)
		} else {
			store.set(key, value)
		}
		return Promise.resolve(undefined)
	})
	const keys = vi.fn(() => [...store.keys()])
	return {
		get,
		update,
		keys,
		setKeysForSync: vi.fn(),
		...overrides,
	}
}

/** Same freshness rule as makeFreshMemento: a new object and new spies on every call. */
export function makeFreshSecrets(overrides: Partial<SecretsDouble> = {}): SecretsDouble {
	return {
		get: vi.fn(),
		store: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
		onDidChange: vi.fn(() => makeDisposable()),
		...overrides,
	}
}

/**
 * An Extension double for the fields a test actually reads. Extension is class-backed in VS Code,
 * so the structural cast stays here with this reason instead of spreading to each call site.
 */
export function makeExtensionDouble(overrides: Partial<vscode.Extension<unknown>> = {}): vscode.Extension<unknown> {
	const extensionUri = overrides.extensionUri ?? makeUri("/mock/extension")
	return {
		extensionKind: 1 as vscode.ExtensionKind,
		id: "mock.extension",
		extensionUri,
		extensionPath: overrides.extensionPath ?? "/mock/extension",
		isActive: false,
		manifest: {},
		packageJSON: { name: "mock-extension", version: "0.0.0" },
		activate: vi.fn().mockResolvedValue(undefined),
		exports: undefined,
		...overrides,
	} as unknown as vscode.Extension<unknown>
}

export function makeExtensionContext(overrides: Partial<vscode.ExtensionContext> = {}): vscode.ExtensionContext {
	return {
		subscriptions: [],
		workspaceState: makeFreshMemento(),
		globalState: makeFreshMemento(),
		secrets: {
			get: vi.fn(),
			store: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
			onDidChange: new Map(),
		},
		extensionPath: "/mock/extension",
		extensionUri: makeUri("/mock/extension"),
		storagePath: "/mock/storage",
		globalStoragePath: "/mock/global-storage",
		logPath: "/mock/logs",
		extensionMode: 1 as vscode.ExtensionMode,
		environmentVariableCollection: {},
		asAbsolutePath: (relativePath: string) => `/mock/extension/${relativePath}`,
		...overrides,
	} as unknown as vscode.ExtensionContext
}
