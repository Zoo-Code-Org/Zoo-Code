/**
 * Captures the rejection of an operation as an `Error`.
 *
 * Provider abort normalization always throws an `Error`, but an awaited
 * operation is typed `unknown`, so the guard keeps strict typing without
 * casts. A non-Error rejection is re-wrapped so the original failure message
 * stays visible, and a resolving operation — the contract violation the
 * surrounding test exists to catch — becomes a failing assertion.
 */
export async function captureError(operation: Promise<unknown>): Promise<Error> {
	try {
		await operation
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error))
	}
	throw new Error("Expected the operation to reject")
}
