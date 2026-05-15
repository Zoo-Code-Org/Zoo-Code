import { clearToken, hasToken, getCredentialsPath } from "@/lib/storage/index.js"

export interface LogoutOptions {
	verbose?: boolean
}

export interface LogoutResult {
	success: boolean
	wasLoggedIn: boolean
}

export async function logout({ verbose = false }: LogoutOptions = {}): Promise<LogoutResult> {
	const wasLoggedIn = await hasToken()

	if (!wasLoggedIn) {
		console.log("No legacy Roo auth token stored.")
		return { success: true, wasLoggedIn: false }
	}

	if (verbose) {
		console.log(`[Auth] Removing credentials from ${getCredentialsPath()}`)
	}

	await clearToken()
	console.log("✓ Removed stored legacy Roo auth token")
	return { success: true, wasLoggedIn: true }
}
