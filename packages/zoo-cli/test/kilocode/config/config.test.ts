// kilocode_change - new file
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import { Account } from "../../../src/account/account"
import { Auth } from "../../../src/auth"
import { Config } from "../../../src/config/config"
import { ConfigMarkdown } from "../../../src/config/markdown"
import { ConfigPaths } from "../../../src/config/paths"
import { Env } from "../../../src/env"
import { KilocodeConfig } from "../../../src/kilocode/config/config"
import { KiloIndexing } from "../../../src/kilocode/indexing"
import { Instance } from "../../../src/project/instance"
import { Filesystem } from "../../../src/util/filesystem"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

const infra = CrossSpawnSpawner.defaultLayer.pipe(
	Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)
const emptyAccount = Layer.mock(Account.Service)({
	active: () => Effect.succeed(Option.none()),
	activeOrg: () => Effect.succeed(Option.none()),
})
const emptyAuth = Layer.mock(Auth.Service)({
	all: () => Effect.succeed({}),
})
const noopNpm = Layer.mock(Npm.Service)({
	install: () => Effect.void,
	add: () => Effect.die("not implemented"),
	which: () => Effect.succeed(Option.none()),
})
const layer = Config.layer.pipe(
	Layer.provide(EffectFlock.defaultLayer),
	Layer.provide(AppFileSystem.defaultLayer),
	Layer.provide(Env.defaultLayer),
	Layer.provide(emptyAuth),
	Layer.provide(emptyAccount),
	Layer.provideMerge(infra),
	Layer.provide(noopNpm),
)

const load = () => Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(layer)))
const clear = (wait = false) =>
	Effect.runPromise(Config.Service.use((svc) => svc.invalidate(wait)).pipe(Effect.scoped, Effect.provide(layer)))

async function writeConfig(dir: string, config: object, name = "kilo.json") {
	await Filesystem.write(path.join(dir, name), JSON.stringify(config))
}

const cfg: Partial<Config.Info> = {
	plugin: ["@kilocode/kilo-indexing"],
	experimental: {
		semantic_indexing: true,
	},
	indexing: {
		provider: "ollama",
		vectorStore: "qdrant",
		ollama: {
			baseUrl: "http://127.0.0.1:1",
		},
	},
}

afterEach(async () => {
	delete process.env.KILO_MD_TEST
	await disposeAllInstances()
	await clear(true)
})

describe("markdown substitutions", () => {
	test("applies file and env substitutions to parsed markdown body", async () => {
		process.env.KILO_MD_TEST = "env content"
		await using tmp = await tmpdir({
			init: async (dir) => {
				await Filesystem.write(path.join(dir, "body.md"), "file content")
				await Filesystem.write(
					path.join(dir, "SKILL.md"),
					["---", "name: test", "description: Test", "---", "{file:body.md}", "{env:KILO_MD_TEST}"].join(
						"\n",
					),
				)
			},
		})

		const md = await ConfigMarkdown.parse(path.join(tmp.path, "SKILL.md"))

		expect(md.content).toContain("file content")
		expect(md.content).toContain("env content")
	})
})

describe("kilocode indexing config", () => {
	test("uses Zoo project config update target for new projects", async () => {
		await using tmp = await tmpdir()
		const target = await Effect.runPromise(
			AppFileSystem.Service.use((fs) =>
				KilocodeConfig.projectConfigUpdateTarget({ fs, directory: tmp.path }),
			).pipe(Effect.provide(AppFileSystem.defaultLayer)),
		)

		expect(target).toBe(path.join(tmp.path, "zoo.jsonc"))
	})

	test("discovers Zoo config directory before legacy project directories", async () => {
		await using tmp = await tmpdir({
			init: async (dir) => {
				await Filesystem.write(path.join(dir, ".zoo", "marker"), "")
				await Filesystem.write(path.join(dir, ".kilo", "marker"), "")
			},
		})

		const dirs = await Effect.runPromise(
			ConfigPaths.directories(tmp.path).pipe(Effect.provide(AppFileSystem.defaultLayer)),
		)

		expect(dirs.some((dir) => dir.endsWith(path.join(".zoo")))).toBe(true)
		expect(dirs.findIndex((dir) => dir.endsWith(path.join(".zoo")))).toBeLessThan(
			dirs.findIndex((dir) => dir.endsWith(path.join(".kilo"))),
		)
	})

	test("keeps global indexing enabled in global config", async () => {
		await using globalTmp = await tmpdir()
		await using tmp = await tmpdir()

		const prev = Global.Path.config
		;(Global.Path as { config: string }).config = globalTmp.path
		await clear(true)

		try {
			await writeConfig(globalTmp.path, {
				$schema: "https://app.kilo.ai/config.json",
				indexing: {
					enabled: true,
					provider: "ollama",
				},
			})

			await Instance.provide({
				directory: tmp.path,
				fn: async () => {
					const config = await load()
					const global = await Effect.runPromise(
						Config.Service.use((svc) => svc.getGlobal()).pipe(Effect.scoped, Effect.provide(layer)),
					)
					expect(config.indexing?.provider).toBe("ollama")
					expect(config.indexing?.enabled).toBeUndefined()
					expect(global.indexing?.enabled).toBe(true)
				},
			})
		} finally {
			;(Global.Path as { config: string }).config = prev
			await clear(true)
		}
	})

	test("uses global indexing enabled when project enablement is unset", async () => {
		await using globalTmp = await tmpdir()
		await using tmp = await tmpdir({ git: true, config: cfg })

		const prev = Global.Path.config
		;(Global.Path as { config: string }).config = globalTmp.path
		await clear(true)

		try {
			await writeConfig(globalTmp.path, {
				$schema: "https://app.kilo.ai/config.json",
				indexing: {
					enabled: true,
				},
			})

			await Instance.provide({
				directory: tmp.path,
				fn: async () => {
					const global = await Effect.runPromise(
						Config.Service.use((svc) => svc.getGlobal()).pipe(Effect.scoped, Effect.provide(layer)),
					)
					const config = await load()
					const input = KiloIndexing.input(config.indexing, global.indexing)
					expect(input.enabled).toBe(true)
				},
			})
		} finally {
			;(Global.Path as { config: string }).config = prev
			await clear(true)
		}
	})

	test("global indexing enabled applies when project indexing is disabled", async () => {
		const input = KiloIndexing.input({ enabled: false }, { enabled: true })
		expect(input.enabled).toBe(true)
	})
})
