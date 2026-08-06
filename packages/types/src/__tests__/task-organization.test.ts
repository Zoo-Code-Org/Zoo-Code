// npx vitest run src/__tests__/task-organization.test.ts

import {
	MAX_PINNED_TARGETS,
	createEmptyTaskOrganizationState,
	pinnedItemSchema,
	manualTaskFolderSchema,
	taskOrganizationStateSchema,
	taskOrganizationMutationSchema,
	taskOrganizationMutationRequestSchema,
	taskOrganizationMutationResultSchema,
	taskOrganizationTargetSchema,
} from "../task-organization.js"

describe("taskOrganizationTargetSchema", () => {
	it("accepts a task target", () => {
		expect(taskOrganizationTargetSchema.safeParse({ kind: "task", taskId: "t1" }).success).toBe(true)
	})

	it("accepts an autoGroup target", () => {
		expect(taskOrganizationTargetSchema.safeParse({ kind: "autoGroup", rootTaskId: "root" }).success).toBe(true)
	})

	it("accepts a folder target", () => {
		expect(taskOrganizationTargetSchema.safeParse({ kind: "folder", folderId: "f1" }).success).toBe(true)
	})

	it("rejects an unknown target kind", () => {
		expect(taskOrganizationTargetSchema.safeParse({ kind: "unknown", taskId: "t1" }).success).toBe(false)
	})

	it("rejects a task target missing its taskId", () => {
		expect(taskOrganizationTargetSchema.safeParse({ kind: "task" }).success).toBe(false)
	})
})

describe("pinnedItemSchema", () => {
	it("accepts a valid pinned item", () => {
		expect(
			pinnedItemSchema.safeParse({ target: { kind: "task", taskId: "t1" }, pinnedAt: 1000 }).success,
		).toBe(true)
	})

	it("rejects a pinned item with a non-numeric timestamp", () => {
		expect(
			pinnedItemSchema.safeParse({ target: { kind: "task", taskId: "t1" }, pinnedAt: "now" }).success,
		).toBe(false)
	})
})

describe("manualTaskFolderSchema", () => {
	it("accepts a valid folder", () => {
		expect(
			manualTaskFolderSchema.safeParse({
				folderId: "f1",
				name: "Folder",
				taskIds: ["t1", "t2"],
				createdAt: 1000,
				updatedAt: 1000,
			}).success,
		).toBe(true)
	})

	it("rejects an empty folder name", () => {
		expect(
			manualTaskFolderSchema.safeParse({
				folderId: "f1",
				name: "",
				taskIds: [],
				createdAt: 1000,
				updatedAt: 1000,
			}).success,
		).toBe(false)
	})

	it("rejects a folder name longer than 80 characters", () => {
		expect(
			manualTaskFolderSchema.safeParse({
				folderId: "f1",
				name: "x".repeat(81),
				taskIds: [],
				createdAt: 1000,
				updatedAt: 1000,
			}).success,
		).toBe(false)
	})
})

describe("taskOrganizationStateSchema", () => {
	it("accepts a valid version-1 state", () => {
		const state = {
			schemaVersion: 1,
			revision: 0,
			folders: [],
			pins: [],
			updatedAt: 1000,
		}
		expect(taskOrganizationStateSchema.safeParse(state).success).toBe(true)
	})

	it("accepts a future schema version so the store can handle it gracefully", () => {
		const state = {
			schemaVersion: 99,
			revision: 1,
			folders: [],
			pins: [],
			updatedAt: 1000,
		}
		expect(taskOrganizationStateSchema.safeParse(state).success).toBe(true)
	})

	it("rejects a negative revision", () => {
		const state = {
			schemaVersion: 1,
			revision: -1,
			folders: [],
			pins: [],
			updatedAt: 1000,
		}
		expect(taskOrganizationStateSchema.safeParse(state).success).toBe(false)
	})

	it("rejects more than MAX_PINNED_TARGETS pins", () => {
		const pins = Array.from({ length: MAX_PINNED_TARGETS + 1 }, (_, i) => ({
			target: { kind: "task", taskId: `t${i}` },
			pinnedAt: 1000,
		}))
		const state = {
			schemaVersion: 1,
			revision: 0,
			folders: [],
			pins,
			updatedAt: 1000,
		}
		expect(taskOrganizationStateSchema.safeParse(state).success).toBe(false)
	})
})

