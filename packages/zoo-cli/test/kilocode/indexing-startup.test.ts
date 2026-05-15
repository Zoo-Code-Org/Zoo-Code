import { afterEach, describe, expect, test } from "bun:test"
import type { Config } from "../../src/config/config"
import { getBootstrapRunEffect } from "../../src/effect/app-runtime"
import { KiloIndexing } from "../../src/kilocode/indexing"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const cfg: Partial<Config.Info> = {
	plugin: ["@kilocode/kilo-indexing"],
	experimental: {
		semantic_indexing: true,
	},
	indexing: {
		enabled: true,
		provider: "ollama",
		vectorStore: "qdrant",
		ollama: {
			baseUrl: "http://127.0.0.1:1",
		},
	},
}

const configDir = process.env["KILO_CONFIG_DIR"]

afterEach(async () => {
	if (configDir === undefined) delete process.env["KILO_CONFIG_DIR"]
	else process.env["KILO_CONFIG_DIR"] = configDir
	await disposeAllInstances()
})

describe("indexing startup degradation", () => {
	test("keeps server routes alive with indexing disabled", async () => {
		await using tmp = await tmpdir({ git: true, config: cfg })
		process.env["KILO_CONFIG_DIR"] = tmp.path

		const app = Server.Default().app

		const config = await app.request("/config", {
			headers: {
				"x-kilo-directory": tmp.path,
			},
		})
		expect(config.status).toBe(200)

		const status = await app.request("/indexing/status", {
			headers: {
				"x-kilo-directory": tmp.path,
			},
		})
		expect(status.status).toBe(200)

		const body = await status.json()
		expect(body).toMatchObject({
			state: "Disabled",
			message: "Codebase indexing is not bundled in Zoo Code CLI.",
		})
	})

	test("reports disabled indexing from runtime API", async () => {
		await using tmp = await tmpdir({ git: true, config: cfg })
		process.env["KILO_CONFIG_DIR"] = tmp.path

		await Instance.provide({
			directory: tmp.path,
			init: await getBootstrapRunEffect(),
			fn: async () => {
				const status = await KiloIndexing.current()

				expect(status).toMatchObject({
					state: "Disabled",
					message: "Codebase indexing is not bundled in Zoo Code CLI.",
				})
				expect(await KiloIndexing.available()).toBe(false)
				expect(KiloIndexing.ready()).toBe(false)
				expect(await KiloIndexing.search("boot failure")).toEqual([])
			},
		})
	})
})
