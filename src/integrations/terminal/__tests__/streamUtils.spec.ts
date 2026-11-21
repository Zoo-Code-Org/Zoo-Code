import { execSync } from "child_process"

import {
	createBashCommandStream,
	createCmdCommandStream,
	createPowerShellStream,
	getPlatform,
	isWindows,
	isPowerShellCoreAvailable,
} from "./streamUtils"
import { collectStream } from "../../../test-utils/stream"
import { clearAllMocks } from "../../../test-utils/reset"

vi.mock("child_process", () => ({ execSync: vi.fn() }))

beforeEach(() => {
	clearAllMocks()
})

const factories = [
	{ name: "bash", create: createBashCommandStream },
	{ name: "cmd", create: createCmdCommandStream },
	{ name: "PowerShell", create: createPowerShellStream },
]

describe.each(factories)("$name command stream", ({ name, create }) => {
	it("wraps successful output in terminal markers", async () => {
		vi.mocked(execSync).mockReturnValue("output\r\n")
		const { stream, exitCode } = create("echo output")
		expect(exitCode).toBe(0)
		expect(await collectStream(stream)).toEqual([
			"\x1b]633;C\x07",
			name === "PowerShell" ? "output\n" : "output\r\n",
			"\x1b]633;D\x07",
		])
	})

	it.each([
		{ status: 7, stdout: "partial output", stderr: "failure details", expected: 7 },
		{ status: 0, stdout: "", expected: 0 },
		{ status: null, expected: 1 },
	])("preserves failed command output and exit status: %j", async ({ expected, ...details }) => {
		vi.mocked(execSync).mockImplementation(() => {
			throw Object.assign(new Error("command failed"), details)
		})
		const { stream, exitCode } = create("failing command")
		expect(exitCode).toBe(expected)
		expect(await collectStream(stream)).toEqual([
			"\x1b]633;C\x07",
			...("stdout" in details && details.stdout ? [details.stdout] : []),
			"\x1b]633;D\x07",
		])
	})
})

it.each([
	{ signal: "SIGTERM", expected: 143 },
	{ signal: "SIGSEGV", expected: 139 },
	{ signal: "SIGUNKNOWN", expected: 1 },
])("maps bash termination signal $signal to $expected", ({ signal, expected }) => {
	vi.mocked(execSync).mockImplementation(() => {
		throw Object.assign(new Error("terminated"), { signal })
	})
	expect(createBashCommandStream("command").exitCode).toBe(expected)
})

it("reads platform and PowerShell availability from the test environment", () => {
	const original = global.__TEST_ENV__
	try {
		global.__TEST_ENV__ = undefined
		expect(getPlatform()).toBe(process.platform)
		expect(isPowerShellCoreAvailable()).toBe(false)
		global.__TEST_ENV__ = { platform: "win32", isPowerShellAvailable: true }
		expect(getPlatform()).toBe("win32")
		expect(isWindows()).toBe(true)
		expect(isPowerShellCoreAvailable()).toBe(true)
		global.__TEST_ENV__ = { platform: "linux", isPowerShellAvailable: false }
		expect(isWindows()).toBe(false)
		expect(isPowerShellCoreAvailable()).toBe(false)
	} finally {
		global.__TEST_ENV__ = original
	}
})
