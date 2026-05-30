import path, { resolve } from "path"
import fs from "fs"
import { execSync } from "child_process"

import { defineConfig, type PluginOption, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import tsconfigPaths from "vite-tsconfig-paths"

import { sourcemapPlugin } from "./src/vite-plugins/sourcemapPlugin"

function getGitSha() {
	let gitSha: string | undefined = undefined

	try {
		gitSha = execSync("git rev-parse HEAD").toString().trim()
	} catch (_error) {
		// Do nothing.
	}

	return gitSha
}

const wasmPlugin = (): Plugin => ({
	name: "wasm",
	async load(id) {
		if (id.endsWith(".wasm")) {
			const wasmBinary = await import(id)

			return `
           			const wasmModule = new WebAssembly.Module(${wasmBinary.default});
           			export default wasmModule;
         		`
		}
	},
})

const persistPortPlugin = (): Plugin => ({
	name: "write-port-to-file",
	configureServer(viteDevServer) {
		viteDevServer?.httpServer?.once("listening", () => {
			const address = viteDevServer?.httpServer?.address()
			const port = address && typeof address === "object" ? address.port : null

			if (port) {
				fs.writeFileSync(resolve(__dirname, "..", ".vite-port"), port.toString())
				console.log(`[Vite Plugin] Server started on port ${port}`)
			} else {
				console.warn("[Vite Plugin] Could not determine server port")
			}
		})
	},
})

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
	let outDir = "../src/webview-ui/build"

	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "package.json"), "utf8"))
	const gitSha = getGitSha()

	const define: Record<string, any> = {
		"process.platform": JSON.stringify(process.platform),
		"process.env.VSCODE_TEXTMATE_DEBUG": JSON.stringify(process.env.VSCODE_TEXTMATE_DEBUG),
		"process.env.PKG_NAME": JSON.stringify(pkg.name),
		"process.env.PKG_VERSION": JSON.stringify(pkg.version),
		"process.env.PKG_OUTPUT_CHANNEL": JSON.stringify("Zoo-Code"),
		"process.env.PKG_RELEASE_CHANNEL": JSON.stringify(process.env.PKG_RELEASE_CHANNEL || "stable"),
		...(gitSha ? { "process.env.PKG_SHA": JSON.stringify(gitSha) } : {}),
	}

	// TODO: We can use `@roo-code/build` to generate `define` once the
	// monorepo is deployed.
	if (mode === "nightly") {
		outDir = "../apps/vscode-nightly/build/webview-ui/build"

		const nightlyPkg = JSON.parse(
			fs.readFileSync(path.join(__dirname, "..", "apps", "vscode-nightly", "package.nightly.json"), "utf8"),
		)

		define["process.env.PKG_NAME"] = JSON.stringify(nightlyPkg.name)
		define["process.env.PKG_VERSION"] = JSON.stringify(nightlyPkg.version)
		define["process.env.PKG_OUTPUT_CHANNEL"] = JSON.stringify("Zoo-Code-Nightly")
		define["process.env.PKG_RELEASE_CHANNEL"] = JSON.stringify("prerelease")
	}

	const plugins: PluginOption[] = [
		react({
			babel: {
				plugins: [["babel-plugin-react-compiler", { target: "18" }]],
			},
		}),
		tailwindcss(),
		tsconfigPaths(),
		persistPortPlugin(),
		wasmPlugin(),
		sourcemapPlugin(),
	]

	return {
		plugins,
		resolve: {
			tsconfigPaths: true,
		},
		build: {
			outDir,
			emptyOutDir: true,
			reportCompressedSize: false,
			// Generate complete source maps with original TypeScript sources
			sourcemap: true,
			// Vite 8 uses Rolldown/Oxc by default; keep non-production modes readable.
			minify: mode === "production",
			// Use a single combined CSS bundle so all webviews share styles
			cssCodeSplit: false,
			rolldownOptions: {
				// Externalize vscode module - it's imported by file-search.ts which is
				// dynamically imported by roo-config/index.ts, but should never be bundled
				// in the webview since it's not available in the browser context
				external: ["vscode"],
				input: resolve(__dirname, "index.html"),
				output: {
					entryFileNames: "assets/[name].js",
					chunkFileNames: "assets/[name]-[hash].js",
					assetFileNames: (assetInfo) => {
						const name = assetInfo.name ?? ""

						if (name.endsWith(".css")) {
							return "assets/index.css"
						}

						if (/\.(woff2?|ttf)$/.test(name)) {
							return "assets/fonts/[name][extname]"
						}

						return "assets/[name][extname]"
					},
				},
			},
		},
		server: {
			hmr: {
				host: "localhost",
				protocol: "ws",
			},
			cors: {
				origin: "*",
				methods: "*",
				allowedHeaders: "*",
			},
		},
		define,
		optimizeDeps: {
			exclude: ["@vscode/codicons", "vscode-oniguruma", "shiki"],
		},
		assetsInclude: ["**/*.wasm", "**/*.wav"],
	}
})
