// Download/extraction helpers must never inherit the provider credential.
import { downloadAndUnzipVSCode, SilentReporter } from "@vscode/test-electron"

const [version, cachePath] = process.argv.slice(2)
const executable = await downloadAndUnzipVSCode({ version, cachePath, reporter: new SilentReporter() })
process.stdout.write(JSON.stringify(executable))
