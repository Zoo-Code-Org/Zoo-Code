import * as net from "net"

import { startCallbackServer, stopCallbackServer } from "../callbackServer"

// This spec uses a real loopback listener. callbackServer.spec.ts mocks the http module.
const STATE = "listener-state"
const RESPONSE_WAIT_MS = 2_000

/** Opens a raw keep-alive connection, so that a request can reach the listener after the callback. */
async function connectClient(port: number) {
	const socket = net.connect(port, "127.0.0.1")
	let received = ""
	socket.setEncoding("utf8")
	socket.on("data", (chunk: string) => {
		received += chunk
	})
	socket.on("error", () => {
		// The server can close the connection when it stops. The assertions check the responses.
	})
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve)
		socket.once("error", reject)
	})
	return {
		send(path: string) {
			socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`)
		},
		/** Waits until the client has received one response, and returns its status line. */
		async waitForResponse(): Promise<string | undefined> {
			let status: string | undefined
			await vi.waitFor(
				() => {
					status = received.match(/^HTTP\/1\.1 \d{3}/m)?.[0]
					expect(status).toBeDefined()
				},
				{ timeout: RESPONSE_WAIT_MS },
			)
			return status
		},
		destroy: () => socket.destroy(),
	}
}

describe("startCallbackServer with a real listener", () => {
	it("should answer a request that arrives after the callback wait ends, so that the server can stop", async () => {
		const { server, port, result, cancel } = await startCallbackServer(0, STATE)
		const outcome = result.catch((error: unknown) => error)
		const client = await connectClient(port)
		let stopped = false
		try {
			// The listener no longer waits for a callback, but the connection is still open.
			cancel()
			expect(await outcome).toEqual(new Error("Callback cancelled"))

			client.send(`/callback?code=late-code&state=${STATE}`)

			expect(await client.waitForResponse()).toBe("HTTP/1.1 404")
			await expect(stopCallbackServer(server, cancel)).resolves.toBeUndefined()
			stopped = true
		} finally {
			client.destroy()
			if (!stopped) server.close()
		}
	})

	it("should accept a callback and then stop", async () => {
		const { server, port, result, cancel } = await startCallbackServer(0, STATE)
		const client = await connectClient(port)
		try {
			client.send(`/callback?code=first-code&state=${STATE}`)

			await expect(result).resolves.toMatchObject({ code: "first-code", state: STATE })
			expect(await client.waitForResponse()).toBe("HTTP/1.1 200")
			await expect(stopCallbackServer(server, cancel)).resolves.toBeUndefined()
		} finally {
			client.destroy()
		}
	})
})
