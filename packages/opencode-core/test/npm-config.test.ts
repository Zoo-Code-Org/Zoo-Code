import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { NpmConfig } from "@opencode-ai/core/npm-config"
import { tmpdir } from "./fixture/tmpdir"

const originalRegistryEnv = {
	npm_config_registry: process.env.npm_config_registry,
	NPM_CONFIG_REGISTRY: process.env.NPM_CONFIG_REGISTRY,
}

function clearRegistryEnv() {
	delete process.env.npm_config_registry
	delete process.env.NPM_CONFIG_REGISTRY
}

afterEach(() => {
	if (originalRegistryEnv.npm_config_registry === undefined) delete process.env.npm_config_registry
	else process.env.npm_config_registry = originalRegistryEnv.npm_config_registry
	if (originalRegistryEnv.NPM_CONFIG_REGISTRY === undefined) delete process.env.NPM_CONFIG_REGISTRY
	else process.env.NPM_CONFIG_REGISTRY = originalRegistryEnv.NPM_CONFIG_REGISTRY
})

describe("NpmConfig.load", () => {
	test("reads registry from project .npmrc", async () => {
		clearRegistryEnv()
		await using tmp = await tmpdir()
		await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test/\n")

		const config = await Effect.runPromise(NpmConfig.load(tmp.path))

		expect(config.registry).toBe("https://registry.example.test/")
	})

	test("reads scoped registries from project .npmrc", async () => {
		await using tmp = await tmpdir()
		await Bun.write(path.join(tmp.path, ".npmrc"), "@acme:registry=https://npm.acme.test/\n")

		const config = await Effect.runPromise(NpmConfig.load(tmp.path))

		expect(config["@acme:registry"]).toBe("https://npm.acme.test/")
	})

	test("flattens boolean and list options", async () => {
		await using tmp = await tmpdir()
		await Bun.write(path.join(tmp.path, ".npmrc"), "ignore-scripts=true\nomit[]=dev\nomit[]=optional\n")

		const config = await Effect.runPromise(NpmConfig.load(tmp.path))

		expect(config.ignoreScripts).toBe(true)
		expect(config.omit).toEqual(["dev", "optional"])
	})
})

describe("NpmConfig.registry", () => {
	test("normalizes configured registry without trailing slash", async () => {
		clearRegistryEnv()
		await using tmp = await tmpdir()
		await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test/\n")

		await expect(Effect.runPromise(NpmConfig.registry(tmp.path))).resolves.toBe("https://registry.example.test")
	})

	test("leaves configured registry without trailing slash unchanged", async () => {
		clearRegistryEnv()
		await using tmp = await tmpdir()
		await Bun.write(path.join(tmp.path, ".npmrc"), "registry=https://registry.example.test\n")

		await expect(Effect.runPromise(NpmConfig.registry(tmp.path))).resolves.toBe("https://registry.example.test")
	})
})
