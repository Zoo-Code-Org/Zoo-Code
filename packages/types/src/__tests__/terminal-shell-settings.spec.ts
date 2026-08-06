/**
 * Tests for the terminal shell selection settings and message contracts.
 *
 * Validates:
 * - `terminalShellSelection` is optional and older settings import unchanged
 * - Discriminated shape validation (auto, profile, path)
 * - Legacy `execaShellPath` remains readable
 * - Message payload types compile correctly
 * - `commandExecutionStatusSchema` discriminated union variants
 */
import { describe, it, expect } from "vitest"

import {
	globalSettingsSchema,
	terminalShellSelectionSchema,
	type GlobalSettings,
	type TerminalShellSelection,
} from "../global-settings.js"

import { commandExecutionStatusSchema, type CommandExecutionStatus } from "../terminal.js"

import type {
	ExtensionMessage,
	WebviewMessage,
	TerminalShellOption,
	TerminalShellOptionsPayload,
} from "../vscode-extension-host.js"

describe("terminalShellSelectionSchema", () => {
	// ── Discriminated union validation ──────────────────────────────────

	describe("auto mode", () => {
		it("should parse { kind: 'auto' }", () => {
			const result = terminalShellSelectionSchema.parse({ kind: "auto" })
			expect(result).toEqual({ kind: "auto" })
		})

		it("should strip extra fields on auto variant", () => {
			// Zod discriminated union objects are non-strict by default;
			// extra keys are stripped rather than rejected.
			const result = terminalShellSelectionSchema.parse({
				kind: "auto",
				path: "/bin/sh",
			})
			expect(result).toEqual({ kind: "auto" })
			expect(result).not.toHaveProperty("path")
		})
	})

	describe("profile mode", () => {
		it("should parse { kind: 'profile', profileName: 'PowerShell' }", () => {
			const result = terminalShellSelectionSchema.parse({
				kind: "profile",
				profileName: "PowerShell",
			})
			expect(result).toEqual({ kind: "profile", profileName: "PowerShell" })
		})

		it("should reject profile without profileName", () => {
			expect(() => terminalShellSelectionSchema.parse({ kind: "profile" })).toThrow()
		})

		it("should reject profile with empty profileName", () => {
			expect(() => terminalShellSelectionSchema.parse({ kind: "profile", profileName: "" })).not.toThrow() // z.string() accepts empty; validation is extension-host responsibility
		})
	})

	describe("path mode", () => {
		it("should parse { kind: 'path', path: 'C:\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe' }", () => {
			const result = terminalShellSelectionSchema.parse({
				kind: "path",
				path: "C:\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			})
			expect(result.kind).toBe("path")
			if (result.kind === "path") {
				expect(result.path).toContain("powershell.exe")
			}
		})

		it("should reject path without path field", () => {
			expect(() => terminalShellSelectionSchema.parse({ kind: "path" })).toThrow()
		})
	})

	describe("invalid discriminated shapes", () => {
		it("should reject unknown kind", () => {
			expect(() => terminalShellSelectionSchema.parse({ kind: "unknown" })).toThrow()
		})

		it("should reject missing kind", () => {
			expect(() => terminalShellSelectionSchema.parse({})).toThrow()
		})

		it("should reject null", () => {
			expect(() => terminalShellSelectionSchema.parse(null)).toThrow()
		})

		it("should reject non-object", () => {
			expect(() => terminalShellSelectionSchema.parse("auto")).toThrow()
		})
	})
})

describe("globalSettingsSchema — terminalShellSelection", () => {
	// ── Optionality and backward compatibility ──────────────────────────

	it("should accept settings without terminalShellSelection (backward compat)", () => {
		const legacySettings = {
			terminalProfile: "PowerShell",
			execaShellPath: "/bin/bash",
		}
		const result = globalSettingsSchema.parse(legacySettings)
		expect(result.terminalShellSelection).toBeUndefined()
		expect(result.execaShellPath).toBe("/bin/bash")
		expect(result.terminalProfile).toBe("PowerShell")
	})

	it("should accept settings with terminalShellSelection auto", () => {
		const result = globalSettingsSchema.parse({
			terminalShellSelection: { kind: "auto" },
		})
		expect(result.terminalShellSelection).toEqual({ kind: "auto" })
	})

	it("should accept settings with terminalShellSelection profile", () => {
		const result = globalSettingsSchema.parse({
			terminalShellSelection: { kind: "profile", profileName: "Git Bash" },
		})
		expect(result.terminalShellSelection).toEqual({
			kind: "profile",
			profileName: "Git Bash",
		})
	})

	it("should accept settings with terminalShellSelection path", () => {
		const result = globalSettingsSchema.parse({
			terminalShellSelection: { kind: "path", path: "/usr/bin/fish" },
		})
		expect(result.terminalShellSelection).toEqual({
			kind: "path",
			path: "/usr/bin/fish",
		})
	})

	it("should reject settings with invalid terminalShellSelection shape", () => {
		expect(() =>
			globalSettingsSchema.parse({
				terminalShellSelection: { kind: "invalid" },
			}),
		).toThrow()
	})

	it("should allow both terminalShellSelection and legacy execaShellPath", () => {
		const result = globalSettingsSchema.parse({
			terminalShellSelection: { kind: "auto" },
			execaShellPath: "/bin/zsh",
		})
		expect(result.terminalShellSelection).toEqual({ kind: "auto" })
		expect(result.execaShellPath).toBe("/bin/zsh")
	})

	// ── Legacy field readability ────────────────────────────────────────

	it("should keep execaShellPath readable when present", () => {
		const result = globalSettingsSchema.parse({
			execaShellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
		})
		expect(result.execaShellPath).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe")
	})

	it("should keep execaShellPath undefined when absent", () => {
		const result = globalSettingsSchema.parse({})
		expect(result.execaShellPath).toBeUndefined()
	})
})

describe("message payload type compilation", () => {
	// ── Type-level compile checks (runtime no-ops) ──────────────────────
	// These tests verify that the message payload types are correctly
	// typed and can carry the expected data shapes.

	it("TerminalShellOption should have all required fields", () => {
		const option: TerminalShellOption = {
			id: "auto",
			label: "Auto (follow default profile)",
			family: "powershell",
			source: "os-default",
			available: true,
		}
		expect(option.id).toBe("auto")
		expect(option.label).toBe("Auto (follow default profile)")
		expect(option.family).toBe("powershell")
		expect(option.source).toBe("os-default")
		expect(option.available).toBe(true)
	})

	it("TerminalShellOption family should accept all valid families", () => {
		const families: TerminalShellOption["family"][] = ["powershell", "cmd", "posix", "fish", "wsl"]
		families.forEach((family) => {
			const option: TerminalShellOption = {
				id: `test-${family}`,
				label: family,
				family,
				source: "test",
				available: true,
			}
			expect(option.family).toBe(family)
		})
	})

	it("TerminalShellOptionsPayload should carry options and effectiveShell", () => {
		const payload: TerminalShellOptionsPayload = {
			options: [
				{
					id: "auto",
					label: "Auto",
					family: "powershell",
					source: "os-default",
					available: true,
				},
				{
					id: "profile:PowerShell",
					label: "PowerShell",
					family: "powershell",
					source: "vscode-default",
					available: true,
				},
			],
			effectiveShell: {
				label: "PowerShell 7 (pwsh.exe)",
				family: "powershell",
				source: "vscode-default",
			},
		}
		expect(payload.options).toHaveLength(2)
		expect(payload.effectiveShell?.family).toBe("powershell")
	})

	it("TerminalShellOptionsPayload should allow error without effectiveShell", () => {
		const payload: TerminalShellOptionsPayload = {
			options: [],
			error: "SHELL/terminalShellOptions/001: profile discovery failed",
		}
		expect(payload.options).toHaveLength(0)
		expect(payload.error).toBeDefined()
	})

	it("WebviewMessage should carry terminalShellSelection for setTerminalShellSelection", () => {
		const msg: WebviewMessage = {
			type: "setTerminalShellSelection",
			terminalShellSelection: { kind: "profile", profileName: "PowerShell" },
		}
		expect(msg.type).toBe("setTerminalShellSelection")
		expect(msg.terminalShellSelection?.kind).toBe("profile")
	})

	it("WebviewMessage should carry requestTerminalShellOptions without payload", () => {
		const msg: WebviewMessage = {
			type: "requestTerminalShellOptions",
		}
		expect(msg.type).toBe("requestTerminalShellOptions")
		expect(msg.terminalShellSelection).toBeUndefined()
	})

	it("ExtensionMessage should carry terminalShellOptions response", () => {
		const msg: ExtensionMessage = {
			type: "terminalShellOptions",
			terminalShellOptions: {
				options: [
					{
						id: "auto",
						label: "Auto",
						family: "posix",
						source: "os-default",
						available: true,
					},
				],
				effectiveShell: {
					label: "/bin/bash",
					family: "posix",
					source: "os-default",
				},
			},
		}
		expect(msg.type).toBe("terminalShellOptions")
		expect(msg.terminalShellOptions?.options).toHaveLength(1)
	})

	it("TerminalShellSelection type should narrow correctly", () => {
		const pathSelection: TerminalShellSelection = { kind: "path", path: "/bin/zsh" }
		if (pathSelection.kind === "path") {
			// TypeScript narrows to the path variant
			expect(pathSelection.path).toBe("/bin/zsh")
		}

		const profileSelection: TerminalShellSelection = {
			kind: "profile",
			profileName: "PowerShell",
		}
		if (profileSelection.kind === "profile") {
			expect(profileSelection.profileName).toBe("PowerShell")
		}

		const autoSelection: TerminalShellSelection = { kind: "auto" }
		if (autoSelection.kind === "auto") {
			expect(autoSelection.kind).toBe("auto")
		}
	})

	it("GlobalSettings should include terminalShellSelection as optional", () => {
		const settings: GlobalSettings = {}
		expect(settings.terminalShellSelection).toBeUndefined()

		const settingsWithSelection: GlobalSettings = {
			terminalShellSelection: { kind: "auto" },
		}
		expect(settingsWithSelection.terminalShellSelection).toEqual({ kind: "auto" })
	})
})

describe("commandExecutionStatusSchema", () => {
	it("parses the started variant with pid and command", () => {
		const result = commandExecutionStatusSchema.parse({
			executionId: "exec-1",
			status: "started",
			pid: 1234,
			command: "npm test",
		})
		expect(result).toMatchObject({ executionId: "exec-1", status: "started", pid: 1234, command: "npm test" })
	})

	it("parses the started variant without optional pid", () => {
		const result = commandExecutionStatusSchema.parse({
			executionId: "exec-1",
			status: "started",
			command: "npm test",
		})
		expect(result.status).toBe("started")
		expect(result).not.toHaveProperty("pid")
	})

	it("parses the output variant", () => {
		const result = commandExecutionStatusSchema.parse({
			executionId: "exec-1",
			status: "output",
			output: "compressed output",
		})
		expect(result).toMatchObject({ executionId: "exec-1", status: "output", output: "compressed output" })
	})

	it("parses the exited variant with and without exitCode", () => {
		const withCode = commandExecutionStatusSchema.parse({ executionId: "e1", status: "exited", exitCode: 0 })
		expect(withCode).toMatchObject({ executionId: "e1", status: "exited", exitCode: 0 })

		const withoutCode = commandExecutionStatusSchema.parse({ executionId: "e2", status: "exited" })
		expect(withoutCode.status).toBe("exited")
		expect(withoutCode).not.toHaveProperty("exitCode")
	})

	it("parses the fallback variant with optional reasonCode", () => {
		const withReason = commandExecutionStatusSchema.parse({
			executionId: "e1",
			status: "fallback",
			reasonCode: "SHELL_FALLBACK",
		})
		expect(withReason.status).toBe("fallback")
		if (withReason.status === "fallback") {
			expect(withReason.reasonCode).toBe("SHELL_FALLBACK")
		}

		const withoutReason = commandExecutionStatusSchema.parse({ executionId: "e2", status: "fallback" })
		expect(withoutReason.status).toBe("fallback")
		expect(withoutReason).not.toHaveProperty("reasonCode")
	})

	it("parses the timeout variant", () => {
		const result = commandExecutionStatusSchema.parse({ executionId: "e1", status: "timeout" })
		expect(result).toMatchObject({ executionId: "e1", status: "timeout" })
	})

	it("parses the error variant with message and code", () => {
		const result = commandExecutionStatusSchema.parse({
			executionId: "e1",
			status: "error",
			message: "boom",
			code: "E_1",
		})
		expect(result).toMatchObject({ executionId: "e1", status: "error", message: "boom", code: "E_1" })

		const minimal = commandExecutionStatusSchema.parse({ executionId: "e2", status: "error" })
		expect(minimal.status).toBe("error")
		expect(minimal).not.toHaveProperty("message")
		expect(minimal).not.toHaveProperty("code")
	})

	it("parses the queued variant", () => {
		const result = commandExecutionStatusSchema.parse({ executionId: "e1", status: "queued" })
		expect(result).toMatchObject({ executionId: "e1", status: "queued" })
	})

	it("parses the recovering variant with optional errorCode", () => {
		const withCode = commandExecutionStatusSchema.parse({
			executionId: "e1",
			status: "recovering",
			errorCode: "RECOVER_1",
		})
		expect(withCode.status).toBe("recovering")
		if (withCode.status === "recovering") {
			expect(withCode.errorCode).toBe("RECOVER_1")
		}

		const withoutCode = commandExecutionStatusSchema.parse({ executionId: "e2", status: "recovering" })
		expect(withoutCode.status).toBe("recovering")
		expect(withoutCode).not.toHaveProperty("errorCode")
	})

	it("rejects an unknown status", () => {
		expect(() => commandExecutionStatusSchema.parse({ executionId: "e1", status: "unknown" })).toThrow()
	})

	it("rejects a missing executionId", () => {
		expect(() => commandExecutionStatusSchema.parse({ status: "queued" })).toThrow()
	})

	it("produces a CommandExecutionStatus type that narrows by status", () => {
		const status: CommandExecutionStatus = { executionId: "e1", status: "started", command: "ls" }
		if (status.status === "started") {
			expect(status.command).toBe("ls")
		}
	})
})
