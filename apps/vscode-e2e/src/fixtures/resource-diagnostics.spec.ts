import type { RooCodeResourceDiagnosticEventName, RooCodeResourceDiagnostics } from "@roo-code/types"
import { describe, expect, it } from "vitest"

import { assertResourceDiagnosticsConverged } from "./resource-diagnostics"
type DiagnosticsOverrides = Omit<Partial<RooCodeResourceDiagnostics>, "listenerCounts"> & {
	listenerCounts?: Partial<Record<RooCodeResourceDiagnosticEventName, number>>
}

const diagnostics = (overrides: DiagnosticsOverrides = {}): RooCodeResourceDiagnostics => ({
	registeredTaskCount: overrides.registeredTaskCount ?? 0,
	currentTaskStackLength: overrides.currentTaskStackLength ?? 0,
	listenerCounts: {
		message: 0,
		taskCreated: 0,
		taskStarted: 0,
		taskCompleted: 0,
		taskAborted: 0,
		taskDelegationCompleted: 0,
		taskDelegationResumed: 0,
		taskModeSwitched: 0,
		...overrides.listenerCounts,
	},
})

describe("resource diagnostics convergence helper", () => {
	it("passes when final diagnostics match the baseline after cleanup", () => {
		const baseline = diagnostics()
		const final = diagnostics()

		expect(() => assertResourceDiagnosticsConverged({ baseline, final })).not.toThrow()
	})

	it("fails when registered task count increases", () => {
		const baseline = diagnostics({ registeredTaskCount: 0 })
		const final = diagnostics({ registeredTaskCount: 1 })

		expect(() =>
			assertResourceDiagnosticsConverged({
				baseline,
				final,
				observedChildTaskIds: ["child-1"],
			}),
		).toThrow(/registeredTaskCount.*child-1/)
	})

	it("fails when listener counts increase", () => {
		const baseline = diagnostics({ listenerCounts: { taskDelegationCompleted: 1 } })
		const final = diagnostics({ listenerCounts: { taskDelegationCompleted: 2 } })

		expect(() => assertResourceDiagnosticsConverged({ baseline, final })).toThrow(
			/listenerCounts\.taskDelegationCompleted/,
		)
	})

	it("fails when current task stack length has not converged", () => {
		const baseline = diagnostics({ currentTaskStackLength: 0 })
		const final = diagnostics({ currentTaskStackLength: 1 })

		expect(() => assertResourceDiagnosticsConverged({ baseline, final })).toThrow(/currentTaskStackLength/)
	})

	it("includes every leaking counter name in the error message", () => {
		const baseline = diagnostics()
		const final = diagnostics({
			registeredTaskCount: 2,
			currentTaskStackLength: 1,
			listenerCounts: { taskCompleted: 1, taskDelegationCompleted: 1 },
		})

		expect(() => assertResourceDiagnosticsConverged({ baseline, final })).toThrow(
			/registeredTaskCount[\s\S]*currentTaskStackLength[\s\S]*listenerCounts\.taskCompleted[\s\S]*listenerCounts\.taskDelegationCompleted/,
		)
	})
})
