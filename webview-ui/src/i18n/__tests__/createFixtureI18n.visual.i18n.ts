import i18next, { type i18n } from "i18next"

/**
 * An i18next instance for a visual fixture that serves exactly `translations`, keyed `"ns:dotted.key"`.
 * Pass it to react-i18next's `I18nextProvider`. Missing keys render as the qualified key.
 */
export function createFixtureI18n(translations: Record<string, string>): i18n {
	const resources: Record<string, Record<string, unknown>> = {}

	for (const [qualifiedKey, value] of Object.entries(translations)) {
		const [ns, key] = qualifiedKey.split(":")
		const path = key.split(".")
		let node = (resources[ns] ??= {})

		for (const segment of path.slice(0, -1)) {
			node = (node[segment] ??= {}) as Record<string, unknown>
		}

		node[path[path.length - 1]] = value
	}

	const instance = i18next.createInstance()

	// Inline resources and `initAsync: false` make the instance ready before the fixture renders.
	void instance.init({
		lng: "en",
		resources: { en: resources },
		ns: Object.keys(resources),
		initAsync: false,
		appendNamespaceToMissingKey: true,
		interpolation: { escapeValue: false },
	})

	return instance
}
