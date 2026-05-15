import { chmod, copyFile, mkdir, stat, writeFile } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const extensionRoot = path.resolve(scriptDir, "..")
const repoRoot = path.resolve(extensionRoot, "../../..")

const platform = process.platform
const arch = process.arch
const ext = platform === "win32" ? ".exe" : ""

const platformPackage = (() => {
	if (platform === "linux" && arch === "x64") return "@zoo-code/cli-linux-x64"
	if (platform === "linux" && arch === "arm64") return "@zoo-code/cli-linux-arm64"
	if (platform === "darwin" && arch === "x64") return "@zoo-code/cli-darwin-x64"
	if (platform === "darwin" && arch === "arm64") return "@zoo-code/cli-darwin-arm64"
	if (platform === "win32" && arch === "x64") return "@zoo-code/cli-win32-x64"
	throw new Error(`Unsupported Zoo CLI binary platform: ${platform}-${arch}`)
})()

async function exists(file: string) {
	try {
		await stat(file)
		return true
	} catch {
		return false
	}
}

const source = process.env.ZOO_CLI_BINARY
	? path.resolve(process.env.ZOO_CLI_BINARY)
	: path.join(repoRoot, "packages", "zoo-cli", "dist", platformPackage, "bin", `zoo${ext}`)

if (!(await exists(source))) {
	throw new Error(
		`Zoo CLI binary not found at ${source}. Run \`pnpm --filter @zoo-code/cli build\` first or set ZOO_CLI_BINARY.`,
	)
}

const binDir = path.join(extensionRoot, "assets", "bin")
const destination = path.join(binDir, `zoo${ext}`)

await mkdir(binDir, { recursive: true })
await copyFile(source, destination)
if (platform !== "win32") await chmod(destination, 0o755)

await writeFile(
	path.join(binDir, "manifest.json"),
	JSON.stringify(
		{
			name: "@zoo-code/cli",
			platform,
			arch,
			binary: `zoo${ext}`,
			source: path.relative(extensionRoot, source),
		},
		null,
		2,
	) + "\n",
)

console.log(`Prepared Zoo CLI binary at ${path.relative(extensionRoot, destination)}`)
