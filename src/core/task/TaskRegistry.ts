import { type Task } from "./Task"

/**
 * Expand-Contract adapter replacing `clineStack: Task[]` in ClineProvider.
 *
 * Phase A+B: adapter is live, all 23 call sites migrated, concurrent access
 * methods available. Maintains a LIFO stack of task IDs alongside a Map for
 * O(1) lookup. Invariant: tasks.size === stack.length at all times.
 *
 * Phase C (future): remove internal stack once all callers use map-based access.
 */
export class TaskRegistry {
	private tasks = new Map<string, Task>()
	private stack: string[] = []
	private _currentTaskId: string | undefined

	/**
	 * Add a task and focus it. If the task ID already exists, remove the
	 * existing entry first so this behaves as "move to top" instead of creating
	 * duplicate stack entries.
	 */
	push(task: Task): void {
		if (this.tasks.has(task.taskId)) {
			this.remove(task.taskId)
		}
		this.tasks.set(task.taskId, task)
		this.stack.push(task.taskId)
		this._currentTaskId = task.taskId
	}

	pop(): Task | undefined {
		const id = this.stack.pop()
		if (id === undefined) return undefined
		const task = this.tasks.get(id)
		this.tasks.delete(id)
		if (this._currentTaskId === id) {
			this._currentTaskId = this.stack[this.stack.length - 1]
		}
		return task
	}

	get current(): Task | undefined {
		return this._currentTaskId !== undefined ? this.tasks.get(this._currentTaskId) : undefined
	}

	/**
	 * Switch UI focus to a different task without mutating the stack order.
	 * Throws if the taskId is not in the registry.
	 */
	setCurrent(taskId: string): void {
		if (!this.tasks.has(taskId)) {
			throw new Error(`[TaskRegistry] setCurrent: unknown taskId ${taskId}`)
		}
		this._currentTaskId = taskId
	}

	getById(id: string): Task | undefined {
		return this.tasks.get(id)
	}

	getAll(): Task[] {
		return this.stack.map((id) => this.tasks.get(id)!)
	}

	/** All tasks that are not aborted or abandoned. */
	getRunning(): Task[] {
		return this.getAll().filter((t) => !t.abort && !t.abandoned)
	}

	/** True only if the task is in the registry and is not aborted or abandoned. */
	hasRunning(taskId: string): boolean {
		const t = this.tasks.get(taskId)
		return t !== undefined && !t.abort && !t.abandoned
	}

	/** Remove a task by ID regardless of its stack position. */
	remove(taskId: string): Task | undefined {
		const task = this.tasks.get(taskId)
		if (task === undefined) return undefined
		this.tasks.delete(taskId)
		const idx = this.stack.indexOf(taskId)
		if (idx !== -1) this.stack.splice(idx, 1)
		if (this._currentTaskId === taskId) {
			this._currentTaskId = this.stack[this.stack.length - 1]
		}
		return task
	}

	/**
	 * Replace a task in-place: same stack index, same current pointer.
	 * Used by rehydration so focus and stack order are both preserved.
	 * Throws if taskId is not in the registry.
	 */
	replace(taskId: string, replacement: Task): Task {
		const idx = this.stack.indexOf(taskId)
		if (idx === -1) {
			throw new Error(`[TaskRegistry] replace: unknown taskId ${taskId}`)
		}
		if (replacement.taskId !== taskId && this.tasks.has(replacement.taskId)) {
			throw new Error(`[TaskRegistry] replace: duplicate taskId ${replacement.taskId}`)
		}
		const old = this.tasks.get(taskId)!
		this.tasks.delete(taskId)
		this.tasks.set(replacement.taskId, replacement)
		this.stack[idx] = replacement.taskId
		if (this._currentTaskId === taskId) {
			this._currentTaskId = replacement.taskId
		}
		return old
	}

	get length(): number {
		return this.stack.length
	}

	get taskIds(): string[] {
		return [...this.stack]
	}
}
