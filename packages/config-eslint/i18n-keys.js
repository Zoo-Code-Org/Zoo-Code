// i18next splits a namespace from a key on ":" only. t("chat.foo") has no namespace, so it looks in the
// default namespace, misses, and shows the raw key to the user. Built-in no-restricted-syntax only.
import { readdirSync } from "node:fs"
import { basename } from "node:path"

/**
 * @param {URL | string} enLocalesDir The `en` locale directory. Each JSON file name is a namespace.
 */
export function createI18nDotKeyConfig(enLocalesDir) {
	const namespaces = readdirSync(enLocalesDir)
		.filter((file) => file.endsWith(".json"))
		.map((file) => basename(file, ".json"))
	const dotKey = `/^(${namespaces.join("|")})\\./`
	const message = "Write the key as 'namespace:path'. A dot after the namespace is not a namespace separator."

	return {
		files: ["**/*.ts", "**/*.tsx"],
		ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
		rules: {
			"no-restricted-syntax": [
				"error",
				...i18nDotKeySelectors(dotKey).map((selector) => ({ selector, message })),
			],
		},
	}
}

/** The selectors alone, for a file set that already sets no-restricted-syntax. */
export function getI18nDotKeySelectors(config) {
	return config.rules["no-restricted-syntax"].slice(1)
}

function i18nDotKeySelectors(dotKey) {
	const call = "CallExpression:matches([callee.name='t'], [callee.property.name='t'])"
	return [`${call}[arguments.0.value=${dotKey}]`, `${call}[arguments.0.quasis.0.value.cooked=${dotKey}]`]
}
