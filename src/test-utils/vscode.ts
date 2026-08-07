import { vi } from "vitest"
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

export function makeExtensionContext(overrides: Partial<vscode.ExtensionContext> = {}): vscode.ExtensionContext {
	const makeMemento = () => ({
		get: vi.fn(),
		update: vi.fn().mockResolvedValue(undefined),
		keys: vi.fn(() => []),
	})

	return {
		subscriptions: [],
		workspaceState: makeMemento(),
		globalState: makeMemento(),
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
