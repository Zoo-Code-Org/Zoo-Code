import { Package } from "@roo/package"

export function getCallbackUrl(provider: string, uriScheme?: string) {
	return encodeURIComponent(`${uriScheme || "vscode"}://${Package.publisher}.${Package.name}/${provider}`)
}

export function getOpenRouterAuthUrl(uriScheme?: string) {
	return `https://openrouter.ai/auth?callback_url=${getCallbackUrl("openrouter", uriScheme)}`
}

export function getRequestyAuthUrl(uriScheme?: string) {
	return `https://app.requesty.ai/oauth/authorize?callback_url=${getCallbackUrl("requesty", uriScheme)}`
}

const ZOO_CODE_BASE_URL = "https://www.zoocode.dev"

export function getZooCodeAuthUrl(uriScheme?: string) {
	const callbackUri = getCallbackUrl("auth-callback", uriScheme)
	const deviceName = encodeURIComponent("VS Code")
	const editor = encodeURIComponent("VS Code")
	const version = Package.version
	return `${ZOO_CODE_BASE_URL}/dashboard/connect?device=${deviceName}&editor=${editor}&version=${version}&callback_uri=${callbackUri}`
}
