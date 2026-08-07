import { describe, it, expect } from "vitest"
import {
	createEmptyTaskOrganizationState,
	taskOrganizationTargetSchema,
	pinnedItemSchema,
	manualTaskFolderSchema,
	taskOrganizationStateSchema,
	taskOrganizationMutationSchema,
	taskOrganizationMutationRequestSchema,
	taskOrganizationMutationResultSchema,
	MAX_PINNED_TARGETS,
} from "../task-organization.js"

describe("task-organization types and schemas", () => {
	describe("createEmptyTaskOrganizationState", () => {
		it("creates default state using Date.now when no clock is provided", () => {
			const state = createEmptyTaskOrganizationState()
			expect(state.schemaVersion).toBe(1)
			expect(state.revision).toBe(0)
			expect(state.folders).toEqual([])
			expect(state.pins).toEqual([])
			expect(typeof state.updatedAt).toBe("number")
			expect(state.updatedAt).toBeGreaterThan(0)
		})

		it("uses injected custom clock function when provided", () => {
			const customNow = () => 123456789
			const state = createEmptyTaskOrganizationState(customNow)
			expect(state.updatedAt).toBe(123456789)
		})
	})

	describe("taskOrganizationTargetSchema", () => {
		it("parses valid task target", () => {
			const parsed = taskOrganizationTargetSchema.safeParse({ kind: "task", taskId: "t1" })
			expect(parsed.success).toBe(true)
		})

		it("parses valid autoGroup target", () => {
			const parsed = taskOrganizationTargetSchema.safeParse({ kind: "autoGroup", rootTaskId: "root1" })
			expect(parsed.success).toBe(true)
		})

		it("parses valid folder target", () => {
			const parsed = taskOrganizationTargetSchema.safeParse({ kind: "folder", folderId: "f1" })
			expect(parsed.success).toBe(true)
		})

		it("rejects invalid target kind", () => {
			const parsed = taskOrganizationTargetSchema.safeParse({ kind: "unknown", id: "123" })
			expect(parsed.success).toBe(false)
		})
	})

	describe("pinnedItemSchema", () => {
		it("parses a valid pinned item", () => {
			const item = {
				target: { kind: "task", taskId: "t1" },
				pinnedAt: 1000,
			}
			const parsed = pinnedItemSchema.safeParse(item)
			expect(parsed.success).toBe(true)
		})
	})

	describe("manualTaskFolderSchema", () => {
		it("parses a valid manual folder", () => {
			const folder = {
				folderId: "f1",
				name: "My Folder",
				taskIds: ["t1", "t2"],
				createdAt: 100,
				updatedAt: 200,
			}
			const parsed = manualTaskFolderSchema.safeParse(folder)
			expect(parsed.success).toBe(true)
		})

		it("rejects empty folder name", () => {
			const folder = {
				folderId: "f1",
				name: "",
				taskIds: [],
				createdAt: 100,
				updatedAt: 200,
			}
			const parsed = manualTaskFolderSchema.safeParse(folder)
			expect(parsed.success).toBe(false)
		})
	})

	describe("taskOrganizationStateSchema", () => {
		it("enforces max pinned targets limit", () => {
			const state = {
				schemaVersion: 1,
				revision: 0,
				folders: [],
				pins: Array.from({ length: MAX_PINNED_TARGETS + 1 }, (_, i) => ({
					target: { kind: "task", taskId: `t${i}` },
					pinnedAt: 1000 + i,
				})),
				updatedAt: 1000,
			}
			const parsed = taskOrganizationStateSchema.safeParse(state)
			expect(parsed.success).toBe(false)
		})

		it("accepts positive integer schema versions", () => {
			const state = {
				schemaVersion: 2,
				revision: 5,
				folders: [],
				pins: [],
				updatedAt: 2000,
			}
			const parsed = taskOrganizationStateSchema.safeParse(state)
			expect(parsed.success).toBe(true)
		})
	})

	describe("taskOrganizationMutationSchema", () => {
		it("validates all mutation variants", () => {
			expect(
				taskOrganizationMutationSchema.safeParse({
					kind: "createFolder",
					folderId: "f1",
					name: "Folder",
					source: { kind: "task", taskId: "t1" },
					destination: { kind: "task", taskId: "t2" },
				}).success,
			).toBe(true)

			expect(
				taskOrganizationMutationSchema.safeParse({
					kind: "createFolderFromSelection",
					folderId: "f1",
					name: "Folder",
					targets: [
						{ kind: "task", taskId: "t1" },
						{ kind: "task", taskId: "t2" },
					],
				}).success,
			).toBe(true)

			expect(
				taskOrganizationMutationSchema.safeParse({
					kind: "deleteFolders",
					folderIds: ["f1"],
				}).success,
			).toBe(true)

			expect(
				taskOrganizationMutationSchema.safeParse({
					kind: "renameFolder",
					folderId: "f1",
					name: "New Name",
				}).success,
			).toBe(true)

			expect(
				taskOrganizationMutationSchema.safeParse({
					kind: "deleteFolder",
					folderId: "f1",
				}).success,
			).toBe(true)

			expect(
				taskOrganizationMutationSchema.safeParse({
					kind: "moveToFolder",
					source: { kind: "task", taskId: "t1" },
					folderId: "f1",
				}).success,
			).toBe(true)

			expect(
				taskOrganizationMutationSchema.safeParse({
					kind: "removeFromFolder",
					source: { kind: "task", taskId: "t1" },
					folderId: "f1",
				}).success,
			).toBe(true)

			expect(
				taskOrganizationMutationSchema.safeParse({
					kind: "setPinned",
					target: { kind: "task", taskId: "t1" },
					pinned: true,
				}).success,
			).toBe(true)
		})
	})

	describe("taskOrganizationMutationRequestSchema and taskOrganizationMutationResultSchema", () => {
		it("parses request and result schemas", () => {
			const req = {
				requestId: "req-1",
				baseRevision: 0,
				mutation: {
					kind: "deleteFolder",
					folderId: "f1",
				},
			}
			expect(taskOrganizationMutationRequestSchema.safeParse(req).success).toBe(true)

			const res = {
				requestId: "req-1",
				success: true,
				committedRevision: 1,
			}
			expect(taskOrganizationMutationResultSchema.safeParse(res).success).toBe(true)
		})
	})
})