describe("taskOrganizationMutationSchema", () => {
	it("accepts every mutation kind", () => {
		const mutations = [
			{
				kind: "createFolder",
				folderId: "f1",
				name: "A",
				source: { kind: "task", taskId: "t1" },
				destination: { kind: "task", taskId: "t2" },
			},
			{
				kind: "createFolderFromSelection",
				folderId: "f1",
				name: "A",
				targets: [
					{ kind: "task", taskId: "t1" },
					{ kind: "task", taskId: "t2" },
				],
			},
			{ kind: "deleteFolders", folderIds: ["f1", "f2"] },
			{ kind: "renameFolder", folderId: "f1", name: "Renamed" },
			{ kind: "deleteFolder", folderId: "f1" },
			{ kind: "moveToFolder", source: { kind: "task", taskId: "t1" }, folderId: "f1" },
			{ kind: "removeFromFolder", source: { kind: "task", taskId: "t1" }, folderId: "f1" },
			{ kind: "setPinned", target: { kind: "task", taskId: "t1" }, pinned: true },
		]
		for (const mutation of mutations) {
			expect(taskOrganizationMutationSchema.safeParse(mutation).success).toBe(true)
		}
	})

	it("rejects an unknown mutation kind", () => {
		expect(taskOrganizationMutationSchema.safeParse({ kind: "explode" }).success).toBe(false)
	})

	it("rejects createFolderFromSelection with fewer than two targets", () => {
		expect(
			taskOrganizationMutationSchema.safeParse({
				kind: "createFolderFromSelection",
				folderId: "f1",
				name: "A",
				targets: [{ kind: "task", taskId: "t1" }],
			}).success,
		).toBe(false)
	})

	it("rejects deleteFolders with an empty folderIds array", () => {
		expect(taskOrganizationMutationSchema.safeParse({ kind: "deleteFolders", folderIds: [] }).success).toBe(false)
	})
})

describe("taskOrganizationMutationRequestSchema", () => {
	it("accepts a valid request", () => {
		expect(
			taskOrganizationMutationRequestSchema.safeParse({
				requestId: "req-1",
				baseRevision: 3,
				mutation: { kind: "setPinned", target: { kind: "task", taskId: "t1" }, pinned: true },
			}).success,
		).toBe(true)
	})

	it("rejects a negative baseRevision", () => {
		expect(
			taskOrganizationMutationRequestSchema.safeParse({
				requestId: "req-1",
				baseRevision: -1,
				mutation: { kind: "setPinned", target: { kind: "task", taskId: "t1" }, pinned: true },
			}).success,
		).toBe(false)
	})
})

describe("taskOrganizationMutationResultSchema", () => {
	it("accepts a success result without an error", () => {
		expect(
			taskOrganizationMutationResultSchema.safeParse({
				requestId: "req-1",
				success: true,
				committedRevision: 4,
			}).success,
		).toBe(true)
	})

	it("accepts a failure result with a typed error code", () => {
		expect(
			taskOrganizationMutationResultSchema.safeParse({
				requestId: "req-1",
				success: false,
				committedRevision: 3,
				error: { code: "TASK_ORG/CONFLICT/002", message: "Organization state has changed. Please retry." },
			}).success,
		).toBe(true)
	})

	it("rejects an unknown error code", () => {
		expect(
			taskOrganizationMutationResultSchema.safeParse({
				requestId: "req-1",
				success: false,
				committedRevision: 3,
				error: { code: "TASK_ORG/UNKNOWN/999", message: "nope" },
			}).success,
		).toBe(false)
	})
})

describe("createEmptyTaskOrganizationState", () => {
	it("creates an empty version-1 state with a fixed clock", () => {
		const state = createEmptyTaskOrganizationState(() => 1234)
		expect(state).toEqual({
			schemaVersion: 1,
			revision: 0,
			folders: [],
			pins: [],
			updatedAt: 1234,
		})
	})

	it("uses Date.now when no clock is provided", () => {
		const before = Date.now()
		const state = createEmptyTaskOrganizationState()
		const after = Date.now()
		expect(state.updatedAt).toBeGreaterThanOrEqual(before)
		expect(state.updatedAt).toBeLessThanOrEqual(after)
	})
})
