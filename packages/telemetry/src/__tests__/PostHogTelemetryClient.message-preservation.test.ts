import * as vscode from "vscode"
import { PostHog } from "posthog-node"
import { ApiProviderError } from "@roo-code/types"
import { PostHogTelemetryClient } from "../PostHogTelemetryClient"
import { TelemetryService } from "../TelemetryService"

vi.mock("posthog-node")
vi.mock("vscode", () => ({
	env: { machineId: "test" },
	workspace: { getConfiguration: vi.fn() },
}))

const captureException = vi.fn<(error: Error) => void>()

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(PostHog).mockImplementation(function () {
		// The SDK double supplies only the methods used by this capture path.
		return { captureException, optIn: vi.fn() } as unknown as PostHog
	})
	vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
		get: () => "all",
		// The configuration double supplies get for the telemetry preference.
	} as unknown as vscode.WorkspaceConfiguration)
})

it.each(["upstream failure", "provider|failure", "error\nwith details"])(
	"preserves the caller message while PostHog normalizes %s",
	async (raw) => {
		const client = new PostHogTelemetryClient()
		client.updateTelemetryState(true)
		const service = new TelemetryService([client])
		const message = `OpenRouter API Error 500: ${raw}`
		const error = Object.assign(new ApiProviderError(message, "openrouter", "model", "createMessage", 500), {
			status: 500,
			error: { message: raw },
		})
		service.captureException(error)
		expect(error.message).toBe(message)
		service.captureException(error)
		expect(captureException).toHaveBeenCalledTimes(1)
		expect(captureException.mock.calls[0][0]).not.toBe(error)
		expect(captureException.mock.calls[0][0]).toMatchObject({ message: raw, stack: error.stack })
	},
)

const errorKinds = [
	{ name: "Error", create: (message: string) => new Error(message) },
	{ name: "TypeError", create: (message: string) => new TypeError(message) },
	{ name: "RangeError", create: (message: string) => new RangeError(message) },
	{
		name: "AggregateError",
		create: (message: string) => new AggregateError([new TypeError("child failure")], message),
	},
]

// SourceShape: normalization preserves the source type, stack, cause, and aggregate children.
describe.each(errorKinds)("$name", ({ create }) => {
	it.each(["upstream failure", "provider|failure", "error\nwith details"])(
		"preserves the error shape while normalizing %s",
		async (raw) => {
			const client = new PostHogTelemetryClient()
			client.updateTelemetryState(true)
			const message = `Provider API Error 500: ${raw}`
			const cause = new Error("original cause")
			const error = Object.assign(create(message), {
				cause,
				status: 500,
				error: { metadata: { raw } },
			})
			const stack = error.stack

			await client.captureException(error)

			expect(error.message).toBe(message)
			expect(error.stack).toBe(stack)
			expect(captureException).toHaveBeenCalledTimes(1)
			const sent = captureException.mock.calls[0][0]
			expect(sent).not.toBe(error)
			expect(Object.getPrototypeOf(sent)).toBe(Object.getPrototypeOf(error))
			expect(sent.name).toBe(error.name)
			expect(sent.message).toBe(raw)
			expect(sent.stack).toBe(stack)
			expect(sent.cause).toBe(cause)
			if (error instanceof AggregateError) {
				expect(sent).toBeInstanceOf(AggregateError)
				if (!(sent instanceof AggregateError)) throw new Error("AggregateError prototype was lost")
				expect(sent.errors).toBe(error.errors)
			}
		},
	)
})
