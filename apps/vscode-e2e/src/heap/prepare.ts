import fs from "fs/promises"
import path from "path"
import { execFileSync } from "child_process"

async function main() {
	const repositoryRoot = path.resolve(__dirname, "../../../..")
	const results = process.env.HEAP_BENCHMARK_DIR ?? path.join(repositoryRoot, "apps/vscode-e2e/heap-results")
	const base =
		process.env.HEAP_BASE_REF ??
		execFileSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: repositoryRoot, encoding: "utf8" }).trim()
	await fs.mkdir(results, { recursive: true })
	for (const variant of ["base", "candidate"]) {
		const root = path.join(results, "builds", variant)
		const extension = path.join(root, "src")
		await fs.mkdir(extension, { recursive: true })
		await fs.cp(path.join(repositoryRoot, "webview-ui"), path.join(root, "webview-ui"), {
			recursive: true,
			filter: (source) =>
				![
					"node_modules",
					"coverage",
					"coverage-ct",
					"test-results",
					"playwright-report",
					"monocart-report",
				].includes(path.basename(source)),
		})
		const link = async (source: string, target: string) => {
			await fs.rm(target, { recursive: true, force: true })
			await fs.symlink(source, target)
		}
		await link(path.join(repositoryRoot, "node_modules"), path.join(root, "node_modules"))
		await link(path.join(repositoryRoot, "webview-ui/node_modules"), path.join(root, "webview-ui/node_modules"))
		for (const name of ["dist", "node_modules", "assets", "shared", "integrations"])
			await link(path.join(repositoryRoot, "src", name), path.join(extension, name))
		for (const name of (await fs.readdir(path.join(repositoryRoot, "src"))).filter(
			(entry) => entry.startsWith("package") && entry.endsWith(".json"),
		)) {
			await fs.copyFile(path.join(repositoryRoot, "src", name), path.join(extension, name))
		}
		await fs.mkdir(path.join(extension, "webview-ui"), { recursive: true })
		await link(path.join(repositoryRoot, "src/webview-ui/audio"), path.join(extension, "webview-ui/audio"))
		if (variant === "base") {
			// Hold the host, styles and unrelated code constant; compare only the
			// state context module with its base version.
			const file = "context/ExtensionStateContext.tsx"
			const contents = execFileSync("git", ["show", `${base}:webview-ui/src/${file}`], {
				cwd: repositoryRoot,
			})
			await fs.writeFile(path.join(root, "webview-ui/src", file), contents)
		}
		// Source maps do not affect runtime behavior and are omitted in both builds
		// to keep this diagnostic usable on memory-constrained runners.
		const viteConfig = path.join(root, "webview-ui/vite.config.ts")
		await fs.writeFile(
			viteConfig,
			(await fs.readFile(viteConfig, "utf8")).replace("sourcemap: true,", "sourcemap: false,"),
		)
		execFileSync("pnpm", ["exec", "vite", "build"], {
			cwd: path.join(root, "webview-ui"),
			stdio: "inherit",
			env: { ...process.env, RAYON_NUM_THREADS: "2", NODE_OPTIONS: "--max-old-space-size=2048" },
		})
	}
	await fs.writeFile(
		path.join(results, "builds.json"),
		JSON.stringify(
			{
				base,
				candidate: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
				results,
			},
			null,
			2,
		),
	)
}
void main().catch((error: unknown) => {
	console.error(error)
	process.exitCode = 1
})
