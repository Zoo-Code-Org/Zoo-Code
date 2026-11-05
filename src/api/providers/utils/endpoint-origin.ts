const FALLBACK = "the configured endpoint"

/**
 * Returns a string that is safe to log for an endpoint URL.
 * A base URL can hold credentials, a path or query secrets, so only
 * the origin (protocol and host:port) of an http(s) URL is returned.
 * Any other input gives a fixed phrase.
 */
export function getLoggableOrigin(url: string): string {
	try {
		const { protocol, host } = new URL(url)
		return protocol === "http:" || protocol === "https:" ? `${protocol}//${host}` : FALLBACK
	} catch {
		return FALLBACK
	}
}
