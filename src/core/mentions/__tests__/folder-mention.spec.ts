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

/**
 * Paths the hoisted extractor mock below rejects with a read error. Kept on
 * globalThis so the hoisted factory and the test body share one slot; unset
 * means every file uses the real extractor.
 */
const readRejects = globalThis as unknown as { __folderMentionRejectedPaths?: Set<string> }

vi.mock("../../../integrations/misc/extract-text", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../integrations/misc/extract-text")>()
	return {
		...actual,
		extractTextFromFileWithMetadata: async (filePath: string, limit?: number) => {
			if (readRejects.__folderMentionRejectedPaths?.has(filePath)) {
				throw new Error(`EACCES: permission denied, open '${filePath}'`)
			}
			return actual.extractTextFromFileWithMetadata(filePath, limit)
		},
	}
})

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
		// The truncated notebook gets recovery guidance without an offset: the
		// shown lines are extraction coordinates, and read_file slices raw
		// lines, which for a notebook are not the same numbering.
		expect(block.content).toContain("folder inline budget: showing 250 of")
		expect(block.content).toContain("Use the read_file tool on 'web/data.ipynb' to read it directly.")
		expect(block.content).not.toContain("offset=")
	})

	it("inlines a small folder fully with no budget notices", async () => {
		const dir = await makeFolder(cwd, "tiny")
		await writeLines(dir, "a.txt", 5, "AAA")
		await writeLines(dir, "b.txt", 5, "BBB")

		const result = await parseMentions("@/tiny/", cwd, undefined, allowAllController())
		const block = result.contentBlocks[0]

		// Every body appears in full.
		expect(block.content).toContain("AAA_LINE_1")
		expect(block.content).toContain("AAA_LINE_5")
		expect(block.content).toContain("BBB_LINE_1")
		expect(block.content).toContain("BBB_LINE_5")
		// Nothing was skipped and nothing was truncated.
		expect(block.content).not.toContain("Files not inlined")
		expect(block.content).not.toContain("folder inline budget")
	})

	it("names the exact continuation offset when one file fills the block", async () => {
		const dir = await makeFolder(cwd, "solo")
		await writeLines(dir, "big.txt", 400, "BIG")

		const result = await parseMentions("@/solo/", cwd, undefined, allowAllController())
		const block = result.contentBlocks[0]

		// 250 lines shown of the 401 the extractor reports (its count includes
		// the trailing newline). The notice names the exact next raw line so
		// the model can continue with read_file.
		expect(block.content).toContain(
			"[folder inline budget: showing 250 of 401 lines. Use the read_file tool on 'solo/big.txt' with offset=251 to read more.]",
		)
		expect(block.content).not.toContain("_LINE_251")
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

		// The extractor mock rejects only for locked.txt, so the error-
		// recovery path runs deterministically on every platform and user;
		// a chmod 0o000 does not block reads on Windows or as root.
		readRejects.__folderMentionRejectedPaths = new Set([locked])

		try {
			const result = await parseMentions("@/guard/", cwd, undefined, allowAllController())
			const block = result.contentBlocks[0]

			expect(block.content).toContain("OK_LINE_1")
			expect(block.content).toContain("locked.txt")
			expect(block.content).toContain("not inlined (not readable)")
			expect(block.content).toContain("Use the read_file tool to read it")
		} finally {
			readRejects.__folderMentionRejectedPaths = undefined
		}
	})

	it("lists a binary file as not inlined instead of dumping its bytes", async () => {
		const dir = await makeFolder(cwd, "assets")
		await fs.writeFile(
			path.join(dir, "blob.bin"),
			Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), Buffer.from("BINPAYLOAD", "utf8")]),
		)
		await writeLines(dir, "readme.txt", 5, "TXT")

		const result = await parseMentions("@/assets/", cwd, undefined, allowAllController())
		const block = result.contentBlocks[0]

		expect(block.content).toContain("TXT_LINE_1")
		// The binary file stays named and readable.
		expect(block.content).toContain("--- Files not inlined ---")
		expect(block.content).toContain("blob.bin")
		expect(block.content).toContain("not inlined (not readable)")
		expect(block.content).toContain("Use the read_file tool to read it")
		// No binary content enters the block.
		expect(block.content).not.toContain("BINPAYLOAD")
	})

	it("bounds a notebook whose one oversized source line would pass the line caps", async () => {
		const dir = await makeFolder(cwd, "nb")
		const cells = [
			{
				cell_type: "code",
				source: [`${"H".repeat(2_000_000)} END_OF_HUGE\n`],
				metadata: {},
				outputs: [],
				execution_count: null,
			},
			{
				cell_type: "code",
				source: ["TAIL_AFTER_HUGE\n"],
				metadata: {},
				outputs: [],
				execution_count: null,
			},
		]
		await fs.writeFile(
			path.join(dir, "big.ipynb"),
			JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 2 }),
			"utf8",
		)
		await writeLines(dir, "normal.txt", 10, "NORM")

		const result = await parseMentions("@/nb/", cwd, undefined, allowAllController())
		const block = result.contentBlocks[0]

		// The oversized line passes both line caps as a single line; the
		// character budget is what keeps the block bounded. No complete line
		// of the notebook fits it, so the notebook is named, not dumped.
		expect(block.content.length).toBeLessThan(20_000)
		expect(block.content).toContain("big.ipynb")
		expect(block.content).toContain("not inlined (folder budget reached)")
		expect(block.content).not.toContain("END_OF_HUGE")
		expect(block.content).not.toContain("TAIL_AFTER_HUGE")
		// The plain neighbor file inlines in full.
		expect(block.content).toContain("NORM_LINE_10")
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
