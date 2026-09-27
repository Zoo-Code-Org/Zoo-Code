import { TaskRegistry } from "../TaskRegistry"
import { type Task } from "../Task"

function makeTask(taskId: string, opts: { abort?: boolean; abandoned?: boolean } = {}): Task {
	return { taskId, abort: opts.abort ?? false, abandoned: opts.abandoned ?? false } as unknown as Task
}

function assertInvariant(registry: TaskRegistry) {
	const ids = registry.taskIds
	expect(ids.length).toBe(registry.length)
	for (const id of ids) {
		expect(registry.getById(id)).toBeDefined()
	}
	if (registry.current !== undefined) {
		expect(registry.getById(registry.current.taskId)).toBe(registry.current)
	}
}

describe("TaskRegistry", () => {
	describe("push / pop", () => {
		it("push adds to registry and makes task current", () => {
			const r = new TaskRegistry()
			const t = makeTask("a")
			r.push(t)
			expect(r.length).toBe(1)
			expect(r.current).toBe(t)
			expect(r.getById("a")).toBe(t)
			assertInvariant(r)
		})

		it("push of second task makes it current", () => {
			const r = new TaskRegistry()
			const t1 = makeTask("a")
			const t2 = makeTask("b")
			r.push(t1)
			r.push(t2)
			expect(r.current).toBe(t2)
			expect(r.length).toBe(2)
			assertInvariant(r)
		})

		it("push replaces duplicate task ids", () => {
			const r = new TaskRegistry()
			const first = makeTask("a")
			const second = makeTask("a")
			r.push(first)
			r.push(second)
			expect(r.taskIds).toEqual(["a"])
			expect(r.length).toBe(1)
			expect(r.current).toBe(second)
			expect(r.getById("a")).toBe(second)
			assertInvariant(r)
		})

		it("pop removes top task and restores previous current", () => {
			const r = new TaskRegistry()
			const t1 = makeTask("a")
			const t2 = makeTask("b")
			r.push(t1)
			r.push(t2)
			const popped = r.pop()
			expect(popped).toBe(t2)
			expect(r.length).toBe(1)
			expect(r.current).toBe(t1)
			expect(r.getById("b")).toBeUndefined()
			assertInvariant(r)
		})

		it("pop on empty registry returns undefined", () => {
			const r = new TaskRegistry()
			expect(r.pop()).toBeUndefined()
			expect(r.length).toBe(0)
			expect(r.current).toBeUndefined()
		})

		it("pop of last task leaves current undefined", () => {
			const r = new TaskRegistry()
			r.push(makeTask("a"))
			r.pop()
			expect(r.current).toBeUndefined()
			expect(r.length).toBe(0)
			assertInvariant(r)
		})

		it("pop of non-current top does not change focus", () => {
			const r = new TaskRegistry()
			const t1 = makeTask("a")
			const t2 = makeTask("b")
			const t3 = makeTask("c")
			r.push(t1)
			r.push(t2)
			r.push(t3)
			r.setCurrent("a")
			const popped = r.pop()
			expect(popped).toBe(t3)
			expect(r.current).toBe(t1)
			expect(r.taskIds).toEqual(["a", "b"])
			assertInvariant(r)
		})
	})

	describe("getById", () => {
		it("returns correct task by id", () => {
			const r = new TaskRegistry()
			const t = makeTask("x")
			r.push(t)
			expect(r.getById("x")).toBe(t)
		})

		it("returns undefined for unknown id", () => {
			const r = new TaskRegistry()
			expect(r.getById("nope")).toBeUndefined()
		})
	})

	describe("remove", () => {
		it("removes task by id regardless of position", () => {
			const r = new TaskRegistry()
			const t1 = makeTask("a")
			const t2 = makeTask("b")
			const t3 = makeTask("c")
			r.push(t1)
			r.push(t2)
			r.push(t3)
			const removed = r.remove("b")
			expect(removed).toBe(t2)
			expect(r.length).toBe(2)
			expect(r.getById("b")).toBeUndefined()
			expect(r.taskIds).toEqual(["a", "c"])
			assertInvariant(r)
		})

		it("remove of current task updates current to new top", () => {
			const r = new TaskRegistry()
			const t1 = makeTask("a")
			const t2 = makeTask("b")
			r.push(t1)
			r.push(t2)
			r.remove("b")
			expect(r.current).toBe(t1)
			assertInvariant(r)
		})

		it("returns undefined for unknown id", () => {
			const r = new TaskRegistry()
			expect(r.remove("nope")).toBeUndefined()
		})
	})

	describe("replace", () => {
		it("preserves stack index when replacing the current task", () => {
			const r = new TaskRegistry()
			const t1 = makeTask("a")
			const t2 = makeTask("b")
			const t3 = makeTask("c")
			const t2v2 = makeTask("b-v2")
			r.push(t1)
			r.push(t2)
			r.push(t3)
			r.setCurrent("b")
			r.replace("b", t2v2)
			expect(r.taskIds).toEqual(["a", "b-v2", "c"])
			expect(r.current).toBe(t2v2)
			expect(r.getById("b")).toBeUndefined()
			expect(r.getById("b-v2")).toBe(t2v2)
			assertInvariant(r)
		})

		it("preserves stack index when replacing a non-current task", () => {
			const r = new TaskRegistry()
			const t1 = makeTask("a")
			const t2 = makeTask("b")
			const t1v2 = makeTask("a-v2")
			r.push(t1)
			r.push(t2)
			r.replace("a", t1v2)
			expect(r.taskIds).toEqual(["a-v2", "b"])
			expect(r.current).toBe(t2)
			assertInvariant(r)
		})

		it("returns the old task", () => {
			const r = new TaskRegistry()
			const t = makeTask("a")
			const t2 = makeTask("a-v2")
			r.push(t)
			expect(r.replace("a", t2)).toBe(t)
		})

		it("throws for unknown taskId", () => {
			const r = new TaskRegistry()
			expect(() => r.replace("nope", makeTask("x"))).toThrow(/unknown taskId/)
		})

		it("throws when replacement task id already exists elsewhere", () => {
			const r = new TaskRegistry()
			const t1 = makeTask("a")
			const t2 = makeTask("b")
			r.push(t1)
			r.push(t2)
			expect(() => r.replace("a", makeTask("b"))).toThrow(/duplicate taskId/)
			expect(r.taskIds).toEqual(["a", "b"])
			expect(r.getById("a")).toBe(t1)
			expect(r.getById("b")).toBe(t2)
			assertInvariant(r)
		})
	})

	describe("setCurrent", () => {
		it("changes current without mutating stack order", () => {
			const r = new TaskRegistry()
			const t1 = makeTask("a")
			const t2 = makeTask("b")
			r.push(t1)
			r.push(t2)
			r.setCurrent("a")
			expect(r.current).toBe(t1)
			expect(r.taskIds).toEqual(["a", "b"])
			assertInvariant(r)
		})

		it("throws for unknown taskId", () => {
			const r = new TaskRegistry()
			expect(() => r.setCurrent("nope")).toThrow(/unknown taskId/)
		})
	})

	describe("getAll", () => {
		it("returns tasks in stack order", () => {
			const r = new TaskRegistry()
			const t1 = makeTask("a")
			const t2 = makeTask("b")
			r.push(t1)
			r.push(t2)
			expect(r.getAll()).toEqual([t1, t2])
		})
	})

	describe("getRunning / hasRunning", () => {
		it("getRunning excludes aborted tasks", () => {
			const r = new TaskRegistry()
			r.push(makeTask("a"))
			r.push(makeTask("b", { abort: true }))
			r.push(makeTask("c"))
			const running = r.getRunning()
			expect(running.map((t) => t.taskId)).toEqual(["a", "c"])
		})

		it("getRunning excludes abandoned tasks", () => {
			const r = new TaskRegistry()
			r.push(makeTask("a"))
			r.push(makeTask("b", { abandoned: true }))
			const running = r.getRunning()
			expect(running.map((t) => t.taskId)).toEqual(["a"])
		})

		it("hasRunning returns true for a live task", () => {
			const r = new TaskRegistry()
			r.push(makeTask("a"))
			expect(r.hasRunning("a")).toBe(true)
		})

		it("hasRunning returns false for an aborted task", () => {
			const r = new TaskRegistry()
			r.push(makeTask("a", { abort: true }))
			expect(r.hasRunning("a")).toBe(false)
		})

		it("hasRunning returns false for an unknown task", () => {
			const r = new TaskRegistry()
			expect(r.hasRunning("nope")).toBe(false)
		})
	})

	describe("taskIds / length", () => {
		it("taskIds is a snapshot (not a live reference)", () => {
			const r = new TaskRegistry()
			r.push(makeTask("a"))
			const ids = r.taskIds
			r.push(makeTask("b"))
			expect(ids).toEqual(["a"])
		})
	})

	describe("dual-write invariant", () => {
		it("holds after a sequence of mixed operations", () => {
			const r = new TaskRegistry()
			const tasks = (["a", "b", "c", "d"] as const).map((id) => makeTask(id))
			for (const t of tasks) {
				r.push(t)
				assertInvariant(r)
			}
			r.remove("b")
			assertInvariant(r)
			r.pop()
			assertInvariant(r)
			r.setCurrent("a")
			assertInvariant(r)
		})
	})
})
