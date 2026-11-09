export const DEFAULT_LM_STUDIO_BASE_URL = "http://localhost:1234"

export const normalizeLMStudioBaseUrl = (baseUrl?: string): string => {
	const url = baseUrl || DEFAULT_LM_STUDIO_BASE_URL
	let end = url.length
	while (end > 0 && url[end - 1] === "/") end--
	return url.slice(0, end)
}
