import { loadToken, loadCredentials, getCredentialsPath } from "@/lib/storage/index.js"
import { isTokenExpired, isTokenValid, getTokenExpirationDate } from "@/lib/auth/index.js"

export interface StatusOptions {
	verbose?: boolean
}

export interface StatusResult {
	authenticated: boolean
	expired?: boolean
	expiringSoon?: boolean
	userId?: string
	orgId?: string | null
	expiresAt?: Date
	createdAt?: Date
}

export async function status(options: StatusOptions = {}): Promise<StatusResult> {
	const { verbose = false } = options

	const token = await loadToken()

	if (!token) {
		console.log("No legacy Roo auth token stored.")
		console.log("")
		console.log("Normal CLI usage does not require login.")
		console.log("Roo Code Router has been removed, so no legacy Roo sign-in is required.")
		return { authenticated: false }
	}

	const expiresAt = getTokenExpirationDate(token)
	const expired = !isTokenValid(token)
	const expiringSoon = isTokenExpired(token, 24 * 60 * 60) && !expired

	const credentials = await loadCredentials()
	const createdAt = credentials?.createdAt ? new Date(credentials.createdAt) : undefined

	if (expired) {
		console.log("Stored legacy Roo auth token expired.")
		console.log("")
		console.log("Standard CLI usage still works without login.")
		console.log("Roo Code Router has been removed, so you can safely ignore or delete this token.")

		return {
			authenticated: false,
			expired: true,
			expiresAt: expiresAt ?? undefined,
		}
	}

	if (expiringSoon) {
		console.log("⚠ Legacy Roo auth token expires soon; use `roo auth logout` if you want to clean it up.")
	} else {
		console.log("✓ Legacy Roo auth token still stored")
	}

	if (expiresAt) {
		const remaining = getTimeRemaining(expiresAt)
		console.log(`  Expires:      ${formatDate(expiresAt)} (${remaining})`)
	}

	if (createdAt && verbose) {
		console.log(`  Created:      ${formatDate(createdAt)}`)
	}

	if (verbose) {
		console.log(`  Credentials:  ${getCredentialsPath()}`)
	}

	return {
		authenticated: true,
		expired: false,
		expiringSoon,
		expiresAt: expiresAt ?? undefined,
		createdAt,
	}
}

function formatDate(date: Date): string {
	return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
}

function getTimeRemaining(date: Date): string {
	const now = new Date()
	const diff = date.getTime() - now.getTime()

	if (diff <= 0) {
		return "expired"
	}

	const days = Math.floor(diff / (1000 * 60 * 60 * 24))
	const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))

	if (days > 0) {
		return `${days} day${days === 1 ? "" : "s"}`
	}

	return `${hours} hour${hours === 1 ? "" : "s"}`
}
