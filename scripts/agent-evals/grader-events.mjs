// Structured runner events are the only source of verdict counts.
export async function summarizeTestEvents(events, expected, file, trusted) {
	const observed = []
	let completedNaturally = false
	let passed = 0
	let failed = 0
	let cancelled = 0
	let fileFailed = false
	let runnerFailed = false
	let importFailed = false
	const failures = []
	for await (const event of events) {
		const data = event.data
		if (event.type === "test:summary" && data.file === file) completedNaturally = true
		if (event.type !== "test:pass" && event.type !== "test:fail") continue
		if (data.name === file) {
			if (event.type === "test:fail") {
				fileFailed = true
				runnerFailed = data.details?.error?.failureType !== "subtestsFailed"
				// An untrusted visible file can fail before registering tests when
				// the solution it imports throws. The initialized harness rethrows
				// uncaught import errors with exit 7; without it Node uses exit 1.
				// Hidden tests still run independently.
				importFailed =
					!trusted &&
					observed.length === 0 &&
					data.details?.error?.failureType === "testCodeFailure" &&
					[1, 7].includes(data.details?.error?.exitCode) &&
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
		importFailed ||
		(!runnerFailed &&
			(trusted ? observed.length > 0 : completedNaturally) &&
			expected.every((name) => observed.includes(name)))
	return { passed, failed, cancelled, failures, complete }
}
