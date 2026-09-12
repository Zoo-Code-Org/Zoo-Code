import os from "os"

// Mock the modules - must be hoisted before imports
vi.mock("os-name", () => ({
	default: vi.fn(),
}))

vi.mock("../../../../utils/shell", () => ({
	getShell: vi.fn(() => "/bin/bash"),
}))

import { getSystemInfoSection } from "../system-info"
import osName from "os-name"

const mockOsName = osName as unknown as ReturnType<typeof vi.fn>

describe("getSystemInfoSection", () => {
	const mockCwd = "/test/workspace"
	const mockHomeDir = "/home/user"

	beforeEach(() => {
		vi.spyOn(os, "homedir").mockReturnValue(mockHomeDir)
		vi.spyOn(os, "platform").mockReturnValue("linux" as any)
		vi.spyOn(os, "release").mockReturnValue("5.15.0")
	})

	/** Minimal policy with execute_command present (the default case these tests exercise). */
	const policyFor = (hasExecuteCommand: boolean = true) => ({
		tools: new Set(hasExecuteCommand ? ["execute_command"] : []),
		hasMcpGroup: false,
		hasMcpTools: false,
		hasMcpResources: false,
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("should return system info with os-name when available", () => {
		mockOsName.mockReturnValue("Ubuntu 22.04")

		const result = getSystemInfoSection(mockCwd, policyFor())

		expect(result).toContain("Operating System: Ubuntu 22.04")
		expect(result).toContain("Default Shell: /bin/bash")
		expect(result).toContain(`Home Directory: ${mockHomeDir}`)
		expect(result).toContain(`Current Workspace Directory: ${mockCwd}`)
	})

	it("should fallback to platform and release when os-name throws error", () => {
		mockOsName.mockImplementation(() => {
			throw new Error("Command failed with ENOENT: powershell")
		})

		const result = getSystemInfoSection(mockCwd, policyFor())

		expect(result).toContain("Operating System: linux 5.15.0")
		expect(result).toContain("Default Shell: /bin/bash")
		expect(result).toContain(`Home Directory: ${mockHomeDir}`)
		expect(result).toContain(`Current Workspace Directory: ${mockCwd}`)
	})

	it("should handle Windows platform in fallback", () => {
		mockOsName.mockImplementation(() => {
			throw new Error("Command failed with ENOENT: powershell")
		})
		vi.spyOn(os, "platform").mockReturnValue("win32" as any)
		vi.spyOn(os, "release").mockReturnValue("10.0.19043")

		const result = getSystemInfoSection(mockCwd, policyFor())

		expect(result).toContain("Operating System: win32 10.0.19043")
	})

	it("omits the terminal sentence when execute_command is absent", () => {
		mockOsName.mockReturnValue("Ubuntu 22.04")

		const result = getSystemInfoSection(mockCwd, policyFor(false))

		expect(result).not.toContain("New terminals will be created")
	})

	it("includes the full terminal working-directory sentence when execute_command is present", () => {
		mockOsName.mockReturnValue("Ubuntu 22.04")

		const result = getSystemInfoSection(mockCwd, policyFor(true))

		// Exact substring of the execute_command-gated sentence; also proves the
		// `execute_command` lookup itself is not mutated away.
		expect(result).toContain(
			"New terminals will be created in the current workspace directory, however if you change directories in a terminal it will then have a different working directory; changing directories in a terminal does not modify the workspace directory, because you do not have access to change the workspace directory.",
		)
	})

	it("joins the workspace sentence directly to the next sentence when execute_command is absent", () => {
		mockOsName.mockReturnValue("Ubuntu 22.04")

		const result = getSystemInfoSection(mockCwd, policyFor(false))

		// The false branch must stay empty: any injected filler (e.g. a mutated
		// sentinel string) breaks this exact join.
		expect(result).toContain("default directory for all tool operations. When the user initially gives you a task")
	})
})
