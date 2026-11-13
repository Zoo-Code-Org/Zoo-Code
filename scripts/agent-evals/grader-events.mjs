// Structured runner events are the only source of verdict counts.
export async function summarizeTestEvents(events, expected, file, trusted) {
	const observed = []
	let passed = 0
	let failed = 0
	let cancelled = 0
	let fileFailed = false
	let runnerFailed = false
	let importFailed = false
	const failures = []
	for await (const event of events) {
		if (event.type !== "test:pass" && event.type !== "test:fail") continue
		const data = event.data
		if (data.name === file) {
			if (event.type === "test:fail") {
				fileFailed = true
				runnerFailed = data.details?.error?.failureType !== "subtestsFailed"
				// An untrusted visible file can fail before registering tests when
				// the solution it imports throws. Hidden tests still run independently.
				importFailed =
					!trusted &&
					observed.length === 0 &&
					data.details?.error?.failureType === "testCodeFailure" &&
					data.details?.error?.exitCode === 1 &&
					!data.details?.error?.signal
			}
			continue
		}
		if (data.details?.type !== "test") continue
		observed.push(data.name)
		if (event.type === "test:pass" && !data.skip && !data.todo) passed++
		else if (
			["cancelledByParent", "testTimeoutFailure"].includes(data.details?.error?.failureType) ||
			data.skip ||
			data.todo
		)
			cancelled++
		else {
			failed++
			failures.push({ name: data.name, file })
		}
	}
	if (fileFailed && failed === 0 && cancelled === 0) {
		failed++
		failures.push({ name: "test process failed", file })
	}
	const complete =
		importFailed || (!runnerFailed && observed.length > 0 && expected.every((name) => observed.includes(name)))
	return { passed, failed, cancelled, failures, complete }
}
