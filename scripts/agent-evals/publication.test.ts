import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { publishGeneration } from "./publication.ts"

// SafeReturn: failed or interrupted calls leave no marker when cleanup works.
// MarkerLast: a marker exists only after all data steps finish.
describe("generation publication properties", () => {
	it("checks every interruption and write-failure boundary for bounded generations", async () => {
		for (const length of [1, 2, 3, 4]) {
			for (let interruptAt = -1; interruptAt <= length; interruptAt++) {
				for (let failAt = -1; failAt < length; failAt++) {
					const label = JSON.stringify({ length, interruptAt, failAt })
					let written = 0
					let marker = false
					let rolledBack = false
					const writeError = new Error("write failed")
					const execution = publishGeneration({
						steps: Array.from({ length: length - 1 }, (_, index) => async () => {
							assert.equal(rolledBack, false, label)
							assert.equal(written, index, label)
							// A write can take effect and then reject.
							written++
							assert.equal(marker, false, label)
							if (index === failAt) throw writeError
						}),
						commit: async () => {
							assert.equal(written, length - 1, label)
							written++
							marker = true
							if (failAt === length - 1) throw writeError
						},
						isInterrupted: () => written === interruptAt,
						rollback: async () => {
							marker = false
							rolledBack = true
						},
					})
					const failureReached = failAt >= 0 && (interruptAt < 0 || failAt < interruptAt)
					if (failureReached) {
						await assert.rejects(execution, (error: unknown) => error === writeError, label)
					} else {
						assert.equal(await execution, interruptAt < 0, label)
					}
					assert.equal(marker, interruptAt < 0 && failAt < 0, label)
					assert.equal(rolledBack, interruptAt >= 0 || failAt >= 0, label)
				}
			}
		}
	})

	it("throws both errors when rollback fails", async () => {
		for (const interrupted of [false, true]) {
			const writeError = new Error("write failed")
			const cleanupError = new Error("cleanup failed")
			await assert.rejects(
				publishGeneration({
					commit: async () => {},
					steps: [
						async () => {
							throw writeError
						},
					],
					isInterrupted: () => interrupted,
					rollback: async () => {
						throw cleanupError
					},
				}),
				(error: unknown) => {
					assert.ok(error instanceof AggregateError)
					assert.equal(error.errors[1], cleanupError)
					if (!interrupted) assert.equal(error.errors[0], writeError)
					return true
				},
			)
		}
	})
})

// An iterator can interrupt after the last yielded write.
it("refuses commit when the iterator ends with an interrupt", async () => {
	for (const count of [0, 1, 2]) {
		let interrupted = false
		let committed = false
		let rolledBack = false
		function* steps() {
			for (let i = 0; i < count; i++) yield async () => {}
			interrupted = true
		}
		assert.equal(
			await publishGeneration({
				steps: steps(),
				commit: async () => {
					committed = true
				},
				isInterrupted: () => interrupted,
				rollback: async () => {
					rolledBack = true
				},
			}),
			false,
		)
		assert.equal(committed, false)
		assert.equal(rolledBack, true)
	}
})
