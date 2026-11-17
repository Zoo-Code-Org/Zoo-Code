/**
 * Let every pending microtask and I/O callback run before the test continues.
 *
 * Use this to reach a state that has no observable signal to poll. When the state can be
 * observed (a mock was called, a flag was set), poll it with `vi.waitFor` instead.
 */
export function flushMacrotasks(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve))
}
