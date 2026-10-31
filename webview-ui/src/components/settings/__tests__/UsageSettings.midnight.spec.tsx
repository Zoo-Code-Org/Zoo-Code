import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { providerIdentifiers, type HistoryItem } from "@roo-code/types"

import { UsageSettings } from "../UsageSettings"

const post = vi.hoisted(() => vi.fn())
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: post } }))

const state = vi.hoisted(() => ({ taskHistory: [] as HistoryItem[], cwd: "/ws/a" }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))

vi.mock("../ProviderLimits", () => ({ ProviderLimits: () => <div data-testid="provider-limits-stub" /> }))

// Spy on the real export so the test can see which "now" it was given.
const csvSpy = vi.hoisted(() => vi.fn())
vi.mock("@src/utils/usage", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@src/utils/usage")>()
	return {
		...actual,
		usageToCsv: (...args: Parameters<typeof actual.usageToCsv>) => {
			csvSpy(...args)
			return actual.usageToCsv(...args)
		},
	}
})

const MINUTE = 60_000
// 23:50 local on 2026-10-27: ten minutes before midnight.
const BEFORE_MIDNIGHT = new Date(2026, 9, 27, 23, 50).getTime()

const todaysTask: HistoryItem = {
	id: "late",
	number: 1,
	ts: new Date(2026, 9, 27, 23, 0).getTime(),
	task: "Late task",
	tokensIn: 1000,
	tokensOut: 100,
	totalCost: 4,
	workspace: "/ws/a",
	usageByModel: [
		{
			apiProvider: providerIdentifiers.anthropic,
			modelId: "claude-sonnet-5",
			requests: 1,
			tokensIn: 1000,
			tokensOut: 100,
			cost: 4,
		},
	],
}

describe("UsageSettings – across local midnight", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		vi.setSystemTime(BEFORE_MIDNIGHT)
		post.mockClear()
		csvSpy.mockClear()
		state.taskHistory = [todaysTask]
		state.cwd = "/ws/a"
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("rolls the Today view over at midnight instead of keeping yesterday's tasks", () => {
		render(<UsageSettings />)
		fireEvent.click(screen.getByTestId("usage-range-today"))
		expect(screen.getByTestId("usage-stats").textContent).toContain("$4.00")

		// Midnight plus the one-second margin: the view must re-evaluate "today" on its own.
		act(() => {
			vi.advanceTimersByTime(10 * MINUTE + 5_000)
		})

		expect(screen.queryByTestId("usage-stats")).toBeNull()
		expect(screen.getByTestId("usage-empty")).toBeTruthy()
	})

	it("keeps the view and the export on the same day, even if the clock moves past midnight first", () => {
		render(<UsageSettings />)
		fireEvent.click(screen.getByTestId("usage-range-today"))
		Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() })
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

		// The wall clock passes midnight but the roll-over timer has not fired yet: the view still shows the
		// old day, so Export must use that same day rather than a fresh Date.now().
		vi.setSystemTime(BEFORE_MIDNIGHT + 20 * MINUTE)
		fireEvent.click(screen.getByTestId("usage-export-csv"))

		expect(csvSpy).toHaveBeenCalledTimes(1)
		expect(csvSpy.mock.calls[0][1]).toMatchObject({ range: "today", now: BEFORE_MIDNIGHT })
		click.mockRestore()
	})

	it("does not leave a timer running after unmount", () => {
		const { unmount } = render(<UsageSettings />)
		unmount()
		expect(vi.getTimerCount()).toBe(0)
	})
})
