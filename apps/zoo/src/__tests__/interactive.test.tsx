import { render } from "ink-testing-library"
import { describe, expect, it, vi } from "vitest"

import { initialProjection } from "../projection.js"
import { InteractiveSession } from "../interactive.js"

describe("InteractiveSession", () => {
	it("submits input and renders approval controls", () => {
		const submit = vi.fn()
		const projection = {
			...initialProjection(),
			pendingAsks: new Map([["ask-1", { taskId: "root", category: "tool", subject: "Write file?" }]]),
		}
		const view = render(
			<InteractiveSession
				projection={projection}
				actions={{ submit, approve: vi.fn(), cancel: vi.fn(), exit: vi.fn() }}
			/>,
		)

		expect(view.lastFrame()).toContain("Approval required")
		expect(view.lastFrame()).toContain("Write file?")
	})
})
