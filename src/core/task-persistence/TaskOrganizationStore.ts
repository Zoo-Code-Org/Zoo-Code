import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"
import {
	taskOrganizationStateSchema,
	taskOrganizationMutationSchema,
	MAX_PINNED_TARGETS,
	createEmptyTaskOrganizationState,
	type TaskOrganizationStateV1,
	type TaskOrganizationMutationV1,
	type TaskOrganizationTargetV1,
	type ManualTaskFolderV1,
	type PinnedItemV1,
	type TaskOrganizationErrorCode,
	type TaskOrganizationMutationRequestV1,
	type TaskOrganizationMutationResultV1,
} from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { safeUpdateJson } from "../../utils/safeWriteJson"
import { getStorageBasePath } from "../../utils/storage"

// eslint-disable-next-line no-control-regex -- Intentionally matching control characters to sanitize folder names
const INVALID_NAME_REGEX = /[\x00-\x1F\x7F]/

/**
 * Sanitized error that can be sent to the webview. It contains no stack trace,
 * disk path, task text, folder name, or raw parse content.
 */
export interface TaskOrganizationError {
	code: TaskOrganizationErrorCode
	message: string
}

/**
 * Options for TaskOrganizationStore constructor.
 */
export interface TaskOrganizationStoreOptions {
	/**
	 * Optional callback invoked when the reloaded on-disk aggregate differs
	 * from the in-memory snapshot (compared by content, not just revision).
	 * Called during watcher reloads and after each local mutation.
	 */
	onChange?: (state: TaskOrganizationStateV1) => Promise<void> | void

	/**
	 * Optional source of task history used to resolve automatic-group
	 * closures and validate task IDs. When omitted, the store accepts any
	 * task ID (useful in tests).
	 */
	taskHistory?: { get(taskId: string): HistoryItem | undefined }

	/**
	 * Optional custom clock. Defaults to Date.now.
	 */
	now?: () => number
}

/**
 * Encapsulates task organization persistence: manual folders, pinned targets,
 * and their atomic mutations.
 *
 * The store manages a single aggregate file at
 * `globalStorage/tasks/_taskOrganization.json`. All reads and writes use a
 * locked read-modify-write sequence, so cross-process concurrent mutations
 * are serialized and the revision monotonically increases.
 *
 * The in-memory state is a projection of the on-disk aggregate. A file watcher
 * reloads changes written by other extension instances and triggers the
 * onChange callback whenever the reloaded content differs.
 */
export class TaskOrganizationStore {
	private readonly globalStoragePath: string
	private readonly onChange?: (state: TaskOrganizationStateV1) => Promise<void> | void
	private readonly taskHistory?: { get(taskId: string): HistoryItem | undefined }
	private readonly now: () => number

	private state: TaskOrganizationStateV1 = createEmptyTaskOrganizationState(undefined)
	private writeLock: Promise<void> = Promise.resolve()
	private fsWatcher: fsSync.FSWatcher | null = null
	private watcherDebounce: ReturnType<typeof setTimeout> | null = null
	private disposed = false
	private readonly initialized: Promise<void>
	private resolveInitialized!: () => void

	constructor(globalStoragePath: string, options?: TaskOrganizationStoreOptions) {
		this.globalStoragePath = globalStoragePath
		this.onChange = options?.onChange
		this.taskHistory = options?.taskHistory
		this.now = options?.now ?? Date.now
		// Initialize state with the injected clock so that tests using a
		// fixed `now` function get deterministic timestamps.
		this.state = createEmptyTaskOrganizationState(this.now)
		this.initialized = new Promise<void>((resolve) => {
			this.resolveInitialized = resolve
		})
	}

	// ────────────────────────────── Lifecycle ──────────────────────────────

	/**
	 * Load the aggregate from disk, normalize it, and start the file watcher.
	 *
	 * - Missing file produces an in-memory empty version-1 state. It is not
	 *   written until the first mutation.
	 * - Valid version-1 data is parsed with Zod and normalized.
	 * - Unknown future schema versions are read-only failures.
	 * - Malformed data is quarantined, an empty state is loaded, and a warning
	 *   is logged without task text or folder names.
	 */
	async initialize(): Promise<void> {
		try {
			await this.load()
			this.startWatcher()
		} finally {
			this.resolveInitialized()
		}
	}

