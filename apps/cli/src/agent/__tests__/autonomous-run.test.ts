import { AUTONOMOUS_EXIT_CODES, AutonomousRunError, type AutonomousTerminalState } from "../autonomous-run.js"

describe("AutonomousRunError", () => {
	it("should create error with correct state and message", () => {
		const error = new AutonomousRunError("needs_input", "User input required")
		expect(error.state).toBe("needs_input")
		expect(error.message).toBe("User input required")
		expect(error.name).toBe("AutonomousRunError")
	})

	it("should support all terminal states except completed", () => {
		const states: Array<Exclude<AutonomousTerminalState, "completed">> = [
			"needs_input",
			"provider_failed",
			"tool_failed",
			"cancelled",
			"timed_out",
			"configuration_error",
			"crashed",
		]

		states.forEach((state) => {
			const error = new AutonomousRunError(state, `Test ${state}`)
			expect(error.state).toBe(state)
			expect(error.message).toBe(`Test ${state}`)
		})
	})

	it("should be instanceof Error", () => {
		const error = new AutonomousRunError("crashed", "Something went wrong")
		expect(error).toBeInstanceOf(Error)
		expect(error).toBeInstanceOf(AutonomousRunError)
	})
})

describe("AUTONOMOUS_EXIT_CODES", () => {
	it("should map completed to exit code 0", () => {
		expect(AUTONOMOUS_EXIT_CODES.completed).toBe(0)
	})

	it("should map needs_input to exit code 2", () => {
		expect(AUTONOMOUS_EXIT_CODES.needs_input).toBe(2)
	})

	it("should map provider_failed to exit code 4", () => {
		expect(AUTONOMOUS_EXIT_CODES.provider_failed).toBe(4)
	})

	it("should map tool_failed to exit code 5", () => {
		expect(AUTONOMOUS_EXIT_CODES.tool_failed).toBe(5)
	})

	it("should map cancelled to exit code 6", () => {
		expect(AUTONOMOUS_EXIT_CODES.cancelled).toBe(6)
	})

	it("should map timed_out to exit code 124", () => {
		expect(AUTONOMOUS_EXIT_CODES.timed_out).toBe(124)
	})

	it("should map configuration_error to exit code 78", () => {
		expect(AUTONOMOUS_EXIT_CODES.configuration_error).toBe(78)
	})

	it("should map crashed to exit code 70", () => {
		expect(AUTONOMOUS_EXIT_CODES.crashed).toBe(70)
	})

	it("should have mappings for all terminal states", () => {
		const expectedStates: AutonomousTerminalState[] = [
			"completed",
			"needs_input",
			"provider_failed",
			"tool_failed",
			"cancelled",
			"timed_out",
			"configuration_error",
			"crashed",
		]

		expectedStates.forEach((state) => {
			expect(AUTONOMOUS_EXIT_CODES[state]).toBeDefined()
			expect(typeof AUTONOMOUS_EXIT_CODES[state]).toBe("number")
		})
	})

	it("should use conventional exit codes", () => {
		// Exit code 0 = success
		expect(AUTONOMOUS_EXIT_CODES.completed).toBe(0)
		// Exit code 124 is conventional for timeout (from GNU timeout command)
		expect(AUTONOMOUS_EXIT_CODES.timed_out).toBe(124)
		// Exit code 78 is EX_CONFIG from sysexits.h
		expect(AUTONOMOUS_EXIT_CODES.configuration_error).toBe(78)
		// Exit code 70 is EX_SOFTWARE from sysexits.h
		expect(AUTONOMOUS_EXIT_CODES.crashed).toBe(70)
	})
})
