// npx vitest run src/integrations/terminal/__tests__/ExecaTerminal.spec.ts

import { RooTerminalCallbacks } from "../types"
import { ExecaTerminal } from "../ExecaTerminal"
import { ExecaTerminalProcess } from "../ExecaTerminalProcess"

describe("ExecaTerminal", () => {
	it("rejects the command promise when process startup rejects", async () => {
		const startupError = new Error("execa startup failed")
		const runSpy = vi.spyOn(ExecaTerminalProcess.prototype, "run").mockRejectedValueOnce(startupError)
		const terminal = new ExecaTerminal(1, "/tmp")

		const commandPromise = terminal.runCommand("echo test", {
			onLine: vi.fn(),
			onCompleted: vi.fn(),
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
		})

		await expect(commandPromise).rejects.toThrow("execa startup failed")
		expect(runSpy).toHaveBeenCalledWith("echo test")
		runSpy.mockRestore()
	})

	it("should run terminal commands and collect output", async () => {
		// TODO: Run the equivalent test for Windows.
		if (process.platform === "win32") {
			return
		}

		const terminal = new ExecaTerminal(1, "/tmp")
		let result

		const callbacks: RooTerminalCallbacks = {
			onLine: vi.fn(),
			onCompleted: (output) => {
				result = output
			},
			onShellExecutionStarted: vi.fn(),
			onShellExecutionComplete: vi.fn(),
		}

		const subprocess = terminal.runCommand("ls -al", callbacks)
		await subprocess

		expect(callbacks.onLine).toHaveBeenCalled()
		expect(callbacks.onShellExecutionStarted).toHaveBeenCalled()
		expect(callbacks.onShellExecutionComplete).toHaveBeenCalled()

		expect(result).toBeTypeOf("string")
		expect(result).toContain("total")
	})
})
