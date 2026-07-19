import type { ExtensionContext } from "vscode"
import { z } from "zod"

export const KIMI_CODE_OAUTH_CONFIG = {
	authHost: "https://auth.kimi.com",
	deviceAuthorizationEndpoint: "https://auth.kimi.com/api/oauth/device_authorization",
	tokenEndpoint: "https://auth.kimi.com/api/oauth/token",
	deviceGrantType: "urn:ietf:params:oauth:grant-type:device_code",
	// Kimi Code's official public client ID for the OAuth device flow.
	// Source: Kimi Code CLI's published OAuth integration.
	clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
} as const

const KIMI_CODE_CREDENTIALS_KEY = "kimi-code-oauth-credentials"
const TOKEN_EXPIRY_BUFFER_MS = 60_000
const OAUTH_REQUEST_TIMEOUT_MS = 30_000

const credentialsSchema = z.object({
	type: z.literal("kimi-code"),
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1),
	expiresAt: z.number(),
	tokenType: z.string().optional(),
})

const deviceAuthorizationSchema = z.object({
	device_code: z.string().min(1),
	user_code: z.string().min(1),
	verification_uri: z.string().url(),
	verification_uri_complete: z.string().url().optional(),
	expires_in: z.number().positive(),
	interval: z.number().positive().optional(),
})

const tokenResponseSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1).optional(),
	expires_in: z.number().positive(),
	token_type: z.string().optional(),
})

const oauthErrorSchema = z.object({
	error: z.string(),
	error_description: z.string().optional(),
})

export type KimiCodeCredentials = z.infer<typeof credentialsSchema>

export type KimiCodeOAuthState = {
	status: "idle" | "authorizing" | "polling" | "authenticated" | "error"
	userCode?: string
	verificationUri?: string
	expiresAt?: number
	error?: string
}

export type KimiCodeDeviceAuthorization = {
	userCode: string
	verificationUri: string
	verificationUriComplete?: string
	expiresAt: number
}

class KimiCodeOAuthError extends Error {
	constructor(
		message: string,
		public readonly code?: string,
	) {
		super(message)
		this.name = "KimiCodeOAuthError"
	}
}

async function postForm(endpoint: string, values: Record<string, string>, signal?: AbortSignal): Promise<Response> {
	const controller = new AbortController()
	const forwardAbort = () => controller.abort(signal?.reason)
	if (signal?.aborted) forwardAbort()
	else signal?.addEventListener("abort", forwardAbort, { once: true })
	const timeout = setTimeout(
		() => controller.abort(new Error("Kimi Code OAuth request timed out")),
		OAUTH_REQUEST_TIMEOUT_MS,
	)
	try {
		return await fetch(endpoint, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(values).toString(),
			signal: controller.signal,
		})
	} finally {
		clearTimeout(timeout)
		signal?.removeEventListener("abort", forwardAbort)
	}
}

async function readOAuthError(response: Response): Promise<KimiCodeOAuthError> {
	const text = await response.text()
	try {
		const parsed = oauthErrorSchema.parse(JSON.parse(text))
		return new KimiCodeOAuthError(parsed.error_description ?? parsed.error, parsed.error)
	} catch {
		return new KimiCodeOAuthError(`OAuth request failed: ${response.status} ${response.statusText} - ${text}`)
	}
}

export async function requestDeviceAuthorization(signal?: AbortSignal) {
	const response = await postForm(
		KIMI_CODE_OAUTH_CONFIG.deviceAuthorizationEndpoint,
		{ client_id: KIMI_CODE_OAUTH_CONFIG.clientId },
		signal,
	)
	if (!response.ok) throw await readOAuthError(response)
	return deviceAuthorizationSchema.parse(await response.json())
}

async function requestDeviceToken(deviceCode: string, signal?: AbortSignal): Promise<KimiCodeCredentials> {
	const response = await postForm(
		KIMI_CODE_OAUTH_CONFIG.tokenEndpoint,
		{
			grant_type: KIMI_CODE_OAUTH_CONFIG.deviceGrantType,
			device_code: deviceCode,
			client_id: KIMI_CODE_OAUTH_CONFIG.clientId,
		},
		signal,
	)
	if (!response.ok) throw await readOAuthError(response)
	const tokens = tokenResponseSchema.parse(await response.json())
	if (!tokens.refresh_token) throw new Error("Kimi Code OAuth did not return a refresh token")
	return {
		type: "kimi-code",
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: Date.now() + tokens.expires_in * 1000,
		tokenType: tokens.token_type,
	}
}

