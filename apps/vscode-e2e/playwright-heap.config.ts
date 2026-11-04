import path from "path"
import { defineConfig } from "@playwright/test"

const results = process.env.HEAP_BENCHMARK_DIR ?? path.resolve(__dirname, "heap-results")
export default defineConfig({
	testDir: "./src/heap",
	testMatch: "electron.heap.ts",
	outputDir: path.join(results, "runs"),
	fullyParallel: false,
	workers: 1,
	repeatEach: Number(process.env.HEAP_REPEATS ?? 3),
	timeout: 5 * 60_000,
	expect: { timeout: 90_000 },
	projects: [{ name: "base" }, { name: "candidate" }],
	reporter: [["list"], ["json", { outputFile: path.join(results, "playwright.json") }]],
})
