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
