/**
 * Stryker guard: fails fast if `promise` does not settle within `ms`.
 *
 * Stryker's per-mutant cutoff (timeoutMS 5s x timeoutFactor 1.5 ~= 7.5s) is shorter
 * than vitest's testTimeout (20s). A mutant that removes a settle call (or an abort
 * listener) leaves an awaited promise pending forever; without this guard the test
 * would outlive the cutoff and the mutant would be reported as Timeout (inconclusive).
 * Settling the guard at 500ms turns those mutants into fast failures (KILLED).
 */
export function withSettleGuard<T>(promise: Promise<T>, ms = 500): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`settle guard timed out after ${ms}ms`))
		}, ms)
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