export async function refreshKimiCodeAccessToken(credentials: KimiCodeCredentials): Promise<KimiCodeCredentials> {
	const response = await postForm(KIMI_CODE_OAUTH_CONFIG.tokenEndpoint, {
		grant_type: "refresh_token",
		refresh_token: credentials.refreshToken,
		client_id: KIMI_CODE_OAUTH_CONFIG.clientId,
	})
	if (!response.ok) throw await readOAuthError(response)
	const tokens = tokenResponseSchema.parse(await response.json())
	return {
		type: "kimi-code",
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token ?? credentials.refreshToken,
		expiresAt: Date.now() + tokens.expires_in * 1000,
		tokenType: tokens.token_type ?? credentials.tokenType,
	}
}

const delay = (milliseconds: number, signal: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const timeout = signal.aborted
			? undefined
			: setTimeout(() => {
					signal.removeEventListener("abort", onAbort)
					resolve()
				}, milliseconds)
		const onAbort = () => {
			if (timeout) clearTimeout(timeout)
			reject(new Error("Kimi Code authorization was cancelled"))
		}
		if (signal.aborted) {
			onAbort()
			return
		}
		signal.addEventListener("abort", onAbort, { once: true })
	})

export class KimiCodeOAuthManager {
	private context: ExtensionContext | null = null
	private credentials: KimiCodeCredentials | null = null
	private state: KimiCodeOAuthState = { status: "idle" }
	private refreshPromise: Promise<KimiCodeCredentials | null> | null = null
	private pollingPromise: Promise<KimiCodeCredentials> | null = null
	private pollingController: AbortController | null = null
	private credentialsGeneration = 0
	private authorizationGeneration = 0

	initialize(context: ExtensionContext): void {
		this.context = context
	}

	getState(): KimiCodeOAuthState {
		return { ...this.state }
	}

	private async loadCredentials(): Promise<KimiCodeCredentials | null> {
		if (this.credentials) return this.credentials
		const stored = await this.context?.secrets.get(KIMI_CODE_CREDENTIALS_KEY)
		if (!stored) return null
		try {
			this.credentials = credentialsSchema.parse(JSON.parse(stored))
			return this.credentials
		} catch {
			await this.context?.secrets.delete(KIMI_CODE_CREDENTIALS_KEY)
			return null
		}
	}

	private async saveCredentials(
		credentials: KimiCodeCredentials,
		isCurrent: () => boolean = () => true,
	): Promise<boolean> {
		if (!this.context) throw new Error("Kimi Code OAuth manager is not initialized")
		if (!isCurrent()) return false
		const serialized = JSON.stringify(credentials)
		await this.context.secrets.store(KIMI_CODE_CREDENTIALS_KEY, serialized)
		if (!isCurrent()) {
			if ((await this.context.secrets.get(KIMI_CODE_CREDENTIALS_KEY)) === serialized) {
				await this.context.secrets.delete(KIMI_CODE_CREDENTIALS_KEY)
			}
			return false
		}
		this.credentials = credentials
		this.state = { status: "authenticated" }
		return true
	}

	async clearCredentials(): Promise<void> {
		this.credentialsGeneration++
		this.cancelAuthorization()
		const refreshPromise = this.refreshPromise
		if (refreshPromise) await refreshPromise.catch(() => null)
		await this.context?.secrets.delete(KIMI_CODE_CREDENTIALS_KEY)
		this.credentials = null
		this.state = { status: "idle" }
	}

	async isAuthenticated(): Promise<boolean> {
		return (await this.getAccessToken()) !== null
	}