	/**
	 * Stop the file watcher and clear pending timers.
	 */
	dispose(): void {
		this.disposed = true
		if (this.watcherDebounce) {
			clearTimeout(this.watcherDebounce)
			this.watcherDebounce = null
		}
		if (this.fsWatcher) {
			this.fsWatcher.close()
			this.fsWatcher = null
		}
	}

	/**
	 * Promise that resolves when initialization is complete.
	 */
	async waitForInitialized(): Promise<void> {
		return this.initialized
	}

	// ────────────────────────────── Reads ──────────────────────────────

	/**
	 * Return a copy of the current in-memory state.
	 */
	getState(): TaskOrganizationStateV1 {
		try {
			return structuredClone(this.state)
		} catch (error) {
			console.error(
				`[TaskOrganizationStore] getState() structuredClone failed, returning empty state: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			return createEmptyTaskOrganizationState(this.now)
		}
	}

	// ────────────────────────────── Mutations ──────────────────────────────

	/**
	 * Apply a single idempotent mutation atomically.
	 *
	 * The file is locked during read, revision check, mutation, and write.
	 * If the expected revision does not match the on-disk revision, the
	 * mutation is rejected with a stale revision error.
	 */
	async mutate(
		mutation: TaskOrganizationMutationV1,
		expectedRevision: number,
	): Promise<TaskOrganizationMutationResultV1> {
		return this.withLock(async () => {
			const revisionAtCallTime = this.state.revision
			const requestId =
				"requestId" in mutation && typeof (mutation as Record<string, unknown>).requestId === "string"
					? ((mutation as Record<string, unknown>).requestId as string)
					: ""

			try {
				if (this.state.schemaVersion !== 1) {
					return this.errorResult(
						requestId,
						"TASK_ORG/FUTURE_SCHEMA/007",
						"Organization data is from a newer version.",
					)
				}

				if (revisionAtCallTime !== expectedRevision) {
					return this.errorResult(
						requestId,
						"TASK_ORG/CONFLICT/002",
						"Organization state has changed. Please retry.",
					)
				}

				// Resolve and validate the mutation against the current state.
				const next = await this.applyMutation(mutation)

				const committed = await this.save(next)

				if (this.onChange) {
					await this.onChange(committed)
				}

				return {
					requestId,
					success: true,
					committedRevision: committed.revision,
				}
			} catch (err) {
				const mapped = this.mapError(err)
				return this.errorResult(requestId, mapped.code, mapped.message)
			}
		})
	}

	/**
	 * Recompute automatic-group closures and prune stale pins/members against
	 * the supplied task history. This is intended to be called when task history
	 * changes (e.g., after a task is deleted or a new child is discovered).
	 *
	 * The reconciliation runs inside the same lock as a mutation. It does not
	 * require a base revision because it is always safe to reconcile to the
	 * latest known state.
	 */
	async reconcile(): Promise<void> {
		return this.withLock(async () => {
			if (this.state.schemaVersion !== 1) {
				return
			}
			const next = this.recomputeFromHistory(this.state)
			if (this.stateHasChanged(this.state, next)) {
				const committed = await this.save(next)
				if (this.onChange) {
					await this.onChange(committed)
				}
			}
		})
	}

	// ────────────────────────────── Private: Persistence ──────────────────────────────

	private async getTasksDir(): Promise<string> {
		const basePath = await getStorageBasePath(this.globalStoragePath)
		return path.join(basePath, "tasks")
	}

	private async getFilePath(): Promise<string> {
		const tasksDir = await this.getTasksDir()
		return path.join(tasksDir, GlobalFileNames.taskOrganization)
	}

	/**
	 * Load the aggregate from disk, normalizing and validating it.
	 */
	private async load(): Promise<void> {
		const filePath = await this.getFilePath()
		let raw: string | undefined

		try {
			raw = await fs.readFile(filePath, "utf8")
		} catch (err: unknown) {
			if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
				this.state = createEmptyTaskOrganizationState(this.now)
				return
			}
			// Transient read errors (e.g. the watcher firing while our own
			// temp+rename write replaces the file) must not wipe the in-memory
			// state: resetting to empty would make the next mutation compute
			// from an empty aggregate and fail to save.
			console.error("[TaskOrganizationStore] Failed to read organization file:", err)
			return
		}

		let parsed: unknown
		try {
			parsed = JSON.parse(raw)
		} catch (err) {
			await this.quarantine(filePath, raw)
			console.warn("[TaskOrganizationStore] Organization file was malformed and has been quarantined.")
			this.state = createEmptyTaskOrganizationState(this.now)
			return
		}

		const result = taskOrganizationStateSchema.safeParse(parsed)
		if (!result.success) {
			await this.quarantine(filePath, raw)
			console.warn("[TaskOrganizationStore] Organization file failed validation and has been quarantined.")
			this.state = createEmptyTaskOrganizationState(this.now)
			return
		}

		const data = result.data

		if (data.schemaVersion > 1) {
			console.warn("[TaskOrganizationStore] Organization file has a future schema version.")
			this.state = data as unknown as TaskOrganizationStateV1
			return
		}

		this.state = this.normalize(data)
	}

	/**
	 * Save the state to disk under a locked read-modify-write. The state is
	 * first reloaded so that concurrent mutations from another process do not
	 * overwrite the latest version.
	 */
	private async save(next: TaskOrganizationStateV1): Promise<TaskOrganizationStateV1> {
		const filePath = await this.getFilePath()
		const saved = await safeUpdateJson<TaskOrganizationStateV1>(
			filePath,
			(current) => {
				if (current && current.schemaVersion > 1) {
					throw this.createError("TASK_ORG/FUTURE_SCHEMA/007", "Organization data is from a newer version.")
				}
				if (current && current.revision >= next.revision) {
					// Another process wrote the same or a newer revision while we
					// held the lock. Same-revision writes lose: two processes that
					// both computed `next` from the same base must not both commit.
					throw this.createError("TASK_ORG/PERSISTENCE/005", "Concurrent modification detected.")
				}
				return next
			},
			{ allowCreate: true, prettyPrint: true },
		)
		this.state = this.normalize(saved)
		return this.state
	}

	private normalize(state: TaskOrganizationStateV1): TaskOrganizationStateV1 {
		const folders = state.folders.map((folder) => ({
			...folder,
			taskIds: [...new Set(folder.taskIds)],
		}))
		const pins = state.pins.filter(
			(pin, index, self) => self.findIndex((p) => this.targetsEqual(p.target, pin.target)) === index,
		)
		return { ...state, folders, pins }
	}

	private async quarantine(filePath: string, raw: string): Promise<void> {
		const quarantinePath = `${filePath}.corrupt_${this.now()}.json`
		try {
			await fs.writeFile(quarantinePath, raw, "utf8")
		} catch (err) {
			console.error("[TaskOrganizationStore] Failed to quarantine corrupted organization file:", err)
		}
	}

	// ────────────────────────────── Private: Mutation logic ──────────────────────────────

	private async applyMutation(mutation: TaskOrganizationMutationV1): Promise<TaskOrganizationStateV1> {
		const parsed = taskOrganizationMutationSchema.safeParse(mutation)
		if (!parsed.success) {
			throw this.createError("TASK_ORG/VALIDATION/001", "Invalid mutation.")
		}

		const now = this.now()
		const next = structuredClone(this.state)
		next.revision += 1
		next.updatedAt = now

		switch (parsed.data.kind) {
			case "createFolder":
				return this.createFolder(next, parsed.data, now)
			case "createFolderFromSelection":
				return this.createFolderFromSelection(next, parsed.data, now)
			case "deleteFolders":
				return this.deleteFolders(next, parsed.data)
			case "renameFolder":
				return this.renameFolder(next, parsed.data, now)
			case "deleteFolder":
				return this.deleteFolder(next, parsed.data)
			case "moveToFolder":
				return this.moveToFolder(next, parsed.data, now)
			case "removeFromFolder":
				return this.removeFromFolder(next, parsed.data, now)
			case "setPinned":
				return this.setPinned(next, parsed.data, now)
			default:
				throw this.createError("TASK_ORG/VALIDATION/001", "Unknown mutation kind.")
		}
	}

	private createFolder(
		state: TaskOrganizationStateV1,
		mutation: Extract<TaskOrganizationMutationV1, { kind: "createFolder" }>,
		now: number,
	): TaskOrganizationStateV1 {
		const name = this.normalizeFolderName(mutation.name)
		if (!name) {
			throw this.createError("TASK_ORG/VALIDATION/001", "Invalid folder name.")
		}

		const sourceUnit = this.resolveUnit(mutation.source)
		const destinationUnit = this.resolveUnit(mutation.destination)

		const folderId = mutation.folderId
		if (state.folders.some((f) => f.folderId === folderId)) {
			throw this.createError("TASK_ORG/VALIDATION/001", "Folder already exists.")
		}

		// Remove both units from any existing folders.
		state.folders = state.folders.map((folder) => ({
			...folder,
			taskIds: folder.taskIds.filter((id) => !sourceUnit.includes(id) && !destinationUnit.includes(id)),
		}))

		const folder: ManualTaskFolderV1 = {
			folderId,
			name,
			taskIds: [...new Set([...sourceUnit, ...destinationUnit])],
			createdAt: now,
			updatedAt: now,
		}
		state.folders.push(folder)
		return state
	}

	private renameFolder(
		state: TaskOrganizationStateV1,
		mutation: Extract<TaskOrganizationMutationV1, { kind: "renameFolder" }>,
		now: number,
	): TaskOrganizationStateV1 {
		const name = this.normalizeFolderName(mutation.name)
		if (!name) {
			throw this.createError("TASK_ORG/VALIDATION/001", "Invalid folder name.")
		}

		const folder = state.folders.find((f) => f.folderId === mutation.folderId)
		if (!folder) {
			throw this.createError("TASK_ORG/NOT_FOUND/004", "Folder not found.")
		}
		folder.name = name
		folder.updatedAt = now
		return state
	}

	private createFolderFromSelection(
		state: TaskOrganizationStateV1,
		mutation: Extract<TaskOrganizationMutationV1, { kind: "createFolderFromSelection" }>,
		now: number,
	): TaskOrganizationStateV1 {
		const name = this.normalizeFolderName(mutation.name)
		if (!name) {
			throw this.createError("TASK_ORG/VALIDATION/001", "Invalid folder name.")
		}

		const folderId = mutation.folderId
		if (state.folders.some((f) => f.folderId === folderId)) {
			throw this.createError("TASK_ORG/VALIDATION/001", "Folder already exists.")
		}

		// Resolve every target to its canonical task ID unit, de-duplicating
		// parent/child closures while preserving source order.
		const orderedIds: string[] = []
		const seen = new Set<string>()
		for (const target of mutation.targets) {
			const unit = this.resolveUnit(target)
			for (const id of unit) {
				if (!seen.has(id)) {
					seen.add(id)
					orderedIds.push(id)
				}
			}
		}

		if (orderedIds.length < 2) {
			throw this.createError(
				"TASK_ORG/VALIDATION/001",
				"At least two canonical units are required to create a folder from selection.",
			)
		}

		// Remove all selected units from any existing folders.
		this.removeIdsFromAllFolders(state, orderedIds)

		const folder: ManualTaskFolderV1 = {
			folderId,
			name,
			taskIds: orderedIds,
			createdAt: now,
			updatedAt: now,
		}
		state.folders.push(folder)
		return state
	}

	private deleteFolders(
		state: TaskOrganizationStateV1,
		mutation: Extract<TaskOrganizationMutationV1, { kind: "deleteFolders" }>,
	): TaskOrganizationStateV1 {
		const uniqueIds = [...new Set(mutation.folderIds)]
		const existing = new Set(state.folders.map((f) => f.folderId))
		const missing = uniqueIds.filter((id) => !existing.has(id))
		if (missing.length > 0) {
			throw this.createError("TASK_ORG/NOT_FOUND/004", "Folder not found.")
		}

		const toDelete = new Set(uniqueIds)
		state.folders = state.folders.filter((f) => !toDelete.has(f.folderId))
		state.pins = state.pins.filter((pin) => !(pin.target.kind === "folder" && toDelete.has(pin.target.folderId)))
		return state
	}

	private deleteFolder(
		state: TaskOrganizationStateV1,
		mutation: Extract<TaskOrganizationMutationV1, { kind: "deleteFolder" }>,
	): TaskOrganizationStateV1 {
		const folder = state.folders.find((f) => f.folderId === mutation.folderId)
		if (!folder) {
			throw this.createError("TASK_ORG/NOT_FOUND/004", "Folder not found.")
		}
		state.folders = state.folders.filter((f) => f.folderId !== mutation.folderId)
		state.pins = state.pins.filter((pin) => !this.targetIsFolder(pin.target, mutation.folderId))
		return state
	}

	private moveToFolder(
		state: TaskOrganizationStateV1,
		mutation: Extract<TaskOrganizationMutationV1, { kind: "moveToFolder" }>,
		now: number,
	): TaskOrganizationStateV1 {
		const folder = state.folders.find((f) => f.folderId === mutation.folderId)
		if (!folder) {
			throw this.createError("TASK_ORG/NOT_FOUND/004", "Folder not found.")
		}

		const unit = this.resolveUnit(mutation.source)
		this.removeIdsFromAllFolders(state, unit)
		folder.taskIds = [...new Set([...folder.taskIds, ...unit])]
		folder.updatedAt = now
		return state
	}

	private removeFromFolder(
		state: TaskOrganizationStateV1,
		mutation: Extract<TaskOrganizationMutationV1, { kind: "removeFromFolder" }>,
		now: number,
	): TaskOrganizationStateV1 {
		const folder = state.folders.find((f) => f.folderId === mutation.folderId)
		if (!folder) {
			throw this.createError("TASK_ORG/NOT_FOUND/004", "Folder not found.")
		}
		const unit = this.resolveUnit(mutation.source)
		folder.taskIds = folder.taskIds.filter((id) => !unit.includes(id))
		folder.updatedAt = now
		return state
	}

	private setPinned(
		state: TaskOrganizationStateV1,
		mutation: Extract<TaskOrganizationMutationV1, { kind: "setPinned" }>,
		now: number,
	): TaskOrganizationStateV1 {
		const target = this.resolveTarget(mutation.target)
		const existingIndex = state.pins.findIndex((pin) => this.targetsEqual(pin.target, target))

		if (mutation.pinned) {
			if (existingIndex !== -1) {
				// Already pinned, no-op.
				return state
			}
			if (state.pins.length >= MAX_PINNED_TARGETS) {
				throw this.createError("TASK_ORG/PIN_LIMIT/003", "Maximum three pins allowed.")
			}
			state.pins.push({ target, pinnedAt: now })
		} else {
			if (existingIndex === -1) {
				// Already unpinned, no-op.
				return state
			}
			state.pins.splice(existingIndex, 1)
		}
		return state
	}

	// ────────────────────────────── Private: Target resolution ──────────────────────────────

	private resolveTarget(target: TaskOrganizationTargetV1): TaskOrganizationTargetV1 {
		if (target.kind === "task" || target.kind === "folder") {
			return target
		}
		// autoGroup: resolve closure and return canonical root target.
		const closure = this.resolveTaskClosure(target.rootTaskId)
		return { kind: "autoGroup", rootTaskId: closure.rootId }
	}

	private resolveUnit(target: TaskOrganizationTargetV1): string[] {
		switch (target.kind) {
			case "task": {
				// Resolve any known task through its closure. This covers both
				// children and roots that have children, so dragging any group
				// member moves the whole group together.
				if (this.taskHistory?.get(target.taskId)) {
					return this.resolveTaskClosure(target.taskId).ids
				}
				return [target.taskId]
			}
			case "folder": {
				const folder = this.state.folders.find((f) => f.folderId === target.folderId)
				return folder ? [...folder.taskIds] : []
			}
			case "autoGroup":
				return this.resolveTaskClosure(target.rootTaskId).ids
			default:
				return []
		}
	}

	private resolveTaskClosure(startTaskId: string): { rootId: string; ids: string[] } {
		const history = this.taskHistory
		const parentMap = new Map<string, string | undefined>()
		const childMap = new Map<string, string[]>()
		const visibleIds = new Set<string>()

		if (history && "getAll" in history && typeof history.getAll === "function") {
			for (const item of history.getAll()) {
				visibleIds.add(item.id)
				if (item.parentTaskId) {
					parentMap.set(item.id, item.parentTaskId)
					const siblings = childMap.get(item.parentTaskId) ?? []
					siblings.push(item.id)
					childMap.set(item.parentTaskId, siblings)
				}
			}
		} else {
			visibleIds.add(startTaskId)
		}

		// Walk to the highest known root.
		let rootId = startTaskId
		while (true) {
			const parent = parentMap.get(rootId)
			if (!parent) break
			rootId = parent
		}

		// Collect all descendants.
		const ids: string[] = []
		const visited = new Set<string>()
		const stack = [rootId]
		while (stack.length > 0) {
			const id = stack.pop()!
			if (visited.has(id)) continue
			visited.add(id)
			ids.push(id)
			const children = childMap.get(id) ?? []
			for (const child of children) {
				if (!visited.has(child)) {
					stack.push(child)
				}
			}
		}

		return { rootId, ids }
	}

	private recomputeFromHistory(state: TaskOrganizationStateV1): TaskOrganizationStateV1 {
		const history = this.taskHistory
		if (!history || !("getAll" in history) || typeof history.getAll !== "function") {
			return state
		}

		const allItems = history.getAll()
		const visibleIds = new Set<string>(allItems.map((item: HistoryItem) => item.id))
		const parentMap = new Map<string, string>()
		const childMap = new Map<string, string[]>()
		for (const item of allItems) {
			if (item.parentTaskId) {
				parentMap.set(item.id, item.parentTaskId)
				const siblings = childMap.get(item.parentTaskId) ?? []
				siblings.push(item.id)
				childMap.set(item.parentTaskId, siblings)
			}
		}

		const next = structuredClone(state)
		let changed = false

		for (const folder of next.folders) {
			const kept: string[] = []
			const missing: string[] = []
			for (const id of folder.taskIds) {
				if (visibleIds.has(id)) {
					kept.push(id)
				} else {
					missing.push(id)
				}
			}
			if (missing.length > 0) {
				changed = true
				// For missing members, attempt to add any surviving descendants to the folder
				// so the folder does not silently lose a whole group when the parent is deleted.
				const surviving = missing.flatMap((id) => {
					const descendants: string[] = []
					const stack = childMap.get(id) ?? []
					while (stack.length > 0) {
						const child = stack.pop()!
						if (visibleIds.has(child)) {
							descendants.push(child)
						}
						stack.push(...(childMap.get(child) ?? []))
					}
					return descendants
				})
				folder.taskIds = [...new Set([...kept, ...surviving])]
			}
		}

		const pins = next.pins.filter((pin) => {
			if (pin.target.kind === "task") {
				return visibleIds.has(pin.target.taskId)
			}
			if (pin.target.kind === "folder") {
				const folderTarget = pin.target as { kind: "folder"; folderId: string }
				return next.folders.some((f) => f.folderId === folderTarget.folderId)
			}
			if (pin.target.kind === "autoGroup") {
				return visibleIds.has(pin.target.rootTaskId)
			}
			return true
		})
		if (pins.length !== next.pins.length) {
			changed = true
			next.pins = pins
		}

		if (changed) {
			next.revision += 1
			next.updatedAt = this.now()
		}
		return next
	}

	// ────────────────────────────── Private: Helpers ──────────────────────────────

	private normalizeFolderName(name: string): string | null {
		const normalized = name.normalize("NFC").trim()
		if (normalized.length < 1 || normalized.length > 80 || INVALID_NAME_REGEX.test(normalized)) {
			return null
		}
		return normalized
	}

	private removeIdsFromAllFolders(state: TaskOrganizationStateV1, ids: string[]): void {
		const set = new Set(ids)
		for (const folder of state.folders) {
			folder.taskIds = folder.taskIds.filter((id) => !set.has(id))
		}
	}

	private targetsEqual(a: TaskOrganizationTargetV1, b: TaskOrganizationTargetV1): boolean {
		if (a.kind !== b.kind) return false
		switch (a.kind) {
			case "task":
				return a.taskId === (b as { taskId: string }).taskId
			case "autoGroup":
				return a.rootTaskId === (b as { rootTaskId: string }).rootTaskId
			case "folder":
				return a.folderId === (b as { folderId: string }).folderId
			default:
				return false
		}
	}

	private targetIsFolder(target: TaskOrganizationTargetV1, folderId: string): boolean {
		return target.kind === "folder" && target.folderId === folderId
	}

	private stateHasChanged(a: TaskOrganizationStateV1, b: TaskOrganizationStateV1): boolean {
		return (
			a.revision !== b.revision ||
			a.updatedAt !== b.updatedAt ||
			JSON.stringify(a.folders) !== JSON.stringify(b.folders) ||
			JSON.stringify(a.pins) !== JSON.stringify(b.pins)
		)
	}

	// ────────────────────────────── Private: Error handling ──────────────────────────────

	private createError(code: TaskOrganizationErrorCode, message: string): TaskOrganizationError {
		return { code, message }
	}

	private mapError(err: unknown): TaskOrganizationError {
		if (this.isTaskOrganizationError(err)) {
			return err
		}
		if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
			return { code: "TASK_ORG/PERSISTENCE/005", message: "Organization data could not be read." }
		}
		return { code: "TASK_ORG/PERSISTENCE/005", message: "Organization data could not be saved." }
	}

	private isTaskOrganizationError(err: unknown): err is TaskOrganizationError {
		return (
			typeof err === "object" &&
			err !== null &&
			"code" in err &&
			"message" in err &&
			typeof (err as Record<string, unknown>).code === "string" &&
			typeof (err as Record<string, unknown>).message === "string"
		)
	}

	private errorResult(
		requestId: string,
		code: TaskOrganizationErrorCode,
		message: string,
	): TaskOrganizationMutationResultV1 {
		return {
			requestId,
			success: false,
			committedRevision: this.state.revision,
			error: { code, message },
		}
	}

	// ────────────────────────────── Private: Write lock ──────────────────────────────

	private withLock<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.writeLock.then(fn, fn)
		this.writeLock = result.then(
			() => {},
			() => {},
		)
		return result
	}

	// ────────────────────────────── Private: fs.watch ──────────────────────────────

	private startWatcher(): void {
		if (this.disposed) {
			return
		}

		this.getTasksDir()
			.then((tasksDir) => {
				if (this.disposed) {
					return
				}

				try {
					this.fsWatcher = fsSync.watch(tasksDir, { recursive: false }, (_eventType, filename) => {
						if (this.disposed) {
							return
						}
						if (filename !== GlobalFileNames.taskOrganization) {
							return
						}
						if (this.watcherDebounce) {
							clearTimeout(this.watcherDebounce)
						}
						this.watcherDebounce = setTimeout(() => {
							this.reloadFromWatcher().catch((err) => {
								console.error("[TaskOrganizationStore] Watcher reload failed:", err)
							})
						}, 500)
					})

					this.fsWatcher.on("error", (err) => {
						console.error("[TaskOrganizationStore] fs.watch error:", err)
					})
				} catch (err) {
					console.error("[TaskOrganizationStore] Failed to start fs.watch:", err)
				}
			})
			.catch((err) => {
				console.error("[TaskOrganizationStore] Failed to get tasks dir for watcher:", err)
			})
	}

	private async reloadFromWatcher(): Promise<void> {
		const previous = this.state
		await this.load()
		// Notify on any actual content change, not just a revision increase:
		// a same-revision overwrite (lost update from another process)
		// changes the aggregate without bumping its revision.
		if (this.stateHasChanged(previous, this.state) && this.onChange) {
			await this.onChange(this.getState())
		}
	}
}
