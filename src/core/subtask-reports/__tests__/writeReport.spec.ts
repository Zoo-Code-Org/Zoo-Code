// pnpm --dir src exec vitest run core/subtask-reports/__tests__/writeReport.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { getSubtaskReportsDir, resolveReportPath, sanitizeReportLabel, writeSubtaskReport } from ".."

// Rename is forced to fail in the atomicity test, open is wrapped to plant a
// decoy in the exclusive-create test, and writeFile is wrapped to fail after
// the exclusive create in the write-failure test; everything else stays real
// so the suite exercises the true filesystem path.
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		open: vi.fn(actual.open),
		rename: vi.fn(actual.rename),
		writeFile: vi.fn(actual.writeFile),
	}
})

import { open, rename, writeFile } from "fs/promises"

const openMock = vi.mocked(open)
const renameMock = vi.mocked(rename)
const writeFileMock = vi.mocked(writeFile)

describe("subtask-reports", () => {
	let cwd: string

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "subtask-reports-"))
		openMock.mockClear()
		renameMock.mockClear()
		writeFileMock.mockClear()
	})

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true })
	})

	describe("sanitizeReportLabel", () => {
		it("replaces path separators and Windows-illegal characters with dashes", () => {
			expect(sanitizeReportLabel('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j")
		})

		it("strips control characters", () => {
			const label = "re" + String.fromCharCode(1) + "port"
			expect(sanitizeReportLabel(label)).toBe("re-port")
		})

		it("falls back to 'subtask' when nothing safe remains", () => {
			expect(sanitizeReportLabel("..")).toBe("subtask")
			expect(sanitizeReportLabel("   ")).toBe("subtask")
		})

		it("prefixes Windows-reserved device names, with or without an extension", () => {
			expect(sanitizeReportLabel("CON")).toBe("_CON")
			expect(sanitizeReportLabel("con.txt")).toBe("_con.txt")
			expect(sanitizeReportLabel("lpt3")).toBe("_lpt3")
			expect(sanitizeReportLabel("console")).toBe("console")
		})

		it("truncates long labels to 60 characters", () => {
			const long = "a".repeat(100)
			expect(sanitizeReportLabel(long)).toBe("a".repeat(60))
		})
	})

	describe("writeSubtaskReport naming", () => {
		it("writes to <cwd>/.zoocode/subtask-reports/<parentTaskId>/<safe-label>-<childTaskId>.md", async () => {
			const report = await writeSubtaskReport({
				cwd,
				parentTaskId: "parent-1",
				childTaskId: "child-1",
				label: "api-surface",
				markdown: "# Findings",
			})

			const expectedDir = getSubtaskReportsDir(cwd, "parent-1")
			expect(expectedDir).toBe(path.join(cwd, ".zoocode", "subtask-reports", "parent-1"))
			expect(report.path).toBe(path.join(expectedDir, "api-surface-child-1.md"))
			expect(path.basename(report.path)).toBe("api-surface-child-1.md")
			expect(await fs.readFile(report.path, "utf8")).toBe("# Findings")
		})

		it("gives two siblings with identical labels different paths", async () => {
			const first = await writeSubtaskReport({
				cwd,
				parentTaskId: "parent-1",
				childTaskId: "child-a",
				label: "dupe",
				markdown: "first",
			})
			const second = await writeSubtaskReport({
				cwd,
				parentTaskId: "parent-1",
				childTaskId: "child-b",
				label: "dupe",
				markdown: "second",
			})

			expect(first.path).not.toBe(second.path)
			expect(await fs.readFile(first.path, "utf8")).toBe("first")
			expect(await fs.readFile(second.path, "utf8")).toBe("second")
		})

		it("keeps a sanitized traversal label inside the reports directory", async () => {
			const report = await writeSubtaskReport({
				cwd,
				parentTaskId: "parent-1",
				childTaskId: "child-1",
				label: "../../escape",
				markdown: "content",
			})

			const root = path.resolve(getSubtaskReportsDir(cwd, "parent-1"))
			expect(path.resolve(report.path).startsWith(root + path.sep)).toBe(true)
			expect(path.basename(report.path)).toBe("..-..-escape-child-1.md")
			// Nothing was written outside the reports directory.
			const outside = path.resolve(cwd, ".zoocode", "escape-child-1.md")
			await expect(fs.access(outside)).rejects.toThrow()
		})

		it("rejects a path that resolves outside the reports directory", async () => {
			const reportsDir = getSubtaskReportsDir(cwd, "parent-1")
			// The child task id is host-generated in production; a separator-laden
			// value proves the containment guard fires regardless of the input.
			await expect(resolveReportPath(reportsDir, "safe", "../../../escape")).rejects.toThrow(
				/escapes the reports directory/,
			)
		})

		it("truncates a long label in the filename", async () => {
			const report = await writeSubtaskReport({
				cwd,
				parentTaskId: "parent-1",
				childTaskId: "child-1",
				label: "x".repeat(100),
				markdown: "content",
			})
			expect(path.basename(report.path)).toBe(`${"x".repeat(60)}-child-1.md`)
		})

		it("writes a long Unicode label whose full destination basename approaches the 255-byte limit", async () => {
			// 60 label characters at 3 UTF-8 bytes each plus a 36-character child
			// id puts the destination basename near ext4's 255-byte component cap.
			// The old temp name embedded the destination basename and overflowed
			// that cap; the short temp name must keep the write working.
			const label = "界".repeat(60)
			const childTaskId = "0b8c1f6e-3c2a-4e6b-9d8b-1f2e3d4c5b6a"
			const markdown = "# 유니코드 보고서\n\n본문 내용이 그대로 저장된다."
			const report = await writeSubtaskReport({
				cwd,
				parentTaskId: "parent-1",
				childTaskId,
				label,
				markdown,
			})

			expect(path.basename(report.path)).toBe(`${label}-${childTaskId}.md`)
			expect(Buffer.byteLength(path.basename(report.path), "utf8")).toBeLessThanOrEqual(255)
			const tempPath = renameMock.mock.calls[0][0] as string
			expect(path.dirname(tempPath)).toBe(path.dirname(report.path))
			expect(Buffer.byteLength(path.basename(tempPath), "utf8")).toBeLessThanOrEqual(255)
			expect(await fs.readFile(report.path, "utf8")).toBe(markdown)
			const dirEntries = await fs.readdir(path.dirname(report.path))
			expect(dirEntries).toEqual([path.basename(report.path)])
		})

		it("handles a Windows-reserved label", async () => {
			const report = await writeSubtaskReport({
				cwd,
				parentTaskId: "parent-1",
				childTaskId: "child-1",
				label: "CON",
				markdown: "content",
			})
			expect(path.basename(report.path)).toBe("_CON-child-1.md")
		})
	})

	describe("writeSubtaskReport atomicity", () => {
		it("commits by rename: the temp file is gone and only the target exists", async () => {
			const report = await writeSubtaskReport({
				cwd,
				parentTaskId: "parent-1",
				childTaskId: "child-1",
				label: "api",
				markdown: "# Report",
			})

			expect(renameMock).toHaveBeenCalledOnce()
			const [tempPath, targetPath] = renameMock.mock.calls[0]
			expect(targetPath).toBe(report.path)
			await expect(fs.access(tempPath as string)).rejects.toThrow()
			await expect(fs.access(report.path)).resolves.toBeUndefined()

			const dirEntries = await fs.readdir(path.dirname(report.path))
			expect(dirEntries).toEqual(["api-child-1.md"])
		})

		it("throws on a failed rename and leaves no partial target or temp file", async () => {
			renameMock.mockRejectedValueOnce(new Error("rename boom"))

			await expect(
				writeSubtaskReport({
					cwd,
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					label: "api",
					markdown: "# Report",
				}),
			).rejects.toThrow("rename boom")

			const reportsDir = getSubtaskReportsDir(cwd, "parent-1")
			await expect(fs.access(path.join(reportsDir, "api-child-1.md"))).rejects.toThrow()
			const dirEntries = await fs.readdir(reportsDir)
			expect(dirEntries.filter((entry) => entry.startsWith(".tmp-"))).toEqual([])
		})

		it("lands concurrent writes to different paths", async () => {
			const [first, second] = await Promise.all([
				writeSubtaskReport({
					cwd,
					parentTaskId: "parent-1",
					childTaskId: "child-a",
					label: "same-label",
					markdown: "a",
				}),
				writeSubtaskReport({
					cwd,
					parentTaskId: "parent-1",
					childTaskId: "child-b",
					label: "same-label",
					markdown: "b",
				}),
			])

			expect(first.path).not.toBe(second.path)
			expect(await fs.readFile(first.path, "utf8")).toBe("a")
			expect(await fs.readFile(second.path, "utf8")).toBe("b")
		})

		it("creates the temp file exclusively: a pre-planted temp path fails the write and the decoy survives", async () => {
			const realFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
			let decoyPath = ""
			openMock.mockImplementationOnce(async (file, flags) => {
				// Plant a decoy at the exact temp path before the writer's own
				// exclusive create, standing in for a symlink or concurrent writer
				// planted between path generation and the create.
				decoyPath = file as string
				await realFs.writeFile(decoyPath, "planted-decoy", "utf8")
				return realFs.open(decoyPath, flags as string)
			})

			await expect(
				writeSubtaskReport({
					cwd,
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					label: "api",
					markdown: "# Report",
				}),
			).rejects.toThrow(/EEXIST/)

			// The writer must pass the O_EXCL-style flag to the create, not a
			// plain overwrite.
			expect(openMock.mock.calls[0][1]).toBe("wx")

			// The decoy was planted by someone else: the failed exclusive create
			// must not delete it, and the rename must never run against it. Only
			// the acquired-temp cleanup path may remove files.
			expect(decoyPath).not.toBe("")
			expect(path.basename(decoyPath)).toMatch(/^\.tmp-/)
			expect(await fs.readFile(decoyPath, "utf8")).toBe("planted-decoy")
			expect(renameMock).not.toHaveBeenCalled()

			// The real target never received a report.
			const reportsDir = getSubtaskReportsDir(cwd, "parent-1")
			await expect(fs.access(path.join(reportsDir, "api-child-1.md"))).rejects.toThrow()
		})

		it("removes the owned temp file when the write fails after the exclusive create", async () => {
			const realFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
			writeFileMock.mockImplementationOnce(async (file, data, options) => {
				// The exclusive create already succeeded and the writer owns the
				// temp file; the data write itself then fails, as a full disk
				// fails only after Node opens the file. The fragment really
				// exists on disk, so the cleanup assertion below cannot pass
				// vacuously.
				await realFs.writeFile(file, data, options)
				throw new Error("disk full")
			})

			await expect(
				writeSubtaskReport({
					cwd,
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					label: "api",
					markdown: "# Report",
				}),
			).rejects.toThrow("disk full")

			// The writer owned the temp file even though the write failed, so
			// the failure cleanup must remove it: no .tmp- fragment remains and
			// the target was never published.
			const reportsDir = getSubtaskReportsDir(cwd, "parent-1")
			await expect(fs.access(path.join(reportsDir, "api-child-1.md"))).rejects.toThrow()
			const dirEntries = await fs.readdir(reportsDir)
			expect(dirEntries.filter((entry) => entry.startsWith(".tmp-"))).toEqual([])
		})

		it("does not publish the report when closing the temp file fails after a successful write", async () => {
			const realFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
			openMock.mockImplementationOnce(async (file, flags) => {
				// Some filesystems (NFS) report a quota or space failure at
				// close() time, after the write itself resolved. The close
				// rejection must fail the write, not be swallowed into a rename.
				const handle = await realFs.open(file as string, flags as string)
				const realClose = handle.close.bind(handle)
				handle.close = async () => {
					await realClose()
					throw new Error("close boom")
				}
				return handle
			})

			await expect(
				writeSubtaskReport({
					cwd,
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					label: "api",
					markdown: "# Report",
				}),
			).rejects.toThrow("close boom")

			// The close failure reached the owned-temp cleanup: the rename
			// never ran, the target was never published, and no .tmp- fragment
			// remains.
			expect(renameMock).not.toHaveBeenCalled()
			const reportsDir = getSubtaskReportsDir(cwd, "parent-1")
			await expect(fs.access(path.join(reportsDir, "api-child-1.md"))).rejects.toThrow()
			const dirEntries = await fs.readdir(reportsDir)
			expect(dirEntries.filter((entry) => entry.startsWith(".tmp-"))).toEqual([])
		})

		it("preserves the original write error when the close also fails", async () => {
			const realFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
			openMock.mockImplementationOnce(async (file, flags) => {
				const handle = await realFs.open(file as string, flags as string)
				const realClose = handle.close.bind(handle)
				handle.close = async () => {
					await realClose()
					throw new Error("close boom")
				}
				return handle
			})
			writeFileMock.mockImplementationOnce(async (file, data, options) => {
				await realFs.writeFile(file, data, options)
				throw new Error("disk full")
			})

			await expect(
				writeSubtaskReport({
					cwd,
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					label: "api",
					markdown: "# Report",
				}),
			).rejects.toThrow("disk full")

			expect(renameMock).not.toHaveBeenCalled()
		})
	})

	describe("writeSubtaskReport workspace containment", () => {
		it("rejects a .zoocode symlink that resolves outside the workspace", async () => {
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "subtask-reports-outside-"))
			try {
				// A directory junction works on Windows without symlink
				// privileges and realpath resolves it like any symlink.
				await fs.symlink(outside, path.join(cwd, ".zoocode"), "junction")

				await expect(
					writeSubtaskReport({
						cwd,
						parentTaskId: "parent-1",
						childTaskId: "child-1",
						label: "api",
						markdown: "# Report",
					}),
				).rejects.toThrow(/escapes the workspace/)

				// The rejection fires before anything is created outside.
				expect(await fs.readdir(outside)).toEqual([])
				expect(renameMock).not.toHaveBeenCalled()
			} finally {
				await fs.rm(outside, { recursive: true, force: true })
			}
		})

		it("rejects a subtask-reports symlink nested in the workspace that resolves outside it", async () => {
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "subtask-reports-outside-"))
			try {
				await fs.mkdir(path.join(cwd, ".zoocode"), { recursive: true })
				await fs.symlink(outside, path.join(cwd, ".zoocode", "subtask-reports"), "junction")

				await expect(
					writeSubtaskReport({
						cwd,
						parentTaskId: "parent-1",
						childTaskId: "child-1",
						label: "api",
						markdown: "# Report",
					}),
				).rejects.toThrow(/escapes the workspace/)

				expect(await fs.readdir(outside)).toEqual([])
				expect(renameMock).not.toHaveBeenCalled()
			} finally {
				await fs.rm(outside, { recursive: true, force: true })
			}
		})

		it("writes normally when .zoocode is a symlink to a directory inside the workspace", async () => {
			const realHome = path.join(cwd, "real-home")
			await fs.mkdir(realHome, { recursive: true })
			await fs.symlink(realHome, path.join(cwd, ".zoocode"), "junction")

			const report = await writeSubtaskReport({
				cwd,
				parentTaskId: "parent-1",
				childTaskId: "child-1",
				label: "api",
				markdown: "# Findings",
			})

			expect(report.path).toBe(path.join(getSubtaskReportsDir(cwd, "parent-1"), "api-child-1.md"))
			expect(await fs.readFile(report.path, "utf8")).toBe("# Findings")
			// The content landed in the symlink's target, still in the workspace.
			const canonicalCopy = path.join(realHome, "subtask-reports", "parent-1", "api-child-1.md")
			expect(await fs.readFile(canonicalCopy, "utf8")).toBe("# Findings")
		})
	})
})
