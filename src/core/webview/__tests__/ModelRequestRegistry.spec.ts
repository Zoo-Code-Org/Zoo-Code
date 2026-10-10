import { ModelRequestRegistry } from "../ModelRequestRegistry"

it("aborts all pending requests on disposal and does not start new work", async () => {
	const registry = new ModelRequestRegistry()
	const signals: AbortSignal[] = []
	const fetch = vi.fn(
		(signal: AbortSignal) =>
			new Promise<void>((resolve) => {
				signals.push(signal)
				signal.addEventListener("abort", () => resolve(), { once: true })
			}),
	)
	const first = registry.run("first", fetch)
	const second = registry.run("second", fetch)
	registry.dispose()
	await Promise.all([first, second, registry.run("third", fetch)])
	expect(signals.every((signal) => signal.aborted)).toBe(true)
	expect(fetch).toHaveBeenCalledTimes(2)
})

it("aborts a replaced request and keeps its replacement registered after late completion", async () => {
	const registry = new ModelRequestRegistry()
	let finishFirst!: () => void
	let firstSignal!: AbortSignal
	let secondSignal!: AbortSignal
	const first = registry.run("same-id", (signal) => {
		firstSignal = signal
		return new Promise<void>((resolve) => {
			finishFirst = resolve
		})
	})
	const second = registry.run("same-id", (signal) => {
		expect(firstSignal.aborted).toBe(true)
		secondSignal = signal
		return new Promise<void>((resolve) => {
			signal.addEventListener("abort", () => resolve(), { once: true })
		})
	})
	finishFirst()
	await first
	expect(secondSignal.aborted).toBe(false)
	registry.cancel("same-id")
	expect(secondSignal.aborted).toBe(true)
	await second
})

it("propagates errors from requests that were not aborted", async () => {
	const registry = new ModelRequestRegistry()
	const failure = new Error("model discovery failed")
	await expect(
		registry.run("failed", async () => {
			throw failure
		}),
	).rejects.toBe(failure)
})
