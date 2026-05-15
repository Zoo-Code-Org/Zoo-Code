import { afterEach, describe, expect, test } from "bun:test"
import http from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { createHttpTransport, createIpcTransport } from "../src/index.js"

describe("Zoo SDK transports", () => {
	test("HTTP transport parses JSON and streams SSE chunks", async () => {
		const transport = createHttpTransport({
			baseUrl: "http://zoo.test",
			fetch: (async (input) => {
				const url = String(input)
				if (url.endsWith("/stream")) {
					return new Response('data: {"type":"text"}\n\ndata: [DONE]\n\n', { status: 200 })
				}
				return new Response(JSON.stringify({ ok: true }), { status: 200 })
			}) as typeof fetch,
		})

		expect(await transport.request({ path: "/json" })).toEqual({ ok: true })
		const chunks = []
		for await (const chunk of transport.stream({ path: "/stream" })) chunks.push(chunk)
		expect(chunks).toEqual([{ type: "text" }])
	})

	describe("IPC", () => {
		let dir: string | undefined
		let server: http.Server | undefined

		afterEach(async () => {
			await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
			server = undefined
			if (dir) await rm(dir, { recursive: true, force: true })
			dir = undefined
		})

		test("IPC transport sends requests over a Unix socket", async () => {
			dir = await mkdtemp(path.join(tmpdir(), "zoo-sdk-"))
			const socket = path.join(dir, "zoo.sock")
			server = http.createServer((req, res) => {
				if (req.url === "/stream") {
					res.writeHead(200, { "content-type": "text/event-stream" })
					res.end('data: {"type":"text"}\n\ndata: [DONE]\n\n')
					return
				}
				res.writeHead(200, { "content-type": "application/json" })
				res.end(JSON.stringify({ path: req.url }))
			})
			await new Promise<void>((resolve) => server!.listen(socket, resolve))

			const transport = createIpcTransport({ ipcPath: socket })
			expect(await transport.request({ path: "/json" })).toEqual({ path: "/json" })
			const chunks = []
			for await (const chunk of transport.stream({ path: "/stream" })) chunks.push(chunk)
			expect(chunks).toEqual([{ type: "text" }])
		})
	})
})
