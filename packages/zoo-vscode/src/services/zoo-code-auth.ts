import * as vscode from "vscode"

import { t } from "../i18n"

const ZOO_CODE_TOKEN_KEY = "zoo-code-session-token"
const ZOO_CODE_USER_NAME_KEY = "zoo-code-user-name"
const ZOO_CODE_USER_EMAIL_KEY = "zoo-code-user-email"
const ZOO_CODE_USER_IMAGE_KEY = "zoo-code-user-image"

let secretStorage: vscode.SecretStorage | undefined

// In-memory cache for synchronous access in ZooCodeHandler hot path
let _cachedToken: string | undefined = undefined
let _cachedUserName: string | undefined = undefined
let _cachedUserEmail: string | undefined = undefined
let _cachedUserImage: string | undefined = undefined
let _cachedSubscriptionStatus: "active" | "inactive" | "unknown" = "unknown"
let _lastSubscriptionCheck: number = 0
const SUBSCRIPTION_CHECK_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

export async function initZooCodeAuth(context: vscode.ExtensionContext): Promise<void> {
	if (!context.secrets) {
		// Secret storage unavailable (e.g. test environment without secrets mock).
		// Treat as unauthenticated startup — all cached values remain undefined.
		return
	}
	secretStorage = context.secrets

	// Pre-load the token and user info into memory on init so ZooCodeHandler can access them synchronously
	_cachedToken = await secretStorage.get(ZOO_CODE_TOKEN_KEY)
	_cachedUserName = await secretStorage.get(ZOO_CODE_USER_NAME_KEY)
	_cachedUserEmail = await secretStorage.get(ZOO_CODE_USER_EMAIL_KEY)
	_cachedUserImage = await secretStorage.get(ZOO_CODE_USER_IMAGE_KEY)

	// Validate persisted auth state on init before reporting the user as connected.
	if (_cachedToken) {
		const result = await verifyZooCodeToken()
		if (result === "invalid") {
			// Token is definitively rejected by the backend — clear everything.
			await clearZooCodeUserInfo()
			await clearZooCodeToken()
		} else if (result === "unreachable") {
			// Network is temporarily down; keep the cached session but mark subscription
			// status as unknown so callers know it hasn't been confirmed.
			_cachedSubscriptionStatus = "unknown"
		} else {
			// result === "valid"
			void checkSubscriptionStatus().catch(() => {})
		}
	}

	// Watch for secret changes and update cache
	context.secrets.onDidChange((e) => {
		if (e.key === ZOO_CODE_TOKEN_KEY) {
			secretStorage?.get(ZOO_CODE_TOKEN_KEY).then((token) => {
				_cachedToken = token
				// Reset subscription status when token changes
				_cachedSubscriptionStatus = "unknown"
				_lastSubscriptionCheck = 0
				if (token) {
					checkSubscriptionStatus().catch(() => {})
				}
			})
		}
		if (e.key === ZOO_CODE_USER_NAME_KEY) {
			secretStorage?.get(ZOO_CODE_USER_NAME_KEY).then((name) => {
				_cachedUserName = name
			})
		}
		if (e.key === ZOO_CODE_USER_EMAIL_KEY) {
			secretStorage?.get(ZOO_CODE_USER_EMAIL_KEY).then((email) => {
				_cachedUserEmail = email
			})
		}
		if (e.key === ZOO_CODE_USER_IMAGE_KEY) {
			secretStorage?.get(ZOO_CODE_USER_IMAGE_KEY).then((image) => {
				_cachedUserImage = image
			})
		}
	})
}

// Synchronous getter for use in ZooCodeHandler (called in hot path during API requests)
export function getCachedZooCodeToken(): string {
	return _cachedToken ?? ""
}

export function getCachedZooCodeUserInfo(): { name?: string; email?: string; image?: string } {
	return {
		name: _cachedUserName,
		email: _cachedUserEmail,
		image: _cachedUserImage,
	}
}

/**
 * Get the cached subscription status. This is a synchronous getter that returns
 * the last known subscription status. Call checkSubscriptionStatus() to refresh.
 */
export function getCachedSubscriptionStatus(): "active" | "inactive" | "unknown" {
	return _cachedSubscriptionStatus
}

/**
 * Check the subscription status from the backend API.
 * Updates the cached status and returns it.
 * Implements caching to avoid excessive API calls (5 minute cache).
 */
export async function checkSubscriptionStatus(): Promise<"active" | "inactive" | "unknown"> {
	const token = await getZooCodeToken()
	if (!token) {
		_cachedSubscriptionStatus = "inactive"
		return "inactive"
	}

	// Return cached status if checked recently
	const now = Date.now()
	if (now - _lastSubscriptionCheck < SUBSCRIPTION_CHECK_INTERVAL_MS && _cachedSubscriptionStatus !== "unknown") {
		return _cachedSubscriptionStatus
	}

	const baseUrl = getZooCodeBaseUrl()

	try {
		const response = await fetch(`${baseUrl}/api/subscription/status`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		})

		if (!response.ok) {
			_cachedSubscriptionStatus = "unknown"
			_lastSubscriptionCheck = now
			return "unknown"
		}

		const data = (await response.json()) as { isSubscriber?: boolean }
		_cachedSubscriptionStatus = data.isSubscriber ? "active" : "inactive"
		_lastSubscriptionCheck = now
		return _cachedSubscriptionStatus
	} catch {
		_cachedSubscriptionStatus = "unknown"
		_lastSubscriptionCheck = now
		return "unknown"
	}
}

