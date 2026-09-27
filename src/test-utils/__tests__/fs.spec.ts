import { describe, expect, it, vi } from "vitest"

import { mockFsPromises, resetFsPromises } from "../fs"

describe("filesystem test utilities", () => {
	it("provides defaults and restores them after a test-specific override", async () => {
		const mock = mockFsPromises({ readFile: vi.fn().mockResolvedValue("custom content") })

		expect(await mock.readFile()).toBe("custom content")

		resetFsPromises(mock)

		expect(await mock.readFile()).toBe("")
		expect(await mock.writeFile()).toBeUndefined()
		expect(await mock.access()).toBeUndefined()
	})
})
