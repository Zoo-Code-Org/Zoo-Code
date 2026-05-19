import type * as vscode from "vscode"

type VscodeWindowMock = Pick<typeof vscode.window, "showInformationMessage" | "showErrorMessage">

type VscodeEnvMock = Pick<typeof vscode.env, "openExternal">

type VscodeCommandsMock = Pick<typeof vscode.commands, "executeCommand">

export const window: VscodeWindowMock = {
	showInformationMessage: vi.fn(),
	showErrorMessage: vi.fn(),
}

export const env: VscodeEnvMock = {
	openExternal: vi.fn(),
}

export const Uri = {
	parse: vi.fn((uri: string) => ({ toString: () => uri })),
}

export const commands: VscodeCommandsMock = {
	executeCommand: vi.fn().mockResolvedValue(undefined),
}

export interface ExtensionContext {
	secrets: {
		get: (key: string) => Promise<string | undefined>
		store: (key: string, value: string) => Promise<void>
		delete: (key: string) => Promise<void>
		onDidChange: (listener: (e: { key: string }) => void) => {
			dispose: () => void
		}
	}
	globalState: {
		get: <T>(key: string) => T | undefined
		update: (key: string, value: unknown) => Promise<void>
	}
	subscriptions: unknown[]
	extension?: {
		packageJSON?: {
			version?: string
			publisher?: string
			name?: string
		}
	}
}

// Mock implementation for tests
export const mockExtensionContext: ExtensionContext = {
	secrets: {
		get: vi.fn().mockResolvedValue(undefined),
		store: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
		onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	globalState: {
		get: vi.fn().mockReturnValue(undefined),
		update: vi.fn().mockResolvedValue(undefined),
	},
	subscriptions: [],
	extension: {
		packageJSON: {
			version: "1.0.0",
			publisher: "RooVeterinaryInc",
			name: "roo-cline",
		},
	},
}
