import { expect, test } from "bun:test"
import http from "http"
import path from "path"

import { Server } from "../../src/server/server"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { tmpdir } from "../fixture/fixture"

function requestIpc(socketPath: string, requestPath: string) {
	return new Promise<{ statusCode: number | undefined; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
		const req = http.request(
			{
				method: "OPTIONS",
				socketPath,
				path: requestPath,
				headers: {
					origin: "https://portable-core.example",
					"access-control-request-method": "GET",
					"access-control-request-headers": "authorization",
				},
			},
			(res) => {
				res.resume()
				res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers }))
			},
		)
		req.on("error", reject)
		req.end()
	})
}

test("Server.listen starts and stops an HTTP listener", async () => {
	const listener = await Server.listen({ hostname: "127.0.0.1", port: 0, cors: ["https://portable-core.example"] })
	try {
		const response = await fetch(new URL(InstancePaths.path, listener.url), {
			method: "OPTIONS",
			headers: {
				origin: "https://portable-core.example",
				"access-control-request-method": "GET",
				"access-control-request-headers": "authorization",
			},
		})

		expect(response.status).toBe(204)
		expect(response.headers.get("access-control-allow-origin")).toBe("https://portable-core.example")
	} finally {
		await listener.stop(true)
	}
})

test("Server.listen starts and stops an IPC listener", async () => {
	await using tmp = await tmpdir()
	const ipcPath = path.join(tmp.path, "zoo-test.sock")
	const listener = await Server.listen({
		hostname: "127.0.0.1",
		port: 0,
		ipcPath,
		cors: ["https://portable-core.example"],
	})

	try {
		expect(listener.ipcPath).toBe(ipcPath)
		const response = await requestIpc(ipcPath, InstancePaths.path)
		expect(response.statusCode).toBe(204)
		expect(response.headers["access-control-allow-origin"]).toBe("https://portable-core.example")
	} finally {
		await listener.stop(true)
	}
})
