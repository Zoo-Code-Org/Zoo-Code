import { config } from "@roo-code/config-eslint/base"
import { createProviderIdentifierConfig } from "@roo-code/config-eslint/provider-identifiers"
import { providerIdentifiers, retiredProviderIdentifiers } from "./src/provider-identifiers.ts"
import globals from "globals"

/** @type {import("eslint").Linter.Config} */
export default [
	...config,
	createProviderIdentifierConfig({ providerIdentifiers, retiredProviderIdentifiers }),
	{
		files: ["**/*.cjs"],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.commonjs,
			},
			sourceType: "commonjs",
		},
		rules: {
			"@typescript-eslint/no-require-imports": "off",
		},
	},
]
