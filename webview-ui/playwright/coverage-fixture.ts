import { test as base, expect } from "@playwright/test"
import { addCoverageReport } from "monocart-reporter"

// Auto-fixture that collects V8 JS + CSS coverage per test and hands it to the
// monocart-reporter attached in `playwright-ct.config.ts`, which writes the
// LCOV consumed by Codecov. Every `.visual.tsx` file imports `test`/`expect`
// from here so coverage is collected without per-test boilerplate.
export const test = base.extend<{ collectCoverage: void }>({
	collectCoverage: [
		async ({ page }, use, testInfo) => {
			await Promise.all([
				page.coverage.startJSCoverage({ resetOnNavigation: false }),
				page.coverage.startCSSCoverage({ resetOnNavigation: false }),
			])
			await use()
			const [js, css] = await Promise.all([page.coverage.stopJSCoverage(), page.coverage.stopCSSCoverage()])
			await addCoverageReport([...js, ...css], testInfo)
		},
		{ auto: true },
	],
})

export { expect }
