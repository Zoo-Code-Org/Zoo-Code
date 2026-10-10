import { once } from "node:events"
import { WebSocketServer, type WebSocket } from "ws"
import nock from "nock"
import { CodexWebSocketTransport, CodexWebSocketUnavailableError } from "../CodexWebSocketTransport"
import { CodexWebSocketTransportScope } from "../codex-websocket/scopes/CodexWebSocketTransportScope"
import { collectStream } from "../../../test-utils/stream"

type Request = Record<string, unknown>

describe("CodexWebSocketTransport", () => {
	let server: WebSocketServer
	let transport: CodexWebSocketTransport
	let transportScope: CodexWebSocketTransportScope
	let requests: Request[]
	let connections: number
	let reply: (request: Request, socket: WebSocket) => void
	const options = () => ({
		headers: { Authorization: "Bearer test-token" },
		signal: new AbortController().signal,
		timeoutMs: 2_000,
	})
	const body = (input: unknown[] = [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }]) => ({
		model: "test-model",
		stream: true,
		store: false,
		input,
	})
	const complete = (socket: WebSocket, output: unknown[] = []) =>
		socket.send(
			JSON.stringify({
				type: "response.completed",
				response: { id: `resp_${requests.length}`, output, usage: { input_tokens: 1, output_tokens: 2 } },
			}),
		)

	beforeEach(async () => {
		nock.enableNetConnect(/^127\.0\.0\.1:/)
		requests = []
		connections = 0
		reply = (_request, socket) => complete(socket)
		server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
		await once(server, "listening")
		const address = server.address()
		if (typeof address === "string" || address === null) throw new Error("Missing test server address")
		transportScope = new CodexWebSocketTransportScope(`ws://127.0.0.1:${address.port}/responses`)
		transportScope.init()
		transport = transportScope.transport
		server.on("connection", (socket) => {
			connections++
			socket.on("message", (data) => {
				const request: Request = JSON.parse(String(data))
				requests.push(request)
				reply(request, socket)
			})
		})
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await transportScope?.dispose()
		nock.disableNetConnect()
		for (const socket of server.clients) socket.terminate()
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
	})

	it("sends the Codex v2 handshake and Responses Lite metadata", async () => {
		let headers: Record<string, string | string[] | undefined> = {}
		server.on("headers", (_headers, request) => {
			headers = request.headers
		})
		const events = await collectStream(
			transport.stream(body(), {
				...options(),
				headers: { Authorization: "Bearer test-token", "x-openai-internal-codex-responses-lite": "true" },
			}),
		)
		expect(headers).toMatchObject({
			authorization: "Bearer test-token",
			"openai-beta": "responses_websockets=2026-02-06",
		})
		expect(requests[0]).toMatchObject({
			type: "response.create",
			stream: true,
			store: false,
			client_metadata: {
				ws_request_header_x_openai_internal_codex_responses_lite: "true",
			},
		})
		expect(events[0]).toMatchObject({ type: "response.completed", response: { usage: { output_tokens: 2 } } })
	})

	it("preserves caller metadata while adding Responses Lite transport metadata", async () => {
		await collectStream(
			transport.stream(
				{ ...body(), client_metadata: { trace_id: "trace-1", feature: "test" } },
				{
					...options(),
					headers: { Authorization: "Bearer test-token", "x-openai-internal-codex-responses-lite": "true" },
				},
			),
		)
		expect(requests[0].client_metadata).toEqual({
			trace_id: "trace-1",
			feature: "test",
			ws_request_header_x_openai_internal_codex_responses_lite: "true",
		})
	})

	it("reuses a socket and sends only new tool output after reconstructed reasoning and tool calls", async () => {
		const output = [
			{
				type: "reasoning",
				id: "rs_1",
				summary: [{ type: "summary_text", text: "Thinking" }],
				encrypted_content: "encrypted",
			},
			{
				type: "message",
				id: "msg_1",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: "Reading", annotations: [] }],
			},
			{
				type: "function_call",
				id: "fc_1",
				status: "completed",
				call_id: "call_1",
				name: "read_file",
				arguments: '{"path":"a","start":1}',
			},
		]
		reply = (_request, socket) => complete(socket, requests.length === 1 ? output : [])
		await collectStream(transport.stream(body(), options()))
		const toolOutput = { type: "function_call_output", call_id: "call_1", output: "file content" }
		await collectStream(
			transport.stream(
				body([
					...body().input,
					{ type: "reasoning", id: "rs_1", encrypted_content: "encrypted" },
					{ role: "assistant", content: [{ type: "output_text", text: "Reading" }] },
					{
						type: "function_call",
						call_id: "call_1",
						name: "read_file",
						arguments: '{"start":1,"path":"a"}',
					},
					toolOutput,
				]),
				options(),
			),
		)
		expect(connections).toBe(1)
		expect(requests[1]).toMatchObject({ previous_response_id: "resp_1", input: [toolOutput] })
	})

	it.each(["history", "settings", "explicit reset"])("replays full context after %s changes", async (change) => {
		const log = vi.spyOn(console, "info")
		await collectStream(transport.stream(body(), options()))
		if (change === "explicit reset") transport.resetContinuation()
		const next = body(change === "history" ? [{ role: "user", content: "Compacted history" }] : body().input)
		if (change === "settings") next.model = "another-model"
		await collectStream(transport.stream(next, options()))
		expect(requests[1].previous_response_id).toBeUndefined()
		expect(requests[1].input).toEqual(next.input)
		const reason =
			change === "history"
				? "history changed"
				: change === "settings"
					? "request settings changed"
					: "no cached response"
		expect(log).toHaveBeenLastCalledWith(expect.stringContaining(`reason: ${reason}`))
	})

	it("recovers a missing previous response once with the full context", async () => {
		const log = vi.spyOn(console, "info")
		reply = (_request, socket) => {
			if (requests.length === 2)
				socket.send(JSON.stringify({ type: "error", error: { code: "previous_response_not_found" } }))
			else complete(socket)
		}
		await collectStream(transport.stream(body(), options()))
		const next = body([...body().input, { role: "user", content: "Next" }])
		await collectStream(transport.stream(next, options()))
		expect(requests[1].previous_response_id).toBe("resp_1")
		expect(requests[2]).toMatchObject({ input: next.input })
		expect(requests[2].previous_response_id).toBeUndefined()
		expect(log).toHaveBeenLastCalledWith(expect.stringContaining("reason: server cache miss"))
	})

	it.each(["function_call", "message"])("continues after unencrypted reasoning followed by %s", async (type) => {
		const call = { type: "function_call", call_id: "call_1", name: "list_files", arguments: "{}" }
		const output =
			type === "function_call" ? call : { role: "assistant", content: [{ type: "output_text", text: "Ready" }] }
		reply = (_request, socket) =>
			complete(
				socket,
				requests.length === 1
					? [{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Thinking" }] }, output]
					: [],
			)
		await collectStream(transport.stream(body(), options()))
		const next =
			type === "function_call"
				? { type: "function_call_output", call_id: "call_1", output: "files" }
				: { role: "user", content: "Continue" }
		const history = [...body().input, output, next]
		await collectStream(transport.stream(body(history), options()))
		expect(requests[1]).toMatchObject({ previous_response_id: "resp_1", input: [next] })
		const followup = { role: "user", content: "Next step" }
		await collectStream(transport.stream(body([...history, followup]), options()))
		expect(requests[2]).toMatchObject({ previous_response_id: "resp_2", input: [followup] })
		expect(connections).toBe(1)
	})

	it("replays full context when encrypted reasoning is omitted", async () => {
		const call = { type: "function_call", call_id: "call_1", name: "list_files", arguments: "{}" }
		reply = (_request, socket) =>
			complete(
				socket,
				requests.length === 1 ? [{ type: "reasoning", id: "rs_1", encrypted_content: "encrypted" }, call] : [],
			)
		await collectStream(transport.stream(body(), options()))
		const next = body([...body().input, call, { type: "function_call_output", call_id: "call_1", output: "files" }])
		await collectStream(transport.stream(next, options()))
		expect(requests[1].previous_response_id).toBeUndefined()
		expect(requests[1].input).toEqual(next.input)
	})

	it("identifies changed message content without logging the content", async () => {
		const log = vi.spyOn(console, "info")
		const message = { role: "assistant", content: [{ type: "output_text", text: "private text" }] }
		reply = (_request, socket) => complete(socket, requests.length === 1 ? [message] : [])
		await collectStream(transport.stream(body(), options()))
		await collectStream(
			transport.stream(
				body([
					...body().input,
					{ ...message, content: [{ type: "output_text", text: "changed private text" }] },
				]),
				options(),
			),
		)
		expect(log).toHaveBeenLastCalledWith(expect.stringContaining("message -> message; fields: content"))
		expect(log.mock.calls.flat().join(" ")).not.toContain("private text")
	})

	it("reconnects with full context when credentials change", async () => {
		await collectStream(transport.stream(body(), options()))
		await collectStream(
			transport.stream(body(), { ...options(), headers: { Authorization: "Bearer refreshed-token" } }),
		)
		expect(connections).toBe(2)
		expect(requests[1].previous_response_id).toBeUndefined()
	})

	it("rotates a connection before the server's one-hour limit", async () => {
		await collectStream(transport.stream(body(), options()))
		const later = Date.now() + 55 * 60_000
		vi.spyOn(Date, "now").mockReturnValue(later)
		await collectStream(transport.stream(body(), options()))
		expect(connections).toBe(2)
		expect(requests[1].previous_response_id).toBeUndefined()
	})

	it("never labels a disconnect after sending as safe to replay over HTTP", async () => {
		reply = (_request, socket) => socket.close()
		const error = await collectStream(transport.stream(body(), options())).catch((error: unknown) => error)
		expect(error).toBeInstanceOf(Error)
		expect(error).not.toBeInstanceOf(CodexWebSocketUnavailableError)
		expect(requests).toHaveLength(1)
	})

	it("permits HTTP fallback after a rejected upgrade and stops retrying the socket", async () => {
		server.options.verifyClient = () => false
		await expect(collectStream(transport.stream(body(), options()))).rejects.toBeInstanceOf(
			CodexWebSocketUnavailableError,
		)
		await expect(collectStream(transport.stream(body(), options()))).rejects.toBeInstanceOf(
			CodexWebSocketUnavailableError,
		)
		expect(connections).toBe(0)
		expect(requests).toHaveLength(0)
	})

	it("attempts WebSocket again after credentials change following a failed upgrade", async () => {
		server.options.verifyClient = () => false
		await expect(collectStream(transport.stream(body(), options()))).rejects.toBeInstanceOf(
			CodexWebSocketUnavailableError,
		)
		server.options.verifyClient = () => true
		await collectStream(
			transport.stream(body(), { ...options(), headers: { Authorization: "Bearer refreshed-token" } }),
		)
		expect(connections).toBe(1)
		expect(requests[0].previous_response_id).toBeUndefined()
	})

	it("retries a transient upgrade failure after the cooldown", async () => {
		server.options.verifyClient = () => false
		await expect(collectStream(transport.stream(body(), options()))).rejects.toBeInstanceOf(
			CodexWebSocketUnavailableError,
		)
		server.options.verifyClient = () => true
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000)
		await collectStream(transport.stream(body(), options()))
		expect(connections).toBe(1)
		expect(requests[0].previous_response_id).toBeUndefined()
	})

	it("reconnects with full history after the server closes an idle socket", async () => {
		await collectStream(transport.stream(body(), options()))
		const socket = [...server.clients][0]
		const closed = once(socket, "close")
		socket.close()
		await closed
		await collectStream(transport.stream(body(), options()))
		expect(connections).toBe(2)
		expect(requests[1].previous_response_id).toBeUndefined()
	})

	it("never replays a cache miss after any response event has arrived", async () => {
		await collectStream(transport.stream(body(), options()))
		reply = (_request, socket) => {
			socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "Accepted" }))
			socket.send(JSON.stringify({ type: "error", error: { code: "previous_response_not_found" } }))
		}
		await expect(collectStream(transport.stream(body(), options()))).rejects.toThrow("previous_response_not_found")
		expect(requests).toHaveLength(2)
	})

	it.each([
		{ type: "response.failed", response: { error: { code: "server_error", message: "Service unavailable" } } },
		{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
	])("preserves server failure details for $type", async (event) => {
		reply = (_request, socket) => socket.send(JSON.stringify(event))
		await expect(collectStream(transport.stream(body(), options()))).rejects.toThrow(
			event.type === "response.failed" ? "Service unavailable" : "max_output_tokens",
		)
	})

	it.each(["response.failed", "response.incomplete"])("reports %s as a failed request", async (type) => {
		reply = (_request, socket) => socket.send(JSON.stringify({ type, response: { id: "failed" } }))
		await expect(collectStream(transport.stream(body(), options()))).rejects.toThrow(type)
	})

	it("does not loop when full-context recovery also fails", async () => {
		await collectStream(transport.stream(body(), options()))
		reply = (_request, socket) =>
			socket.send(JSON.stringify({ type: "error", error: { code: "previous_response_not_found" } }))
		await expect(collectStream(transport.stream(body(), options()))).rejects.toThrow("previous_response_not_found")
		expect(requests).toHaveLength(3)
	})

	it("closes the socket on Stop and starts fresh on the next request", async () => {
		const controller = new AbortController()
		reply = (_request, socket) => {
			socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "Partial" }))
		}
		const stream = transport.stream(body(), { ...options(), signal: controller.signal })
		expect((await stream.next()).value).toMatchObject({ delta: "Partial" })
		controller.abort()
		await expect(stream.next()).rejects.toThrow()
		reply = (_request, socket) => complete(socket)
		await collectStream(transport.stream(body(), options()))
		expect(connections).toBe(2)
		expect(requests[1].previous_response_id).toBeUndefined()
	})

	it("disposes an active stream and reconnects with full context on the next request", async () => {
		reply = (_request, socket) =>
			socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "Partial" }))
		const stream = transport.stream(body(), options())
		await stream.next()
		await transportScope.dispose()
		expect(() => transportScope.transport).toThrow("not initialized")
		await expect(stream.next()).rejects.toThrow("closed before response completed")
		transportScope.init()
		transport = transportScope.transport
		reply = (_request, socket) => complete(socket)
		await collectStream(transport.stream(body(), options()))
		expect(connections).toBe(2)
		expect(requests[1].previous_response_id).toBeUndefined()
	})

	it("disposes a completed idle connection and reconnects without stale continuation", async () => {
		await collectStream(transport.stream(body(), options()))
		await transport.dispose()
		await transport.dispose()
		await collectStream(transport.stream(body(), options()))
		expect(connections).toBe(2)
		expect(requests[1].previous_response_id).toBeUndefined()
	})

	it("disposes request deadlines while the consumer is paused on a partial response", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		reply = (_request, socket) =>
			socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "Partial" }))
		const stream = transport.stream(body(), options())
		try {
			await stream.next()
			expect(vi.getTimerCount()).toBe(1)
			await transport.dispose()
			expect(vi.getTimerCount()).toBe(0)
			await expect(stream.next()).rejects.toThrow("closed before response completed")
		} finally {
			await stream.return(undefined)
			vi.useRealTimers()
		}
	})

	it("bounds a silent response with a timeout", async () => {
		reply = () => {}
		await expect(collectStream(transport.stream(body(), { ...options(), timeoutMs: 100 }))).rejects.toThrow()
	})

	it.each(["null", "[]", "{}", '{"type":42}', "invalid JSON"])(
		"rejects malformed response %s and clears the connection",
		async (payload) => {
			reply = (_request, socket) => socket.send(payload)
			const error = await collectStream(transport.stream(body(), options())).catch((error: unknown) => error)
			expect(error).toBeInstanceOf(Error)
			expect(error).not.toBeInstanceOf(CodexWebSocketUnavailableError)
			reply = (_request, socket) => complete(socket)
			await collectStream(transport.stream(body(), options()))
			expect(connections).toBe(2)
			expect(requests[1].previous_response_id).toBeUndefined()
		},
	)

	it("closes a completed idle connection after two minutes", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		try {
			await collectStream(transport.stream(body(), options()))
			const closed = once([...server.clients][0], "close")
			await vi.advanceTimersByTimeAsync(120_000)
			await closed
			await collectStream(transport.stream(body(), options()))
			expect(connections).toBe(2)
			expect(requests[1].previous_response_id).toBeUndefined()
		} finally {
			vi.useRealTimers()
		}
	})

	it("clears the request deadline before yielding completion to a paused consumer", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const stream = transport.stream(body(), { ...options(), timeoutMs: 2_000 })
		try {
			expect((await stream.next()).value).toMatchObject({ type: "response.completed" })
			await vi.advanceTimersByTimeAsync(10_000)
			expect((await stream.next()).done).toBe(true)
			await collectStream(transport.stream(body(), options()))
			expect(connections).toBe(1)
			expect(requests[1].previous_response_id).toBe("resp_1")
		} finally {
			await stream.return(undefined)
			vi.useRealTimers()
		}
	})

	it("rejects overlapping requests without disturbing the active stream", async () => {
		reply = (_request, socket) =>
			socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "Partial" }))
		const stream = transport.stream(body(), options())
		await stream.next()
		await expect(collectStream(transport.stream(body(), options()))).rejects.toThrow("Concurrent requests")
		await stream.return(undefined)
	})
})
