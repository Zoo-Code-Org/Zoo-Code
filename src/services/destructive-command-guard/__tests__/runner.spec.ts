import { EventEmitter } from "events"
import { PassThrough } from "stream"

import { spawn } from "child_process"

import { DCG_MAX_OUTPUT_BYTES } from "../constants"
import { runDcg } from "../runner"

vi.mock("child_process", () => ({ spawn: vi.fn() }))

type MockChild = EventEmitter & {
	stdout: PassThrough
	stderr: PassThrough
	kill: ReturnType<typeof vi.fn>
}

const mockSpawn = vi.mocked(spawn)

const useChild = (child: MockChild): void => {
	// runDcg uses only the event, stream, and kill subset supplied by this test double.
	mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>)
}

function createChild(): MockChild {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	})
}

function emitResult(child: MockChild, payload: unknown, code: number): void {
	child.stdout.write(JSON.stringify(payload))
	child.emit("close", code, null)
}

describe("runDcg", () => {
	beforeEach(() => {
		vi.useRealTimers()
		mockSpawn.mockReset()
	})

	afterEach(() => vi.useRealTimers())

	it.each([
		[{ schema_version: 1, decision: "allow" }, 0, { decision: "allow" }],
		[
			{ schema_version: 2, decision: "deny", reason: "unsafe", rule_id: "delete" },
			1,
			{ decision: "deny", reason: "unsafe", ruleId: "delete" },
		],
		[
			{ schema_version: 2, decision: "deny", pack_id: "core", pattern_name: "delete" },
			1,
			{ decision: "deny", ruleId: "core:delete" },
		],
	])("accepts valid DCG result %#", async (payload, code, expected) => {
		const child = createChild()
		useChild(child)

		const result = runDcg("/dcg", "echo test", "/workspace")
		emitResult(child, payload, code)

		await expect(result).resolves.toEqual(expected)
	})

	it.each([
		["not json", 0, "DCG returned invalid JSON"],
		[JSON.stringify({ schema_version: 3, decision: "allow" }), 0, "DCG returned an unsupported response schema"],
		[JSON.stringify({ schema_version: 1, decision: "deny" }), 0, "DCG decision did not match its exit status"],
	])("rejects invalid output %#", async (output, code, message) => {
		const child = createChild()
		useChild(child)

		const result = runDcg("/dcg", "echo test", "/workspace")
		child.stdout.write(output)
		child.emit("close", code, null)

		await expect(result).rejects.toThrow(message)
	})

	it("rejects non-DCG exit statuses with stderr", async () => {
		const child = createChild()
		useChild(child)

		const result = runDcg("/dcg", "echo test", "/workspace")
		child.stderr.write("failure details")
		child.emit("close", 2, null)

		await expect(result).rejects.toThrow("DCG evaluation failed: failure details")
	})

	it("rejects process startup errors", async () => {
		const child = createChild()
		useChild(child)

		const result = runDcg("/dcg", "echo test", "/workspace")
		child.emit("error", new Error("ENOENT"))

		await expect(result).rejects.toThrow("Unable to start DCG: ENOENT")
	})

	it("rejects excessive output and kills the process", async () => {
		const child = createChild()
		useChild(child)

		const result = runDcg("/dcg", "echo test", "/workspace")
		child.stdout.write(Buffer.alloc(DCG_MAX_OUTPUT_BYTES + 1))

		await expect(result).rejects.toThrow("DCG produced too much output")
		expect(child.kill).toHaveBeenCalledWith("SIGKILL")
	})

	it("times out and kills the process", async () => {
		vi.useFakeTimers()
		const child = createChild()
		useChild(child)

		const result = runDcg("/dcg", "echo test", "/workspace")
		const rejection = expect(result).rejects.toThrow("DCG evaluation timed out")
		await vi.runAllTimersAsync()

		await rejection
		expect(child.kill).toHaveBeenCalledWith("SIGKILL")
	})
})
