import { OutputManager } from "../output-manager.js"

describe("OutputManager hook compatibility", () => {
	it("suppresses structured hook rows", () => {
		const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream
		const stderr = { write: vi.fn() } as unknown as NodeJS.WriteStream
		const manager = new OutputManager({ stdout, stderr })

		manager.outputMessage({
			ts: 1,
			type: "say",
			say: "hook",
			hook: {
				hookRunId: "run-1",
				hookId: "hook-1",
				name: "Session hook",
				phase: "sessionStart",
				status: "failed",
				startedAt: 1,
				completedAt: 2,
				errorSummary: "must not print",
			},
		})

		expect(stdout.write).not.toHaveBeenCalled()
		expect(stderr.write).not.toHaveBeenCalled()
	})
})
