// Download/extraction helpers must never inherit the provider credential.
import process from "node:process"
import { downloadAndUnzipVSCode, SilentReporter } from "@vscode/test-electron"

const [version, cachePath] = process.argv.slice(2)
const executable = await downloadAndUnzipVSCode({
	version,
	cachePath: cachePath || undefined,
	reporter: new SilentReporter(),
})
process.stdout.write(JSON.stringify(executable))
