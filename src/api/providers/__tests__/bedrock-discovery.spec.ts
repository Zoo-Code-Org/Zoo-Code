import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	send: vi.fn(),
	sendOptions: [] as Array<{ abortSignal?: AbortSignal } | undefined>,
}))

vi.mock("@aws-sdk/client-bedrock", () => {
	class BedrockClient {
		send(command: unknown, options?: { abortSignal?: AbortSignal }) {
			mocks.sendOptions.push(options)
			return mocks.send(command, options)
		}
	}

	class ListFoundationModelsCommand {
		constructor(public readonly input: unknown) {}
	}

	class ListInferenceProfilesCommand {
		constructor(public readonly input: unknown) {}
	}

	return {
		BedrockClient,
		ListFoundationModelsCommand,
		ListInferenceProfilesCommand,
	}
})

import { BEDROCK_DISCOVERY_TIMEOUT_MS, discoverBedrockTargets } from "../bedrock-discovery"

describe("discoverBedrockTargets", () => {
	beforeEach(() => {
		mocks.send.mockReset()
		mocks.sendOptions.length = 0
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("times out and aborts slow AWS discovery calls", async () => {
		vi.useFakeTimers()
		mocks.send.mockImplementation(() => new Promise(() => {}))

		const promise = expect(
			discoverBedrockTargets({
				awsRegion: "us-west-2",
				awsAccessKey: "AKIA",
				awsSecretKey: "secret",
			}),
		).rejects.toThrow(/Bedrock discovery timed out/)

		await vi.advanceTimersByTimeAsync(BEDROCK_DISCOVERY_TIMEOUT_MS)

		await promise
		expect(mocks.sendOptions).toHaveLength(2)
		expect(mocks.sendOptions.every((options) => options?.abortSignal?.aborted)).toBe(true)
	})
})
