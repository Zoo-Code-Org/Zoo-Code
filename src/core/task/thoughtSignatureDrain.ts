import { createTimeoutError, detachOnAbort } from "../../api/providers/utils/abort-signal"

/** A signature drain must complete or fail before the turn can enter history. */
export async function waitForThoughtSignatureDrain(
	drain: Promise<void>,
	{ timeoutMs, signal, onTimeout }: { timeoutMs: number; signal?: AbortSignal; onTimeout: (error: Error) => void },
): Promise<void> {
	const deadline = new AbortController()
	const timer = setTimeout(() => {
		const error = createTimeoutError("Thought signature drain")
		deadline.abort(error)
		onTimeout(error)
	}, timeoutMs)
	try {
		await detachOnAbort(drain, signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal)
	} finally {
		clearTimeout(timer)
	}
}
