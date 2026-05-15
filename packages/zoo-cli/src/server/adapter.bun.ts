import type { Hono } from "hono"
import { createBunWebSocket } from "hono/bun"
import { existsSync, unlinkSync } from "fs"
import type { Adapter, FetchApp, Opts } from "./adapter"

function listen(app: FetchApp, opts: Opts, websocket?: ReturnType<typeof createBunWebSocket>["websocket"]) {
	if (opts.ipcPath) {
		if (existsSync(opts.ipcPath)) unlinkSync(opts.ipcPath)
		const serveOptions = { fetch: app.fetch, idleTimeout: 0, unix: opts.ipcPath, websocket } as any
		const server = Bun.serve(serveOptions)
		return {
			port: 0,
			ipcPath: opts.ipcPath,
			stop(close?: boolean) {
				return Promise.resolve(server.stop(close)).finally(() => {
					if (opts.ipcPath && existsSync(opts.ipcPath)) unlinkSync(opts.ipcPath)
				})
			},
		}
	}

	const start = (port: number) => {
		try {
			if (websocket) {
				return Bun.serve({ fetch: app.fetch, hostname: opts.hostname, idleTimeout: 0, websocket, port })
			}
			return Bun.serve({ fetch: app.fetch, hostname: opts.hostname, idleTimeout: 0, port })
		} catch {
			return
		}
	}
	const server = opts.port === 0 ? (start(4096) ?? start(0)) : start(opts.port)
	if (!server) {
		throw new Error(`Failed to start server on port ${opts.port}`)
	}
	if (!server.port) {
		throw new Error(`Failed to resolve server address for port ${opts.port}`)
	}
	return {
		port: server.port,
		stop(close?: boolean) {
			return Promise.resolve(server.stop(close))
		},
	}
}

export const adapter: Adapter = {
	create(app: Hono) {
		const ws = createBunWebSocket()
		return {
			upgradeWebSocket: ws.upgradeWebSocket,
			listen: (opts) => Promise.resolve(listen(app, opts, ws.websocket)),
		}
	},
	createFetch(app) {
		return {
			listen: (opts) => Promise.resolve(listen(app, opts)),
		}
	},
}
