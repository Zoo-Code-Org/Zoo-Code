const vitestConfig = process.env.STRYKER_VITEST_CONFIG ?? "vitest.config.ts"
const reportDirectory = process.env.STRYKER_REPORT_DIR ?? "reports/mutation"
const tempDirName = process.env.STRYKER_TEMP_DIR ?? ".stryker-tmp"
const testFiles = JSON.parse(process.env.STRYKER_TEST_FILES ?? "[]")

export default {
	plugins: ["@stryker-mutator/vitest-runner"],
	testRunner: "vitest",
	vitest: {
		configFile: vitestConfig,
		related: process.env.STRYKER_VITEST_RELATED !== "false",
	},
	testFiles,
	incremental: false,
	inPlace: process.env.STRYKER_IN_PLACE === "true",
	tempDirName,
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
