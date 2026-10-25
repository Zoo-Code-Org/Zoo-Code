/**
 * Locale environment handling for commands spawned by Zoo Code.
 *
 * Commands used to be spawned with a hardcoded `LANG`/`LC_ALL` of `en_US.UTF-8` so that
 * tools such as Ruby and CocoaPods always emit UTF-8. Overriding the locale
 * unconditionally is harmful on hosts where `en_US.UTF-8` is not generated: every
 * command then prints `setlocale: LC_ALL: cannot change locale (en_US.UTF-8)`, and
 * locale-sensitive tools behave as if the machine were US English.
 */

/** UTF-8 locale used when (and only when) the host does not provide one of its own. */
const FALLBACK_UTF8_LOCALE = "en_US.UTF-8"

/**
 * Resolves the effective locale of a process environment.
 *
 * POSIX resolves the locale from the first non-empty value of `LC_ALL`, `LC_CTYPE` and
 * `LANG`, so the effective locale is what matters here, not the individual variables.
 */
function getEffectiveLocale(env: NodeJS.ProcessEnv): string {
	return env.LC_ALL || env.LC_CTYPE || env.LANG || ""
}

/** Whether a locale string selects a UTF-8 codeset (accepts the `UTF-8` and `utf8` spellings). */
function isUtf8Locale(locale: string): boolean {
	return /utf-?8/i.test(locale)
}

/**
 * Returns the locale overrides to merge into the environment of a spawned command.
 *
 * A host that already resolves to a UTF-8 locale is left untouched so that commands
 * inherit the user's locale; only a host without any UTF-8 locale receives the UTF-8
 * fallback that the historical hardcoded override was meant to provide.
 */
export function getUtf8LocaleEnv(env: NodeJS.ProcessEnv = process.env): { LANG?: string; LC_ALL?: string } {
	if (isUtf8Locale(getEffectiveLocale(env))) {
		return {}
	}

	return { LANG: FALLBACK_UTF8_LOCALE, LC_ALL: FALLBACK_UTF8_LOCALE }
}
