// npx vitest core/mentions/__tests__/index.spec.ts

import { parseMentions } from "../index"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// Mock vscode
vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
	},
}))

// Mock i18n
vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

describe("parseMentions - URL mention handling", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("should replace URL mentions with quoted URL reference", async () => {
		const result = await parseMentions("Check @https://example.com", "/test")

		// URL mentions are now replaced with a quoted reference (no fetching)
		expect(result.text).toContain("'https://example.com'")
	})
})

// Review round 4 (Regression Evidence): the PR's contract closes at the
// mention-resolution layer. The tracker offers an opened tab as an
// anchor-relative single-slash mention (@/../../elsewhere/b.ts when the
// anchor is /anchor/dir). parseMentions must resolve that value back to
// the open file, even when a cwd-relative file with the same tail also
// exists - the tab file wins. These tests call the real resolver with real
// files; the utils-level round-trip in path.spec.ts stays as the algebra pin.
describe("parseMentions - opened-tab values cut against the task anchor (issue #1271)", () => {
	let root: string
	let anchorDir: string

	const TAB_MARKER = "tab-copy-content-4f1d"
	const SHADOW_MARKER = "cwd-shadow-content-9d28"
	const LOCAL_MARKER = "anchor-local-content-7c3e"

	beforeEach(() => {
		// The anchor sits two levels deep, so the anchor-relative tab value
		// /../../elsewhere/b.ts escapes to root/elsewhere/b.ts.
		root = fs.mkdtempSync(path.join(os.tmpdir(), "mentions-anchor-"))
		anchorDir = path.join(root, "level-one", "level-two", "task-cwd")
		fs.mkdirSync(path.join(anchorDir, "elsewhere"), { recursive: true })
		fs.mkdirSync(path.join(root, "elsewhere"), { recursive: true })
		// The open tab: two levels above the anchor, so the tracker's value
		// for it is exactly ../../elsewhere/b.ts.
		fs.mkdirSync(path.join(root, "level-one", "elsewhere"), { recursive: true })
		fs.writeFileSync(path.join(root, "level-one", "elsewhere", "b.ts"), TAB_MARKER)
		// A cwd-relative file with the same tail, inside the anchor.
		fs.writeFileSync(path.join(anchorDir, "elsewhere", "b.ts"), SHADOW_MARKER)
		// A file sitting next to the anchor.
		fs.writeFileSync(path.join(anchorDir, "a.ts"), LOCAL_MARKER)
	})

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true })
	})

	it("resolves an anchor-relative tab mention to the open tab file when a cwd-relative shadow shares the tail", async () => {
		const result = await parseMentions("look at @/../../elsewhere/b.ts", anchorDir)

		expect(result.contentBlocks).toHaveLength(1)
		const block = result.contentBlocks[0]
		expect(block.type).toBe("file")
		// The tab file supplied the content, not the cwd-relative shadow.
		expect(block.content).toContain(TAB_MARKER)
		expect(block.content).not.toContain(SHADOW_MARKER)
	})

	it("resolves a tab mention that sits next to the anchor", async () => {
		const result = await parseMentions("look at @/a.ts", anchorDir)

		expect(result.contentBlocks).toHaveLength(1)
		const block = result.contentBlocks[0]
		expect(block.type).toBe("file")
		expect(block.path).toBe("a.ts")
		expect(block.content).toContain(LOCAL_MARKER)
	})
})
