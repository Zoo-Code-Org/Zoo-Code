import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"

export default defineConfig({
	plugins: [react()],
	test: {
		include: ["src/**/*.test.{ts,tsx}"],
		environment: "node",
	},
	resolve: {
		tsconfigPaths: true,
	},
})
