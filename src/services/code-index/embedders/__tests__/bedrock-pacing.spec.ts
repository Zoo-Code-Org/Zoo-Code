import "../../__tests__/mock-code-index-log"
import { createServer } from "node:http2"
import { BedrockEmbedder } from "../bedrock"
import { pacedTransportWriter, waitForTransport } from "./paced-transport-writer"

vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("../../../../utils/networkProxy", () => ({ createProxyRoutingRequestHandler: () => undefined }))

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
	vi.spyOn(Math, "random").mockReturnValue(0)
})
afterEach(() => {
	vi.clearAllTimers()
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

it("paces four HTTP/2 throttles without exhaustion and then completes", async () => {
	let requests = 0
	const server = createServer()
	server.on("stream", (stream) => {
		requests++
		if (requests <= 4) {
			stream.respond({
				":status": 429,
				"content-type": "application/json",
				"x-amzn-errortype": "ThrottlingException",
			})
			stream.end(JSON.stringify({ message: "limited", __type: "ThrottlingException" }))
		} else {
			stream.respond({ ":status": 200, "content-type": "application/json" })
			stream.end(JSON.stringify({ embedding: [1, 0], inputTextTokenCount: 1 }))
		}
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	if (!address || typeof address === "string") throw new Error("Expected a TCP test listener")
	vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key")
	vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-key")
	vi.stubEnv("AWS_SESSION_TOKEN", "")
	vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", `http://127.0.0.1:${address.port}`)
	const embedder = new BedrockEmbedder("us-east-1")
	const controller = new AbortController()
	const { replace, failures, cache, pacers } = pacedTransportWriter()
	const pending = replace(embedder, controller.signal).catch((error: unknown) => error)
	try {
		for (const [index, delay] of [500, 1000, 2000, 4000].entries()) {
			await waitForTransport(() => {
				expect(requests).toBe(index + 1)
				expect(pacers.get(embedder.rateLimitScope).state().pausedUntil).toBe(Date.now() + delay)
				expect(pacers.waitingPaths()).toEqual(["test.ts"])
			})
			expect(failures.list()).toEqual([])
			vi.advanceTimersByTime(delay - 1)
			expect(requests).toBe(index + 1)
			vi.advanceTimersByTime(1)
		}
		await pending
		expect(requests).toBe(5)
		expect(failures.list()).toEqual([])
		expect(cache.completeFile).toHaveBeenCalledOnce()
	} finally {
		controller.abort()
		await pending
		embedder["bedrockClient"].destroy()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
})
