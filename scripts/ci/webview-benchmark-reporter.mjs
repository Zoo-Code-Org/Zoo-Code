import { writeFileSync } from "node:fs"

export default class WebviewBenchmarkReporter {
	onTestRunEnd(modules, errors, reason) {
		const report = {
			reason,
			errors: errors.map((error) => ({ name: error.name, message: error.message })),
			files: modules.map((module) => ({
				file: module.relativeModuleId.replaceAll("\\", "/"),
				ok: module.ok(),
				diagnostic: module.diagnostic(),
				tests: [...module.children.allTests()].map((test) => ({
					name: test.fullName.replaceAll("\\", "/"),
					state: test.result().state,
					diagnostic: test.diagnostic(),
				})),
			})),
		}

		writeFileSync(process.env.WEBVIEW_BENCHMARK_REPORT, JSON.stringify(report, null, 2) + "\n")
	}
}
