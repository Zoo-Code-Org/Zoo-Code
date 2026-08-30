import { config } from "@roo-code/config-eslint/base"

/** @type {import("eslint").Linter.Config} */
export default [
	...config,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				project: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-floating-promises": "error",
		},
	},
]