export async function getZooCodeToken(): Promise<string | undefined> {
	if (!secretStorage) return undefined
	return secretStorage.get(ZOO_CODE_TOKEN_KEY)
}

export async function setZooCodeToken(token: string): Promise<void> {
	if (!secretStorage) return
	await secretStorage.store(ZOO_CODE_TOKEN_KEY, token)
	_cachedToken = token
	// Reset subscription status when token is set
	_cachedSubscriptionStatus = "unknown"
	_lastSubscriptionCheck = 0
}

export async function setZooCodeUserInfo(info: {
	name?: string | null
	email?: string | null
	image?: string | null
}): Promise<void> {
	if (!secretStorage) return

	if (info.name) {
		await secretStorage.store(ZOO_CODE_USER_NAME_KEY, info.name)
		_cachedUserName = info.name
	} else if (info.name === null) {
		await secretStorage.delete(ZOO_CODE_USER_NAME_KEY)
		_cachedUserName = undefined
	}

	if (info.email) {
		await secretStorage.store(ZOO_CODE_USER_EMAIL_KEY, info.email)
		_cachedUserEmail = info.email
	} else if (info.email === null) {
		await secretStorage.delete(ZOO_CODE_USER_EMAIL_KEY)
		_cachedUserEmail = undefined
	}

	if (info.image) {
		await secretStorage.store(ZOO_CODE_USER_IMAGE_KEY, info.image)
		_cachedUserImage = info.image
	} else if (info.image === null) {
		await secretStorage.delete(ZOO_CODE_USER_IMAGE_KEY)
		_cachedUserImage = undefined
	}
}

export async function clearZooCodeUserInfo(): Promise<void> {
	if (!secretStorage) return
	await secretStorage.delete(ZOO_CODE_USER_NAME_KEY)
	await secretStorage.delete(ZOO_CODE_USER_EMAIL_KEY)
	await secretStorage.delete(ZOO_CODE_USER_IMAGE_KEY)
	_cachedUserName = undefined
	_cachedUserEmail = undefined
	_cachedUserImage = undefined
}

export async function clearZooCodeToken(): Promise<void> {
	if (!secretStorage) return
	await secretStorage.delete(ZOO_CODE_TOKEN_KEY)
	_cachedToken = undefined
	_cachedSubscriptionStatus = "unknown"
	_lastSubscriptionCheck = 0
}

export function getZooCodeBaseUrl(): string {
	return process.env.ZOO_CODE_BASE_URL || "https://www.zoocode.dev"
}

export async function handleAuthCallback(token: string): Promise<boolean> {
	if (!token || !token.startsWith("zoo_ext_")) {
		vscode.window.showErrorMessage(t("common:zooAuth.errors.invalid_token_received"))
		return false
	}

	// Verify token with backend before storing
	const baseUrl = getZooCodeBaseUrl()
	try {
		const response = await fetch(`${baseUrl}/api/extension/auth/verify`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		})
		if (!response.ok) {
			vscode.window.showErrorMessage(t("common:zooAuth.errors.token_verification_failed"))
			return false
		}
		const data = (await response.json()) as { valid?: boolean }
		if (!data.valid) {
			vscode.window.showErrorMessage(t("common:zooAuth.errors.invalid_token"))
			return false
		}
	} catch {
		vscode.window.showErrorMessage(t("common:zooAuth.errors.could_not_verify_token"))
		return false
	}

	await setZooCodeToken(token)

	// Check subscription status after successful auth
	await checkSubscriptionStatus().catch(() => {})

	vscode.window.showInformationMessage(t("common:zooAuth.info.connected"))
	return true
}

/**
 * Verify the stored token against the backend.
 * Returns:
 *   - "valid"       — backend confirmed the token is good
 *   - "invalid"     — backend explicitly rejected the token (HTTP error or valid: false)
 *   - "unreachable" — network error / timeout; token state is unknown
 *
 * This function has no side-effects; callers are responsible for acting on the result.
 */
export async function verifyZooCodeToken(): Promise<"valid" | "invalid" | "unreachable"> {
	const token = await getZooCodeToken()
	if (!token) return "invalid"

	const baseUrl = getZooCodeBaseUrl()

	try {
		const response = await fetch(`${baseUrl}/api/extension/auth/verify`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		})

		if (!response.ok) {
			return "invalid"
		}

		const data = (await response.json()) as { valid?: boolean }
		return data.valid === true ? "valid" : "invalid"
	} catch {
		return "unreachable"
	}
}

export async function isZooCodeAuthenticated(): Promise<boolean> {
	const token = await getZooCodeToken()
	return !!token
}

export async function disconnectZooCode(): Promise<void> {
	const token = await getZooCodeToken()
	if (token) {
		const baseUrl = getZooCodeBaseUrl()

		try {
			await fetch(`${baseUrl}/api/extension/auth/revoke`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(10_000),
			})
		} catch {
			// Ignore errors during revocation
		}
	}
	await clearZooCodeToken()
	await clearZooCodeUserInfo()
	vscode.window.showInformationMessage(t("common:zooAuth.info.disconnected"))
}
