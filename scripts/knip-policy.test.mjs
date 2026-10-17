import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cli = path.join(root, "node_modules/knip/bin/knip.js")
const config = JSON.parse(readFileSync(path.join(root, "knip.json"), "utf8"))

// Exercise the installed analyzer and the repository's extension graph, rather
// than asserting that a configuration flag merely appears in a JSON file.
function fixture(files, run, includeWebview = false) {
	const directory = mkdtempSync(path.join(tmpdir(), "zoo-knip-policy-"))
	try {
		const write = (name, contents) => {
			const filename = path.join(directory, name)
			mkdirSync(path.dirname(filename), { recursive: true })
			writeFileSync(filename, contents)
		}
		write("package.json", JSON.stringify({ name: "knip-policy-fixture", private: true }))
		write("pnpm-workspace.yaml", `packages:\n  - src\n${includeWebview ? "  - webview-ui\n" : ""}`)
		write(
			"src/package.json",
			JSON.stringify({
				name: "fixture-extension",
				scripts: { test: "vitest run" },
				devDependencies: { vitest: "4.1.11" },
			}),
		)
		write(
			"knip.json",
			JSON.stringify({
				...config,
				workspaces: {
					src: config.workspaces.src,
					...(includeWebview ? { "webview-ui": config.workspaces["webview-ui"] } : {}),
				},
			}),
		)
		if (includeWebview) {
			write("webview-ui/package.json", JSON.stringify({ name: "fixture-webview", private: true }))
			write("webview-ui/src/index.tsx", 'console.log("application entry")\n')
		}
		write("src/extension.ts", 'import { live } from "./helper"\nconsole.log(live)\n')
		write("src/helper.ts", "export const live = 1\n")
		write(
			"src/vitest.config.ts",
			'import { defineConfig } from "vitest/config"\nexport default defineConfig({ test: {} })\n',
		)
		symlinkSync(path.join(root, "src/node_modules"), path.join(directory, "src/node_modules"), "junction")
		for (const [name, contents] of Object.entries(files)) write(name, contents)
		run((...flags) => {
			const result = spawnSync(process.execPath, [cli, "--no-progress", "--reporter", "json", ...flags], {
				cwd: directory,
				encoding: "utf8",
				timeout: 30_000,
			})
			assert.ifError(result.error)
			assert.equal(result.signal, null, result.stderr)
			assert.ok(result.status === 0 || result.status === 1, result.stderr)
			return { status: result.status, report: JSON.parse(result.stdout) }
		})
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

function reported(result, category, name) {
	return result.report.issues.some((issue) => issue[category]?.some((item) => item.name === name))
}

test("unused exports fail both Knip modes", () => {
	fixture({ "src/helper.ts": "export const live = 1\nexport const unused = 2\n" }, (knip) => {
		for (const flags of [[], ["--production"]]) {
			const result = knip(...flags)
			assert.equal(result.status, 1)
			assert.ok(reported(result, "exports", "unused"))
		}
	})
})

test("tests cannot make an otherwise unused production export pass the production check", () => {
	fixture(
		{
			"src/helper.ts": "export const live = 1\nexport const testOnly = 2\n",
			"src/__tests__/helper.spec.ts": 'import { testOnly } from "../helper"\nconsole.log(testOnly)\n',
		},
		(knip) => {
			const development = knip()
			assert.equal(development.status, 0, JSON.stringify(development.report))
			const production = knip("--production")
			assert.equal(production.status, 1)
			assert.ok(reported(production, "exports", "testOnly"))
		},
	)
})

test("an explicit internal test seam remains usable in tests without becoming public production API", () => {
	fixture(
		{
			"src/helper.ts": "export const live = 1\n/** @internal */\nexport const testOnly = 2\n",
			"src/__tests__/helper.spec.ts": 'import { testOnly } from "../helper"\nconsole.log(testOnly)\n',
		},
		(knip) => {
			const development = knip()
			assert.equal(development.status, 0, JSON.stringify(development.report))
			assert.equal(knip("--production").status, 0)
		},
	)
})

test("a production file imported only by tests is still reported as unused", () => {
	fixture(
		{
			"src/scaffold.ts": "export const scaffold = 1\n",
			"src/__tests__/scaffold.spec.ts": 'import { scaffold } from "../scaffold"\nconsole.log(scaffold)\n',
		},
		(knip) => {
			const development = knip()
			assert.equal(development.status, 0, JSON.stringify(development.report))
			const production = knip("--production")
			assert.equal(production.status, 1)
			assert.ok(production.report.files.includes("src/scaffold.ts"))
		},
	)
})

test("duplicate exports remain errors", () => {
	fixture(
		{
			"src/helper.ts": "export const live = 1\nexport default live\n",
			"src/extension.ts": 'import alias, { live } from "./helper"\nconsole.log(live, alias)\n',
		},
		(knip) => {
			for (const flags of [[], ["--production"]]) {
				const result = knip(...flags)
				assert.equal(result.status, 1)
				assert.ok(result.report.issues.some((issue) => issue.duplicates.length > 0))
			}
		},
	)
})

test("unused type exports remain errors", () => {
	fixture({ "src/helper.ts": "export const live = 1\nexport interface UnusedType { value: string }\n" }, (knip) => {
		for (const flags of [[], ["--production"]]) {
			const result = knip(...flags)
			assert.equal(result.status, 1)
			assert.ok(reported(result, "types", "UnusedType"))
		}
	})
})

test("unlisted runtime dependencies remain errors", () => {
	fixture(
		{
			"src/extension.ts":
				'import "unlisted-knip-policy-dependency"\nimport { live } from "./helper"\nconsole.log(live)\n',
		},
		(knip) => {
			for (const flags of [[], ["--production"]]) {
				const result = knip(...flags)
				assert.equal(result.status, 1)
				assert.ok(reported(result, "unlisted", "unlisted-knip-policy-dependency"))
			}
		},
	)
})

test("visual entries cannot hide helpers unused by the production application", () => {
	fixture(
		{
			"webview-ui/src/scene.visual.tsx": 'import { sceneOnly } from "./scene-helper"\nconsole.log(sceneOnly)\n',
			"webview-ui/src/scene-helper.ts": 'export const sceneOnly = "scene"\n',
			"webview-ui/src/scene.visual.fixture.tsx":
				'import { fixtureOnly } from "./fixture-helper"\nconsole.log(fixtureOnly)\n',
			"webview-ui/src/fixture-helper.ts": 'export const fixtureOnly = "fixture"\n',
		},
		(knip) => {
			const development = knip()
			assert.equal(development.status, 0, JSON.stringify(development.report))
			const production = knip("--production")
			assert.equal(production.status, 1)
			assert.ok(production.report.files.includes("webview-ui/src/scene-helper.ts"))
			assert.ok(production.report.files.includes("webview-ui/src/fixture-helper.ts"))
			assert.ok(!production.report.files.some((file) => file.includes(".visual.")))
		},
		true,
	)
})
