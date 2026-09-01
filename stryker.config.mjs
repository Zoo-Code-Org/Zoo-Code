const vitestConfig = process.env.STRYKER_VITEST_CONFIG
const reportDirectory = process.env.STRYKER_REPORT_DIR

if (!vitestConfig || !reportDirectory) {
	throw new Error("STRYKER_VITEST_CONFIG and STRYKER_REPORT_DIR are required")
}

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
	plugins: ["@stryker-mutator/vitest-runner"],
	testRunner: "vitest",
	vitest: {
		configFile: vitestConfig,
		related: true,
	},
	incremental: false,
	concurrency: 2,
	timeoutMS: 5_000,
	timeoutFactor: 1.5,
	cleanTempDir: "always",
	logLevel: "warn",
	reporters: ["json", "html"],
	jsonReporter: {
		fileName: `${reportDirectory}/mutation.json`,
	},
	htmlReporter: {
		fileName: `${reportDirectory}/mutation.html`,
	},
	thresholds: {
		high: 100,
		low: 100,
		break: null,
	},
}
