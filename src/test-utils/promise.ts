/**
 * Fail fast when a promise never settles. Mutations that break settle or
 * reject wiring would otherwise hang the test until Stryker's per-mutant
 * timeout, marking the mutant "Timeout" instead of "Killed".
 */
export function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`operation did not settle within ${ms}ms`)), ms)
		void promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}
