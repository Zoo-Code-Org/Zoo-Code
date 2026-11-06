/**
 * The locale for the dates and times of the display: the application language, else the platform's. A tag the platform
 * does not know falls back by itself; one that is not a language tag at all would throw a RangeError and abort the
 * render, and is left out here.
 */
export const dateLocale = (language: string | undefined): string | undefined => {
	try {
		return language ? Intl.getCanonicalLocales(language)[0] : undefined
	} catch {
		return undefined
	}
}
