import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import type { AgentFixture } from "./contract.ts"
import { buildGradingCopy, buildFreshWorkspace, initialStateDigest } from "./coding-workspace.ts"
import { CODING_FIXTURE_BUNDLES } from "./coding-fixtures.ts"

const tmpdir = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), "coding-workspace-test-"))

const anyBundle = (): (typeof CODING_FIXTURE_BUNDLES)[number] => CODING_FIXTURE_BUNDLES[0]!

describe("initial state digest", () => {
	it("is stable for the same fixture content", () => {
		const fixture: AgentFixture = anyBundle().fixture
		assert.equal(initialStateDigest(fixture), initialStateDigest(fixture))
	})

	it("is independent of file declaration order", async () => {
		const fixture: AgentFixture = anyBundle().fixture
		const reordered: AgentFixture = {
			...fixture,
			workspace: { files: [...fixture.workspace.files].reverse() },
		}
		assert.equal(initialStateDigest(fixture), initialStateDigest(reordered))
	})

	it("changes when any workspace file changes", () => {
		const fixture: AgentFixture = anyBundle().fixture
		const edited: AgentFixture = {
			...fixture,
			workspace: {
				files: fixture.workspace.files.map((file, index) =>
					index === 0 ? { ...file, content: `${file.content}\n` } : file,
				),
			},
		}
		assert.notEqual(initialStateDigest(fixture), initialStateDigest(edited))
	})
})

describe("fresh workspace builder", () => {
	it("writes the fixture files into a new directory", async () => {
		const bundle = anyBundle()
		const target = path.join(await tmpdir(), "workspace")
		const result = await buildFreshWorkspace(bundle.fixture, target)
		assert.equal(result.filesWritten, bundle.fixture.workspace.files.length)
		for (const file of bundle.fixture.workspace.files) {
			const written = await fs.readFile(path.join(target, file.path), "utf8")
			assert.equal(written, file.content)
		}
	})

	it("refuses to build into an existing directory", async () => {
		const bundle = anyBundle()
		const target = await tmpdir()
		await assert.rejects(() => buildFreshWorkspace(bundle.fixture, target))
	})

	it("keeps two builds independent", async () => {
		const bundle = anyBundle()
		const parent = await tmpdir()
		const first = path.join(parent, "first")
		const second = path.join(parent, "second")
		await buildFreshWorkspace(bundle.fixture, first)
		await buildFreshWorkspace(bundle.fixture, second)
		// Mutating one build must not affect the other.
		await fs.writeFile(path.join(first, bundle.fixture.workspace.files[0]!.path), "mutated")
		const secondContent = await fs.readFile(path.join(second, bundle.fixture.workspace.files[0]!.path), "utf8")
		assert.equal(secondContent, bundle.fixture.workspace.files[0]!.content)
	})
})

describe("grading copy", () => {
	it("adds hidden tests only to the copy", async () => {
		const bundle = anyBundle()
		const hidden = bundle.grading.hiddenTests[0]!
		const target = path.join(await tmpdir(), "grading")
		await buildGradingCopy(bundle.fixture.workspace.files, bundle.grading.hiddenTests, target)
		await fs.access(path.join(target, hidden.path))
		// The run workspace itself must never contain the hidden tests.
		assert.equal(
			bundle.fixture.workspace.files.some((file) => file.path === hidden.path),
			false,
		)
	})

	it("lets hidden tests shadow an agent file with the same path", async () => {
		const bundle = anyBundle()
		const hidden = bundle.grading.hiddenTests[0]!
		const target = path.join(await tmpdir(), "grading-shadow")
		const tampered = [...bundle.fixture.workspace.files, { path: hidden.path, content: "// tampered" }]
		await buildGradingCopy(tampered, bundle.grading.hiddenTests, target)
		assert.equal(await fs.readFile(path.join(target, hidden.path), "utf8"), hidden.content)
	})

	it("rejects escaping paths", async () => {
		const target = path.join(await tmpdir(), "grading-escape")
		await assert.rejects(() => buildGradingCopy([{ path: "../escape.txt", content: "x" }], [], target))
	})
})
