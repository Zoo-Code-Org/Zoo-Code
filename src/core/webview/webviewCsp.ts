/** Return one CSP source, never configuration-supplied policy or markup. */
export function getOpenRouterCspOrigin(baseUrl?: string): string {
	try {
		const url = new URL(baseUrl || "https://openrouter.ai")
		// URL hostnames can contain CSP delimiters such as semicolons and quotes.
		// Allow DNS names, IPv4 and bracketed IPv6, including local proxy hosts.
		if ((url.protocol === "https:" || url.protocol === "http:") && /^[a-z0-9._:[\]-]+$/i.test(url.hostname)) {
			return url.origin
		}
	} catch {
		// Invalid endpoints must not prevent the webview from rendering safely.
	}
	return "https://openrouter.ai"
}

/** Escape a complete CSP for a double-quoted HTML attribute. */
export function escapeCspAttribute(policy: string): string {
	return policy.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
