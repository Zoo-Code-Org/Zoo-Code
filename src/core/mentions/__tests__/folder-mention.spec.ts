// npx vitest core/mentions/__tests__/folder-mention.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { parseMentions } from "../index"
import type { RooIgnoreController } from "../../ignore/RooIgnoreController"

vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
	},
}))

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

/** Writes a text file with `count` numbered, marker-prefixed lines. */
async function writeLines(dir: string, name: string, count: number, marker: string): Promise<void> {
	const lines = Array.from({ length: count }, (_, k) => `${marker}_LINE_${k + 1}`)
	await fs.writeFile(path.join(dir, name), `${lines.join("\n")}\n`, "utf8")
}

/** An allow-all ignore controller; tests widen it with deny rules. */
function allowAllController(): RooIgnoreController {
	return { validateAccess: () => true } as unknown as RooIgnoreController
}

/** Builds a folder named `dirName` inside cwd and returns its absolute path. */
async function makeFolder(cwd: string, dirName: string): Promise<string> {
	const dir = path.join(cwd, dirName)
	await fs.mkdir(dir, { recursive: true })
	return dir
}

describe("parseMentions - folder mention inline budget", () => {
	let cwd: string

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-folder-mention-"))
	})

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it("inlines a bounded sample of a large folder and names the skipped file as readable", async () => {
		const dir = await makeFolder(cwd, "pkg")
		for (const marker of ["A", "B", "C", "D", "E"]) {
			await writeLines(dir, `${marker.toLowerCase()}.txt`, 400, marker)
		}

		const result = await parseMentions("@/pkg/", cwd, undefined, allowAllController())
		const block = result.contentBlocks[0]

		// The folder block exists and carries the listing with every file name.
		expect(block.type).toBe("folder")
		for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]) {
			expect(block.content).toContain(name)
		}

		// Unfixed code inlines every line of every file (5 x 400); the budget
		// caps the sample at 250 lines per file and 1000 lines in total, so
		// exactly four files show their first line, every shown file stops at
		// its line 250, and line 251 never appears.
		expect(block.content.match(/_LINE_1\b/g) ?? []).toHaveLength(4)
		expect(block.content.match(/_LINE_250\b/g) ?? []).toHaveLength(4)
		expect(block.content).not.toContain("_LINE_251")
		expect(block.content).not.toContain("_LINE_400")

		// The total footprint of the block is bounded even though the folder
		// holds 2000 extracted lines.
		expect(block.content.length).toBeLessThan(60_000)

		// Exactly one file is skipped by the budget, and it stays readable:
		// the block names it and points at read_file.
		expect(block.content.match(/not inlined \(folder budget reached\)/g) ?? []).toHaveLength(1)
		expect(block.content).toContain("Use the read_file tool to read it")
	})

	it("caps a notebook's extracted lines that bypass the plain-text per-file cap", async () => {
		const dir = await makeFolder(cwd, "web")
		const cells = Array.from({ length: 150 }, (_, i) => ({
			cell_type: "code",
			source: [`cell ${i} prose\n`, `CELL${i}_TAIL`],
			metadata: {},
			outputs: [],
			execution_count: null,
		}))
		await fs.writeFile(
			path.join(dir, "data.ipynb"),
			JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 2 }),
			"utf8",
		)
		await writeLines(dir, "index.html", 10, "HTML")

		const result = await parseMentions("@/web/", cwd, undefined, allowAllController())
		const block = result.contentBlocks[0]

		// ~300 extracted lines from the notebook; the per-file budget caps the
		// inline at 250, so the last cell's content never enters the context.
		expect(block.content).toContain("index.html")
		expect(block.content).toContain("HTML_LINE_1")
		expect(block.content).not.toContain("CELL149_TAIL")
		expect(block.content).toContain("Use the read_file tool on '")
		expect(block.content).toContain("data.ipynb")
	})

	it("never inlines the content of an ignored file, even when told to show ignored files", async () => {
		const dir = await makeFolder(cwd, "mixed")
		await writeLines(dir, "secret.txt", 20, "SECRET")
		await writeLines(dir, "open.txt", 20, "OPEN")
		const controller = {
			validateAccess: (p: string) => !p.includes("secret"),
		} as unknown as RooIgnoreController

		const result = await parseMentions("@/mixed/", cwd, undefined, controller, true)
		const block = result.contentBlocks[0]

		expect(block.content).toContain("OPEN_LINE_1")
		expect(block.content).not.toContain("SECRET_LINE_1")
		// The ignored file is still listed, marked as locked.
		expect(block.content).toContain("🔒 secret.txt")
	})

	it("names an unreadable file instead of dropping it silently", async () => {
		const dir = await makeFolder(cwd, "guard")
		await writeLines(dir, "ok.txt", 10, "OK")
		const locked = path.join(dir, "locked.txt")
		await fs.writeFile(locked, "LOCKED_LINE_1\n", "utf8")
		await fs.chmod(locked, 0o000)

		try {
			const result = await parseMentions("@/guard/", cwd, undefined, allowAllController())
			const block = result.contentBlocks[0]

			expect(block.content).toContain("OK_LINE_1")
			expect(block.content).toContain("locked.txt")
			expect(block.content).toContain("not inlined (not readable)")
			expect(block.content).toContain("Use the read_file tool to read it")
		} finally {
			await fs.chmod(locked, 0o644)
		}
	})

	it("keeps the directory listing when the budget skips everything", async () => {
		const dir = await makeFolder(cwd, "big")
		for (let i = 1; i <= 6; i++) {
			await writeLines(dir, `f${i}.txt`, 400, `F${i}`)
		}

		const result = await parseMentions("@/big/", cwd, undefined, allowAllController())
		const block = result.contentBlocks[0]

		// Every name is in the listing, so the model can target read_file.
		for (let i = 1; i <= 6; i++) {
			expect(block.content).toContain(`f${i}.txt`)
		}
		// Some sample was inlined, and the rest is named as readable.
		expect(block.content).toContain("F1_LINE_1")
		expect(block.content.match(/not inlined \(folder budget reached\)/g) ?? []).toHaveLength(2)
	})
})