	async getAccessToken(forceRefresh = false): Promise<string | null> {
		const credentials = await this.loadCredentials()
		if (!credentials) return null
		if (!forceRefresh && Date.now() < credentials.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
			return credentials.accessToken
		}
		if (!this.refreshPromise) {
			const generation = this.credentialsGeneration
			this.refreshPromise = refreshKimiCodeAccessToken(credentials)
				.then(async (next) => {
					if (!(await this.saveCredentials(next, () => generation === this.credentialsGeneration)))
						return null
					return next
				})
				.catch(async (error) => {
					if (error instanceof KimiCodeOAuthError && error.code === "invalid_grant") {
						this.credentialsGeneration++
						await this.context?.secrets.delete(KIMI_CODE_CREDENTIALS_KEY)
						this.credentials = null
						this.state = { status: "idle" }
					}
					return null
				})
				.finally(() => {
					this.refreshPromise = null
				})
		}
		return (await this.refreshPromise)?.accessToken ?? null
	}

	async forceRefreshAccessToken(): Promise<string | null> {
		return this.getAccessToken(true)
	}

	async startAuthorization(): Promise<KimiCodeDeviceAuthorization> {
		this.cancelAuthorization()
		const generation = ++this.authorizationGeneration
		this.state = { status: "authorizing" }
		const controller = new AbortController()
		this.pollingController = controller
		try {
			const device = await requestDeviceAuthorization(controller.signal)
			if (generation !== this.authorizationGeneration || this.pollingController !== controller) {
				throw new Error("Kimi Code authorization was cancelled")
			}
			const expiresAt = Date.now() + device.expires_in * 1000
			const verificationUri = device.verification_uri_complete ?? device.verification_uri
			this.state = {
				status: "polling",
				userCode: device.user_code,
				verificationUri,
				expiresAt,
			}
			this.pollingPromise = this.pollForToken(
				device.device_code,
				expiresAt,
				device.interval ?? 5,
				controller,
				generation,
			)
			return {
				userCode: device.user_code,
				verificationUri: device.verification_uri,
				verificationUriComplete: device.verification_uri_complete,
				expiresAt,
			}
		} catch (error) {
			if (generation === this.authorizationGeneration && this.pollingController === controller) {
				this.state = { status: "error", error: error instanceof Error ? error.message : String(error) }
				this.pollingController = null
			}
			throw error
		}
	}

	waitForAuthorization(): Promise<KimiCodeCredentials> {
		if (!this.pollingPromise) throw new Error("No Kimi Code authorization is in progress")
		return this.pollingPromise
	}

	cancelAuthorization(): void {
		this.authorizationGeneration++
		this.pollingController?.abort()
		this.pollingController = null
		this.pollingPromise = null
		if (this.state.status === "authorizing" || this.state.status === "polling") this.state = { status: "idle" }
	}

	private async pollForToken(
		deviceCode: string,
		expiresAt: number,
		initialIntervalSeconds: number,
		controller: AbortController,
		generation: number,
	): Promise<KimiCodeCredentials> {
		let intervalSeconds = initialIntervalSeconds
		try {
			while (Date.now() < expiresAt) {
				await delay(intervalSeconds * 1000, controller.signal)
				try {
					const credentials = await requestDeviceToken(deviceCode, controller.signal)
					if (generation !== this.authorizationGeneration || this.pollingController !== controller) {
						throw new Error("Kimi Code authorization was cancelled")
					}
					const saved = await this.saveCredentials(
						credentials,
						() => generation === this.authorizationGeneration && this.pollingController === controller,
					)
					if (!saved) throw new Error("Kimi Code authorization was cancelled")
					return credentials
				} catch (error) {
					if (error instanceof KimiCodeOAuthError && error.code === "authorization_pending") continue
					if (error instanceof KimiCodeOAuthError && error.code === "slow_down") {
						intervalSeconds += 5
						continue
					}
					throw error
				}
			}
			throw new Error("Kimi Code authorization expired")
		} catch (error) {
			if (
				!controller.signal.aborted &&
				generation === this.authorizationGeneration &&
				this.pollingController === controller
			) {
				this.state = { status: "error", error: error instanceof Error ? error.message : String(error) }
			}
			throw error
		} finally {
			if (generation === this.authorizationGeneration && this.pollingController === controller) {
				this.pollingController = null
				this.pollingPromise = null
			}
		}
	}
}

export const kimiCodeOAuthManager = new KimiCodeOAuthManager()
