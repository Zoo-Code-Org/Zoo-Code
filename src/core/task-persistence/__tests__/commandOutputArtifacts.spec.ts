import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	artifactFileName,
	flushArtifactRegistrations,
	listCommandOutputs,
	registerCommandOutput,
} from "../commandOutputArtifacts"

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>()
	return { ...actual, link: vi.fn(actual.link) }
})

describe("task command output references", () => {
	let directory: string
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-artifact-"))
	})
	afterEach(async () => {
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("allocates distinct short references concurrently without replacing output", async () => {
		const saves = Array.from({ length: 12 }, (_, i) => registerCommandOutput(directory, { content: `result ${i}` }))
		await flushArtifactRegistrations(directory)
		const ids = await Promise.all(saves)
		expect(new Set(ids).size).toBe(12)
		for (const [i, id] of ids.entries()) {
			expect(await fs.readFile(path.join(directory, `${id}.txt`), "utf8")).toBe(`result ${i}`)
		}
		expect((await listCommandOutputs(directory)).at(-1)).toBe("output-12")
	})

	it("keeps legacy files readable and references stable across fresh registrations", async () => {
		const source = path.join(directory, "cmd-1794879311931321565.txt")
		await fs.writeFile(source, "full output")
		expect(await registerCommandOutput(directory, { file: source })).toBe("output-1")
		await flushArtifactRegistrations(directory)
		expect(await fs.readFile(path.join(directory, "output-1.txt"), "utf8")).toBe("full output")
		expect(await fs.readFile(source, "utf8")).toBe("full output")
		expect(await registerCommandOutput(directory, { content: "next" })).toBe("output-2")
	})

	it("lists legacy references until the task has short IDs and tolerates a missing output directory", async () => {
		await fs.writeFile(path.join(directory, "cmd-456.txt"), "second")
		await fs.writeFile(path.join(directory, "cmd-123.txt"), "first")
		expect(await listCommandOutputs(directory)).toEqual(["cmd-123.txt", "cmd-456.txt"])
		expect(await listCommandOutputs(path.join(directory, "missing"))).toEqual([])
	})

	it("reports a failed registration and permits a later retry", async () => {
		const registration = registerCommandOutput(directory, { file: path.join(directory, "absent.txt") })
		const failure = expect(registration).rejects.toMatchObject({ code: "ENOENT" })
		await expect(flushArtifactRegistrations(directory)).rejects.toMatchObject({ code: "ENOENT" })
		await failure
		expect(await registerCommandOutput(directory, { content: "retry" })).toBe("output-1")
	})

	it("falls back to an exclusive copy when the filesystem cannot create hard links", async () => {
		const source = path.join(directory, "cmd-123.txt")
		await fs.writeFile(source, "portable output")
		vi.mocked(fs.link).mockRejectedValueOnce(Object.assign(new Error("not supported"), { code: "ENOTSUP" }))
		expect(await registerCommandOutput(directory, { file: source })).toBe("output-1")
		expect(await fs.readFile(path.join(directory, "output-1.txt"), "utf8")).toBe("portable output")
	})

	it("accepts only task-local filenames", () => {
		for (const id of ["../output-1", "output-1/else", "output-0", "output--1", "C:\\secret", "output-1.txt.bak"]) {
			expect(artifactFileName(id)).toBeUndefined()
		}
		expect(artifactFileName("output-2")).toBe("output-2.txt")
		expect(artifactFileName("cmd-1794879311931321565.txt")).toBe("cmd-1794879311931321565.txt")
	})
})
