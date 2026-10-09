import { MAX_READ_FILES, readFilesParamsSchema, isLegacyReadFileParams, READ_FILES_TOOL_NAME } from "../read-files.js"
import * as publicTypes from "../../index.js"
import * as compatibilityTypes from "../../tool-params.js"
import type { ReadFileParams, ReadFileToolParams } from "../../tool-params.js"
import type { ReadFilesParams, LegacyReadFileParams, FileEntry, LineRange } from "../read-files.js"

describe("multiple-file reading contracts", () => {
	it("exposes the same runtime contract through feature, public and compatibility modules", () => {
		for (const exports of [publicTypes, compatibilityTypes]) {
			expect(exports.MAX_READ_FILES).toBe(MAX_READ_FILES)
			expect(exports.readFilesParamsSchema).toBe(readFilesParamsSchema)
			expect(exports.isLegacyReadFileParams).toBe(isLegacyReadFileParams)
		}
	})

	it("preserves public and compatibility type exports", () => {
		expectTypeOf<publicTypes.ReadFilesParams>().toEqualTypeOf<ReadFilesParams>()
		expectTypeOf<compatibilityTypes.ReadFilesParams>().toEqualTypeOf<ReadFilesParams>()
		expectTypeOf<publicTypes.LegacyReadFileParams>().toEqualTypeOf<LegacyReadFileParams>()
		expectTypeOf<compatibilityTypes.LegacyReadFileParams>().toEqualTypeOf<LegacyReadFileParams>()
		expectTypeOf<publicTypes.FileEntry>().toEqualTypeOf<FileEntry>()
		expectTypeOf<compatibilityTypes.FileEntry>().toEqualTypeOf<FileEntry>()
		expectTypeOf<publicTypes.LineRange>().toEqualTypeOf<LineRange>()
		expectTypeOf<compatibilityTypes.LineRange>().toEqualTypeOf<LineRange>()
		expectTypeOf<ReadFilesParams["entries"][number]>().toMatchTypeOf<ReadFileParams>()
	})

	describe("bounded native batches", () => {
		it("shares the canonical tool name with the public tool registry", () => {
			expect(publicTypes.READ_FILES_TOOL_NAME).toBe(READ_FILES_TOOL_NAME)
			expect(publicTypes.toolNames).toContain(READ_FILES_TOOL_NAME)
			expect(publicTypes.toolNamesSchema.parse(READ_FILES_TOOL_NAME)).toBe(READ_FILES_TOOL_NAME)
		})

		it("retains independent slice and indentation parameters", () => {
			const batch: ReadFilesParams = {
				entries: [
					{ path: "source.ts", offset: 10, limit: 5 },
					{ path: "test.ts", mode: "indentation", indentation: { anchor_line: 42, include_header: false } },
				],
			}
			expect(readFilesParamsSchema.parse(batch)).toEqual(batch)
		})

		it("normalizes strict-provider nulls without losing false or zero", () => {
			expect(
				readFilesParamsSchema.parse({
					entries: [
						{
							path: "source.ts",
							mode: null,
							offset: null,
							limit: null,
							indentation: {
								anchor_line: null,
								max_levels: 0,
								include_siblings: false,
								include_header: false,
								max_lines: null,
							},
						},
					],
				}),
			).toEqual({
				entries: [
					{
						path: "source.ts",
						mode: undefined,
						offset: undefined,
						limit: undefined,
						indentation: {
							anchor_line: undefined,
							max_levels: 0,
							include_siblings: false,
							include_header: false,
							max_lines: undefined,
						},
					},
				],
			})
		})

		it("accepts the maximum batch size", () => {
			expect(
				readFilesParamsSchema.safeParse({
					entries: Array.from({ length: MAX_READ_FILES }, () => ({ path: "source.ts" })),
				}).success,
			).toBe(true)
		})

		it.each([
			{ entries: [] },
			{ entries: Array.from({ length: MAX_READ_FILES + 1 }, () => ({ path: "source.ts" })) },
			{ entries: [{ path: "" }] },
			{ entries: [{ path: "source.ts", offset: 0 }] },
			{ entries: [{ path: "source.ts", limit: 1.5 }] },
			{ entries: [{ path: "source.ts", indentation: { max_levels: -1 } }] },
			{ entries: [{ path: "source.ts", lineRanges: [{ start: 1, end: 2 }] }] },
			{ files: [{ path: "source.ts" }] },
		])("still rejects malformed or legacy native batches: %j", (params) => {
			expect(readFilesParamsSchema.safeParse(params).success).toBe(false)
		})
	})

	describe("legacy conversation compatibility", () => {
		it("recognizes tagged legacy reads and preserves type narrowing", () => {
			const params: ReadFileToolParams = {
				files: [{ path: "source.ts", lineRanges: [{ start: 1, end: 3 }] }],
				_legacyFormat: true,
			}
			expect(isLegacyReadFileParams(params)).toBe(true)
			if (isLegacyReadFileParams(params)) expect(params.files[0]?.lineRanges).toEqual([{ start: 1, end: 3 }])
		})

		it("recognizes persisted untagged legacy reads", () => {
			// Histories predating the discriminant are valid runtime inputs even
			// though new callers must use the tagged LegacyReadFileParams type.
			const persisted = { files: [{ path: "source.ts" }] } as ReadFileToolParams
			expect(isLegacyReadFileParams(persisted)).toBe(true)
		})

		it("does not classify ordinary single-file reads as legacy", () => {
			expect(isLegacyReadFileParams({ path: "source.ts", offset: 3 })).toBe(false)
		})
	})
})
