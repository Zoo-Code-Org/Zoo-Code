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

it.each(["upstream failure", "provider|failure", "error\nwith details"])(
	"preserves the caller message while PostHog normalizes %s",
	async (raw) => {
		const captureException = vi.fn()
		vi.mocked(PostHog).mockImplementation(function () {
			// The SDK double supplies only the methods used by this capture path.
			return { captureException, optIn: vi.fn() } as unknown as PostHog
		})
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: () => "all",
			// The configuration double supplies get for the telemetry preference.
		} as unknown as vscode.WorkspaceConfiguration)
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
