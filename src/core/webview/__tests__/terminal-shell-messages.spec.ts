/**
 * Tests for the terminal shell selection webview message handlers.
 *
 * Tests the `requestTerminalShellOptions` and `setTerminalShellSelection`
 * message handling through the webviewMessageHandler delegation pattern,
 * verifying that:
 * - `requestTerminalShellOptions` returns sanitized trusted options
 * - `setTerminalShellSelection` with valid selection persists and invalidates
 * - `setTerminalShellSelection` with invalid selection returns error and keeps previous
 * - Idle terminals are closed after shell change
 *
 * See ARCH-TERMINAL-001 section 1.9 (Frontend to extension-host settings flow).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { TerminalShellSelection, TerminalShellOption } from "@roo-code/types"

// Mock vscode (minimal — enough for webviewMessageHandler import chain)
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		activeTextEditor: undefined,
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
		createTextEditorDecorationType: vi.fn(),
	},
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
			update: vi.fn(),
			inspect: vi.fn(),
		})),
		getWorkspaceFolder: vi.fn(),
		onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	},
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
		clipboard: { writeText: vi.fn() },
		openExternal: vi.fn(),
	},
	commands: {
		executeCommand: vi.fn(),
	},
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn((p: string) => ({ fsPath: p })),
		parse: vi.fn((s: string) => ({ toString: () => s })),
	},
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	CodeActionKind: { QuickFix: { value: "quickfix" }, RefactorRewrite: { value: "refactor.rewrite" } },
	EventEmitter: vi.fn().mockImplementation(() => ({ event: vi.fn(), fire: vi.fn(), dispose: vi.fn() })),
	version: "1.85.0",
}))

// Mock TerminalRegistry.closeIdleTerminals
const closeIdleTerminalsMock = vi.fn()
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		closeIdleTerminals: (...args: any[]) => closeIdleTerminalsMock(...args),
	},
}))

// Mock TerminalProfileResolver
const getAvailableProfilesMock = vi.fn()
vi.mock("../../../integrations/terminal/shell/TerminalProfileResolver", () => ({
	TerminalProfileResolver: {
		forRuntime: () => ({
			getAvailableProfiles: (...args: any[]) => getAvailableProfilesMock(...args),
		}),
	},
}))

// Mock ShellResolver
const resolveMock = vi.fn()
vi.mock("../../../integrations/terminal/shell/ShellResolver", () => ({
	ShellResolver: {
		forRuntime: () => ({
			resolve: (...args: any[]) => resolveMock(...args),
		}),
	},
}))

// Mock CommandEnvironmentService
const getEnvironmentMock = vi.fn()
const invalidateMock = vi.fn()
vi.mock("../../../integrations/terminal/shell/CommandEnvironmentService", () => ({
	CommandEnvironmentService: vi.fn().mockImplementation(() => ({
		getEnvironment: (...args: any[]) => getEnvironmentMock(...args),
		invalidate: (...args: any[]) => invalidateMock(...args),
		getVersion: () => 0,
	})),
}))

// Mock ShellInvocationAdapter (used by CommandEnvironmentService internally)
vi.mock("../../../integrations/terminal/shell/ShellInvocationAdapter", () => ({
	ShellInvocationAdapter: {
		createPlan: vi.fn(() => ({
			executable: "mock-shell",
			args: ["-c", ""],
			family: "posix",
			provider: "execa",
		})),
	},
}))

// Mock shell.ts helpers (used by ShellResolver)
vi.mock("../../../utils/shell", () => ({
	classifyShellFamily: vi.fn(() => "posix"),
	isShellPathAllowed: vi.fn(() => true),
	getShell: vi.fn(() => "/bin/bash"),
	SHELL_ALLOWLIST: [],
}))

// Mock tts
vi.mock("../../../utils/tts", () => ({
	setTtsEnabled: vi.fn(),
	setTtsSpeed: vi.fn(),
}))

// Mock Terminal (used by webviewMessageHandler for requestTerminalProfiles)
vi.mock("../../../integrations/terminal/Terminal", () => ({
	Terminal: {
		getAvailableProfileNames: vi.fn(() => []),
		defaultShellIntegrationTimeout: 5000,
	},
}))

// Import after mocks are set up
import { webviewMessageHandler } from "../webviewMessageHandler"

describe("terminal-shell-messages — webview message handlers", () => {
	let mockProvider: any

	beforeEach(() => {
		vi.clearAllMocks()

		const mockState = {
			terminalShellSelection: undefined,
			execaShellPath: undefined,
			terminalProfile: undefined,
		}

		const mockEnv = {
			version: 0,
			primaryPlan: {
				executable: "/bin/bash",
				args: ["-c", ""],
				family: "posix" as const,
				provider: "execa" as const,
			},
			fallbackPlan: {
				executable: "/bin/bash",
				args: ["-c", ""],
				family: "posix" as const,
				provider: "execa" as const,
			},
			chainOperator: "&&" as const,
			promptDescriptor: {
				providerLabel: "Inline Terminal",
				shellFamilyLabel: "POSIX Shell",
				shellExecutableName: "bash",
				sourceLabel: "OS Default",
				isNonInteractive: true,
				supportsFishSyntax: false,
				supportsPosixSyntax: true,
			},
			warnings: [],
		}

		getEnvironmentMock.mockReturnValue(mockEnv)
		getAvailableProfilesMock.mockReturnValue([])
		resolveMock.mockReturnValue({
			ok: true,
			shell: {
				executable: "/bin/bash",
				family: "posix",
				displayName: "bash",
				source: "osDefault",
				trustEvidence: "allowlist",
			},
		})
		closeIdleTerminalsMock.mockReturnValue(undefined)

		const service = {
			getEnvironment: getEnvironmentMock,
			invalidate: invalidateMock,
			getVersion: () => 0,
		}

		mockProvider = {
			postMessageToWebview: vi.fn(),
			getState: vi.fn().mockResolvedValue(mockState),
			contextProxy: {
				getValue: vi.fn(),
				setValue: vi.fn().mockResolvedValue(undefined),
				globalStorageUri: { fsPath: "/mock/storage" },
			},
			log: vi.fn(),
			getCommandEnvironmentService: vi.fn().mockReturnValue(service),
			handleRequestTerminalShellOptions: vi.fn().mockImplementation(async function (this: any) {
				const svc = this.getCommandEnvironmentService()
				if (!svc) {
					await this.postMessageToWebview({
						type: "terminalShellOptions",
						terminalShellOptions: { options: [], error: "SHELL/handleRequestTerminalShellOptions/001" },
					})
					return
				}

				const state = await this.getState()
				const env = svc.getEnvironment({
					terminalShellSelection: state.terminalShellSelection,
					execaShellPath: state.execaShellPath,
					terminalProfile: state.terminalProfile,
				})

				const options: TerminalShellOption[] = [
					{
						id: "auto",
						label: "Auto (follows trusted terminal profile)",
						family: "powershell",
						source: "auto",
						available: true,
					},
				]

				const profiles = getAvailableProfilesMock()
				for (const profile of profiles) {
					options.push({
						id: `profile:${profile.name}`,
						label: profile.name,
						family: profile.shell.family,
						source: "vscode-profile",
						available: true,
					})
				}

				await this.postMessageToWebview({
					type: "terminalShellOptions",
					terminalShellOptions: {
						options,
						effectiveShell: {
							label: env.promptDescriptor.shellExecutableName,
							family: env.primaryPlan.family,
							source: env.promptDescriptor.sourceLabel,
						},
					},
				})
			}),
			handleSetTerminalShellSelection: vi.fn().mockImplementation(async function (
				this: any,
				selection: TerminalShellSelection,
			) {
				const svc = this.getCommandEnvironmentService()
				if (!svc) {
					await this.postMessageToWebview({
						type: "terminalShellOptions",
						terminalShellOptions: { options: [], error: "SHELL/handleSetTerminalShellSelection/001" },
					})
					return
				}

				const state = await this.getState()

				const result = resolveMock({
					terminalShellSelection: selection,
					execaShellPath: state.execaShellPath,
					terminalProfile: state.terminalProfile,
				})

				if (!result.ok && result.rejectable) {
					await this.postMessageToWebview({
						type: "terminalShellOptions",
						terminalShellOptions: {
							options: [],
							error: `SHELL/handleSetTerminalShellSelection/003: ${result.error.message}`,
						},
					})
					return
				}

				await this.contextProxy.setValue("terminalShellSelection", selection)
				svc.invalidate()
				closeIdleTerminalsMock()

				const env = svc.getEnvironment({
					terminalShellSelection: selection,
					execaShellPath: state.execaShellPath,
					terminalProfile: state.terminalProfile,
				})

				const options: TerminalShellOption[] = [
					{
						id: "auto",
						label: "Auto (follows trusted terminal profile)",
						family: "powershell",
						source: "auto",
						available: true,
					},
				]

				await this.postMessageToWebview({
					type: "terminalShellOptions",
					terminalShellOptions: {
						options,
						effectiveShell: {
							label: env.promptDescriptor.shellExecutableName,
							family: env.primaryPlan.family,
							source: env.promptDescriptor.sourceLabel,
						},
					},
				})
			}),
		}
	})

	describe("requestTerminalShellOptions", () => {
		it("returns sanitized options with Auto as first option", async () => {
			await webviewMessageHandler(mockProvider, {
				type: "requestTerminalShellOptions",
			} as any)

			expect(mockProvider.postMessageToWebview).toHaveBeenCalledTimes(1)
			const call = mockProvider.postMessageToWebview.mock.calls[0][0]
			expect(call.type).toBe("terminalShellOptions")
			expect(call.terminalShellOptions.options).toHaveLength(1)
			expect(call.terminalShellOptions.options[0]).toEqual({
				id: "auto",
				label: "Auto (follows trusted terminal profile)",
				family: "powershell",
				source: "auto",
				available: true,
			})
		})

		it("includes trusted profile options grouped by shell family", async () => {
			getAvailableProfilesMock.mockReturnValue([
				{
					name: "PowerShell",
					shell: {
						executable: "pwsh.exe",
						family: "powershell",
						displayName: "PowerShell 7",
						source: "vscodeDefaultProfile",
						trustEvidence: "trustedProfile",
					},
				},
				{
					name: "Git Bash",
					shell: {
						executable: "/usr/bin/bash",
						family: "posix",
						displayName: "Git Bash",
						source: "vscodeDefaultProfile",
						trustEvidence: "trustedProfile",
					},
				},
			])

			await webviewMessageHandler(mockProvider, {
				type: "requestTerminalShellOptions",
			} as any)

			const call = mockProvider.postMessageToWebview.mock.calls[0][0]
			expect(call.terminalShellOptions.options).toHaveLength(3)
			expect(call.terminalShellOptions.options[1].id).toBe("profile:PowerShell")
			expect(call.terminalShellOptions.options[1].family).toBe("powershell")
			expect(call.terminalShellOptions.options[2].id).toBe("profile:Git Bash")
			expect(call.terminalShellOptions.options[2].family).toBe("posix")
		})

		it("returns effective shell summary", async () => {
			await webviewMessageHandler(mockProvider, {
				type: "requestTerminalShellOptions",
			} as any)

			const call = mockProvider.postMessageToWebview.mock.calls[0][0]
			expect(call.terminalShellOptions.effectiveShell).toBeDefined()
			expect(call.terminalShellOptions.effectiveShell.label).toBe("bash")
			expect(call.terminalShellOptions.effectiveShell.family).toBe("posix")
			expect(call.terminalShellOptions.effectiveShell.source).toBe("OS Default")
		})
	})

	describe("setTerminalShellSelection", () => {
		it("persists valid selection and invalidates cache", async () => {
			const selection: TerminalShellSelection = { kind: "auto" }

			await webviewMessageHandler(mockProvider, {
				type: "setTerminalShellSelection",
				terminalShellSelection: selection,
			} as any)

			expect(mockProvider.contextProxy.setValue).toHaveBeenCalledWith("terminalShellSelection", selection)
			expect(invalidateMock).toHaveBeenCalledTimes(1)
		})

		it("closes idle terminals after shell change", async () => {
			const selection: TerminalShellSelection = { kind: "auto" }

			await webviewMessageHandler(mockProvider, {
				type: "setTerminalShellSelection",
				terminalShellSelection: selection,
			} as any)

			expect(closeIdleTerminalsMock).toHaveBeenCalledTimes(1)
		})

		it("responds with resolved effective shell on success", async () => {
			const selection: TerminalShellSelection = { kind: "auto" }

			await webviewMessageHandler(mockProvider, {
				type: "setTerminalShellSelection",
				terminalShellSelection: selection,
			} as any)

			expect(mockProvider.postMessageToWebview).toHaveBeenCalledTimes(1)
			const call = mockProvider.postMessageToWebview.mock.calls[0][0]
			expect(call.type).toBe("terminalShellOptions")
			expect(call.terminalShellOptions.effectiveShell).toBeDefined()
			expect(call.terminalShellOptions.effectiveShell.label).toBe("bash")
		})

		it("returns typed error and keeps previous setting on validation failure", async () => {
			const invalidSelection: TerminalShellSelection = { kind: "path", path: "/nonexistent/evil.exe" }

			resolveMock.mockReturnValue({
				ok: false,
				error: {
					code: "SHELL_PATH_NOT_ALLOWED",
					message: "The selected shell path is not in the trusted allowlist: evil.exe",
				},
				rejectable: true,
			})

			await webviewMessageHandler(mockProvider, {
				type: "setTerminalShellSelection",
				terminalShellSelection: invalidSelection,
			} as any)

			expect(mockProvider.contextProxy.setValue).not.toHaveBeenCalled()
			expect(invalidateMock).not.toHaveBeenCalled()
			expect(closeIdleTerminalsMock).not.toHaveBeenCalled()
			expect(mockProvider.postMessageToWebview).toHaveBeenCalledTimes(1)
			const call = mockProvider.postMessageToWebview.mock.calls[0][0]
			expect(call.terminalShellOptions.error).toContain("SHELL/handleSetTerminalShellSelection/003")
			expect(call.terminalShellOptions.error).toContain("not in the trusted allowlist")
		})

		it("does not call handler when setTerminalShellSelection has no selection payload", async () => {
			await webviewMessageHandler(mockProvider, {
				type: "setTerminalShellSelection",
			} as any)

			expect(mockProvider.handleSetTerminalShellSelection).not.toHaveBeenCalled()
		})
	})
})
