import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { TelemetryEventName } from "@roo-code/types"
import { PostHogTelemetryClient } from "../PostHogTelemetryClient"
import { hashDistinctId } from "../distinct-id"

const sink = vi.hoisted(() => ({ capture: vi.fn(), captureException: vi.fn(), optIn: vi.fn(), optOut: vi.fn() }))
vi.mock("posthog-node", () => ({
	PostHog: class {
		capture = sink.capture
		captureException = sink.captureException
		optIn = sink.optIn
		optOut = sink.optOut
	},
}))
vi.mock("vscode", () => ({
	env: {
		get machineId() {
			return "test-machine-id"
		},
	},
	workspace: { getConfiguration: () => ({ get: () => "all" }) },
}))

// Device IDs include UUIDs, unavailable-ID sentinels, Unicode, and generated opaque strings.
const ids = [
	"",
	"someValue.machineId",
	"01234567-89ab-cdef-0123-456789abcdef",
	"机器-id",
	...Array.from({ length: 32 }, (_, i) => "device-" + i.toString(16).repeat(i + 1)),
]

describe("analytics identity boundary", () => {
	it.each(ids)("projects %j at both host sinks", async (raw) => {
		vi.clearAllMocks()
		vi.spyOn(vscode.env, "machineId", "get").mockReturnValue(raw)
		const client = new PostHogTelemetryClient()
		client.updateTelemetryState(true)
		await client.capture({ event: TelemetryEventName.TASK_CREATED })
		await client.captureException(new Error("Unexpected index failure"))
		const expected = createHash("sha256").update(`zoo-code-telemetry-distinct-id-v1:${raw}`).digest("hex")
		expect(hashDistinctId(raw)).toBe(expected)
		expect(hashDistinctId(raw)).toBe(hashDistinctId(raw))
		expect(expected).not.toBe(raw)
		expect(sink.capture).toHaveBeenCalledWith(expect.objectContaining({ distinctId: expected }))
		expect(sink.captureException).toHaveBeenCalledWith(expect.any(Error), expected, expect.anything())
	})
})
