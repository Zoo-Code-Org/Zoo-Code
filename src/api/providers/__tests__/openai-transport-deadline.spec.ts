// npx vitest run api/providers/__tests__/openai-transport-deadline.spec.ts
//
// Transport-level proof for the request deadline dispatcher: behind an
// OpenAI-compatible handler, the undici idle deadlines (headers/body) must
// follow apiRequestTimeout instead of undici's hidden 300s defaults that
// drop long requests with "TypeError: terminated" (issue #1407).
// Local servers only; no external network.

import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { setTimeout as delay } from "node:timers/promises"

import nock from "nock"

import { OpenAiHandler } from "../openai"
import type { ApiHandlerOptions } from "../../../shared/api"

vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn(),
}))

import { getApiRequestTimeout } from "../utils/timeout-config"
import { clearAllMocks } from "../../../test-utils/reset"

const SERVER_DELAY_MS = 2500
const BODY_GAP_MS = 2500
const TIGHT_DEADLINE_MS = 300
const GENEROUS_DEADLINE_MS = 8000

const servers: http.Server[] = []

beforeAll(() => {
	// Local servers only: the net-connect guard documents the
	// no-external-network intent for the requests below.
	nock.enableNetConnect("127.0.0.1")
})

afterAll(async () => {
	for (const server of servers) {
		server.closeAllConnections()
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}
	nock.disableNetConnect()
})

function listen(server: http.Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
	})
}

function startServer(behavior: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<number> {
	const server = http.createServer(behavior)
	servers.push(server)
	return listen(server)
}

function sseChunk(content: string): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-deadline",
		object: "chat.completion.chunk",
		created: 1700000000,
		model: "gpt-4",
		choices: [{ index: 0, delta: { content }, finish_reason: null }],
	})}\n\n`
}

function makeHandler(baseUrl: string): OpenAiHandler {
	const options: ApiHandlerOptions = {
		apiModelId: "gpt-4",
		openAiModelId: "gpt-4",
		openAiBaseUrl: baseUrl,
		openAiApiKey: "test-key-local-only",
	}
	return new OpenAiHandler(options)
}

describe("OpenAI transport honors the configured request deadline", () => {
	beforeEach(() => {
		clearAllMocks()
	})

	it("drops a non-streaming request whose response headers exceed the deadline", async () => {
		vitest.mocked(getApiRequestTimeout).mockReturnValue(TIGHT_DEADLINE_MS)
		const port = await startServer((_req, res) => {
			void delay(SERVER_DELAY_MS).then(() => {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ choices: [{ message: { content: "late" }, finish_reason: "stop" }] }))
			})
		})

		const handler = makeHandler(`http://127.0.0.1:${port}/v1`)
		const started = Date.now()

		await expect(handler.completePrompt("ping")).rejects.toThrow()
		expect(Date.now() - started).toBeLessThan(SERVER_DELAY_MS)
	})

	it("lets a slow response complete when the deadline exceeds the wait", async () => {
		vitest.mocked(getApiRequestTimeout).mockReturnValue(GENEROUS_DEADLINE_MS)
		const port = await startServer((_req, res) => {
			void delay(SERVER_DELAY_MS).then(() => {
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ choices: [{ message: { content: "late" }, finish_reason: "stop" }] }))
			})
		})

		const handler = makeHandler(`http://127.0.0.1:${port}/v1`)
		const result = await handler.completePrompt("ping")

		expect(result).toBe("late")
	})

	it("keeps a streaming body alive across an idle gap under the deadline", async () => {
		vitest.mocked(getApiRequestTimeout).mockReturnValue(GENEROUS_DEADLINE_MS)
		const port = await startServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" })
			res.write(sseChunk("alpha"))
			void delay(BODY_GAP_MS).then(() => {
				res.write(sseChunk("omega"))
				res.write("data: [DONE]\n\n")
				res.end()
			})
		})

		const handler = makeHandler(`http://127.0.0.1:${port}/v1`)
		const chunks: string[] = []
		for await (const chunk of handler.createMessage("sys", [{ role: "user", content: "ping" }])) {
			if (chunk.type === "text") {
				chunks.push(chunk.text)
			}
		}

		expect(chunks.join("")).toBe("alphaomega")
	})

	it("drops a streaming body that idles past the deadline", async () => {
		vitest.mocked(getApiRequestTimeout).mockReturnValue(TIGHT_DEADLINE_MS)
		const port = await startServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" })
			res.write(sseChunk("alpha"))
			// Silence: the body goes idle past the configured deadline.
			void delay(BODY_GAP_MS).then(() => {
				res.write(sseChunk("omega"))
				res.end()
			})
		})

		const handler = makeHandler(`http://127.0.0.1:${port}/v1`)
		const drain = async (): Promise<void> => {
			for await (const chunk of handler.createMessage("sys", [{ role: "user", content: "ping" }])) {
				void chunk
			}
		}
		const started = Date.now()

		await expect(drain()).rejects.toThrow()
		expect(Date.now() - started).toBeLessThan(BODY_GAP_MS)
	})
})
