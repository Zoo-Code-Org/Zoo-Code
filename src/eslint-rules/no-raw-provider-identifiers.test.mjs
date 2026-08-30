import { RuleTester } from "eslint"

import { noRawProviderIdentifiers } from "./no-raw-provider-identifiers.mjs"

const ruleTester = new RuleTester({
	languageOptions: {
		ecmaVersion: 2022,
		sourceType: "module",
	},
})

ruleTester.run("no-raw-provider-identifiers", noRawProviderIdentifiers, {
	valid: [
		"const apiProvider = retiredProviderIdentifiers.roo",
		"const provider = retiredProviderIdentifiers.groq",
	],
	invalid: [
		{
			code: 'const apiProvider = "roo"',
			errors: [
				{
					message:
						'Use retiredProviderIdentifiers.roo instead of the raw provider identifier "roo".',
					type: "Literal",
				},
			],
		},
		{
			code: "const persistedProvider = `groq`",
			errors: [
				{
					message:
						'Use retiredProviderIdentifiers.groq instead of the raw provider identifier "groq".',
					type: "TemplateLiteral",
				},
			],
		},
	],
})
