import type { ExtensionContext } from "vscode"
import { z } from "zod"
import { providerIdentifiers } from "@roo-code/types"

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
	type: z.literal(providerIdentifiers.kimiCode),
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

/** The cancellation contract shared with the provider layer: name AbortError. */
function createOAuthAbortError(): Error {
	const error = new Error("The Kimi Code OAuth request was aborted")
	error.name = "AbortError"
	return error
}

/** A form POST whose cancellation contract outlives the response headers: `settle` detaches the
 * caller's abort forwarder once the body is consumed, so an abort during a body read cancels the
 * underlying response too. An abort detaches the forwarder by itself ({ once: true }). */
interface CancellingPost {
	response: Response
	settle: () => void
}

async function postForm(
	endpoint: string,
	values: Record<string, string>,
	signal?: AbortSignal,
): Promise<CancellingPost> {
	const controller = new AbortController()
	const forwardAbort = () => controller.abort(signal?.reason)
	if (signal?.aborted) forwardAbort()
	else signal?.addEventListener("abort", forwardAbort, { once: true })
	const timeout = setTimeout(
		() => controller.abort(new Error("Kimi Code OAuth request timed out")),
		OAUTH_REQUEST_TIMEOUT_MS,
	)
	const settle = () => {
		signal?.removeEventListener("abort", forwardAbort)
	}
	try {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(values).toString(),
			signal: controller.signal,
		})
		return { response, settle }
	} catch (error) {
		// Nothing will read a body from a POST that never produced a response, so the forwarder
		// is detached on this path and nothing else.
		settle()
		// Classify from the CALLER signal: only a rejection that came from the caller's own abort
		// is normalized. The caller's reason can be an ordinary Error and fetch forwards it
		// verbatim, and an independent OAuth/network failure that merely races the abort must be
		// thrown unchanged. The internal timeout is never normalized here: timeout errors are
		// rethrown as they are so callers can distinguish a stalled POST from a cancellation.
		const callerAborted = signal?.aborted === true
		const isCallerAbortRejection =
			callerAborted && (error === signal?.reason || (error instanceof Error && error.name === "AbortError"))
		if (isCallerAbortRejection) {
			throw createOAuthAbortError()
		}
		throw error
	} finally {
		clearTimeout(timeout)
	}
}
/** Consume a response body under the caller's signal: an abort while the body is still
 * pending surfaces as this module's cancellation instead of waiting for a stalled read. */
async function readBodyWithSignal<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return read()
	if (signal.aborted) throw createOAuthAbortError()
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(createOAuthAbortError())
		signal.addEventListener("abort", onAbort, { once: true })
		void read().then(
			(value) => {
				signal.removeEventListener("abort", onAbort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener("abort", onAbort)
				reject(error)
			},
		)
	})
}

async function readOAuthError(response: Response, signal?: AbortSignal): Promise<KimiCodeOAuthError> {
	const text = await readBodyWithSignal(() => response.text(), signal)
	try {
		const parsed = oauthErrorSchema.parse(JSON.parse(text))
		return new KimiCodeOAuthError(parsed.error_description ?? parsed.error, parsed.error)
	} catch {
		return new KimiCodeOAuthError(`OAuth request failed: ${response.status} ${response.statusText} - ${text}`)
	}
}

export async function requestDeviceAuthorization(signal?: AbortSignal) {
	const { response, settle } = await postForm(
		KIMI_CODE_OAUTH_CONFIG.deviceAuthorizationEndpoint,
		{ client_id: KIMI_CODE_OAUTH_CONFIG.clientId },
		signal,
	)
	try {
		if (!response.ok) throw await readOAuthError(response, signal)
		return deviceAuthorizationSchema.parse(await readBodyWithSignal(() => response.json(), signal))
	} finally {
		settle()
	}
}

async function requestDeviceToken(deviceCode: string, signal?: AbortSignal): Promise<KimiCodeCredentials> {
	const { response, settle } = await postForm(
		KIMI_CODE_OAUTH_CONFIG.tokenEndpoint,
		{
			grant_type: KIMI_CODE_OAUTH_CONFIG.deviceGrantType,
			device_code: deviceCode,
			client_id: KIMI_CODE_OAUTH_CONFIG.clientId,
		},
		signal,
	)
	try {
		if (!response.ok) throw await readOAuthError(response, signal)
		const tokens = tokenResponseSchema.parse(await readBodyWithSignal(() => response.json(), signal))
		if (!tokens.refresh_token) throw new Error("Kimi Code OAuth did not return a refresh token")
		return {
			type: providerIdentifiers.kimiCode,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresAt: Date.now() + tokens.expires_in * 1000,
			tokenType: tokens.token_type,
		}
	} finally {
		settle()
	}
}

export async function refreshKimiCodeAccessToken(
	credentials: KimiCodeCredentials,
	signal?: AbortSignal,
): Promise<KimiCodeCredentials> {
	// The caller's signal aborts the token POST itself, not just the caller's wait: a cancelled
	// task must not keep a refresh request (and its rotated refresh token) in flight.
	const { response, settle } = await postForm(
		KIMI_CODE_OAUTH_CONFIG.tokenEndpoint,
		{
			grant_type: "refresh_token",
			refresh_token: credentials.refreshToken,
			client_id: KIMI_CODE_OAUTH_CONFIG.clientId,
		},
		signal,
	)
	try {
		if (!response.ok) throw await readOAuthError(response, signal)
		const tokens = tokenResponseSchema.parse(await readBodyWithSignal(() => response.json(), signal))
		return {
			type: providerIdentifiers.kimiCode,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token ?? credentials.refreshToken,
			expiresAt: Date.now() + tokens.expires_in * 1000,
			tokenType: tokens.token_type ?? credentials.tokenType,
		}
	} finally {
		settle()
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
	// One shared refresh POST with independent waiter cancellation: each caller races the shared
	// promise against its own signal, and the POST itself is aborted only after every waiter is
	// gone.
	private refreshPromise: Promise<string | null> | null = null
	private refreshController: AbortController | null = null
	private refreshWaiters: Set<{ signal?: AbortSignal }> | null = null
	// Sign-out fence: while credentials are being cleared no new refresh may start, so the drain
	// in clearCredentials() terminates and a caller cannot re-install what its delete removes.
	private clearingCredentials = false
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
		// Install under a new generation: a delayed invalid_grant from an older refresh
		// (whose captured generation is now stale) can no longer clear what this save put in.
		this.credentialsGeneration++
		this.credentials = credentials
		this.state = { status: "authenticated" }
		return true
	}

	async clearCredentials(): Promise<void> {
		this.credentialsGeneration++
		this.cancelAuthorization()
		// Sign-out fences the refresh path. The capture-and-await only waited for the refresh that
		// existed at entry, so a refresh started during that await could still store credentials
		// after the delete. Holding the fence across the await closes that window instead of
		// re-polling for a refresh that cannot appear: the only startRefresh() call site is
		// getAccessToken(), downstream of the fence check below, so while the fence is held no new
		// refresh can begin and the entry-captured one is the only work the delete has to wait for.
		this.clearingCredentials = true
		try {
			const refreshPromise = this.refreshPromise
			if (refreshPromise) {
				await refreshPromise.catch(() => null)
			}
			await this.context?.secrets.delete(KIMI_CODE_CREDENTIALS_KEY)
			this.credentials = null
			this.state = { status: "idle" }
		} finally {
			this.clearingCredentials = false
		}
	}

	async isAuthenticated(): Promise<boolean> {
		return (await this.getAccessToken()) !== null
	}

	async getAccessToken(forceRefresh = false, signal?: AbortSignal): Promise<string | null> {
		const credentials = await this.loadCredentials()
		if (!credentials) return null
		if (!forceRefresh && Date.now() < credentials.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
			return credentials.accessToken
		}
		// A caller that is already cancelled must not start network work it cannot wait for, and a
		// caller that arrives mid-sign-out has no token to be served: starting a refresh here would
		// duplicate the one the sign-out is draining and could re-install what its delete removes.
		if (signal?.aborted) throw createOAuthAbortError()
		if (this.clearingCredentials) return null
		// A pending refresh whose controller was already aborted can never settle successfully:
		// start a replacement even if the old promise has not run its finally yet.
		if (!this.refreshPromise || this.refreshController?.signal.aborted) {
			this.startRefresh(credentials)
		}
		return this.awaitRefresh(signal)
	}

	/** Start the shared refresh POST; callers join it through awaitRefresh(). */
	private startRefresh(credentials: KimiCodeCredentials): void {
		const generation = this.credentialsGeneration
		const controller = new AbortController()
		this.refreshController = controller
		this.refreshWaiters = new Set()
		this.refreshPromise = refreshKimiCodeAccessToken(credentials, controller.signal)
			.then(async (next) => {
				if (!(await this.saveCredentials(next, () => generation === this.credentialsGeneration))) return null
				return next.accessToken
			})
			.catch(async (error) => {
				// A stale refresh must not clear credentials a newer sign-in installed: the
				// generation only changes when a save lands or credentials are cleared, so a
				// mismatch here means this POST's verdict belongs to superseded credentials.
				if (
					error instanceof KimiCodeOAuthError &&
					error.code === "invalid_grant" &&
					generation === this.credentialsGeneration
				) {
					this.credentialsGeneration++
					await this.context?.secrets.delete(KIMI_CODE_CREDENTIALS_KEY)
					this.credentials = null
					this.state = { status: "idle" }
				}
				// The shared POST aborts only after every waiter detached, which is a cancellation:
				// reach each caller as one instead of the "not authenticated" null path.
				if (controller.signal.aborted) throw createOAuthAbortError()
				return null
			})
			.finally(() => {
				// A replacement refresh may have started while this one was settling: only the
				// still-current refresh may clear the shared state.
				if (this.refreshController !== controller) {
					return
				}
				this.refreshPromise = null
				this.refreshController = null
				this.refreshWaiters = null
			})
		// Callers observe the rejection through awaitRefresh(); this guard keeps a refresh whose
		// waiters all detached from surfacing as an unhandled rejection in the extension host.
		void this.refreshPromise.catch(() => {})
	}

	/**
	 * Wait for the shared refresh with this caller's own cancellation: an abort detaches only this
	 * waiter and the shared POST keeps running while another caller still needs it.
	 */
	private awaitRefresh(signal?: AbortSignal): Promise<string | null> {
		const promise = this.refreshPromise
		const waiters = this.refreshWaiters
		// Capture the controller with the waiter set: a waiter that joined this refresh must never
		// abort a replacement refresh it was never enrolled in.
		const controller = this.refreshController
		if (!promise) return Promise.resolve(null)
		if (!waiters) return promise

		const waiter: { signal?: AbortSignal } = { signal }
		waiters.add(waiter)
		if (!signal) {
			// A caller without an AbortSignal cannot detach: keep it registered until the shared
			// POST settles so an aborting signaled caller cannot cancel a refresh this caller needs.
			return promise.finally(() => {
				waiters.delete(waiter)
			})
		}
		if (signal.aborted) {
			waiters.delete(waiter)
			if (waiters.size === 0) controller?.abort(signal.reason)
			return Promise.reject(createOAuthAbortError())
		}
		return new Promise<string | null>((resolve, reject) => {
			let settled = false
			const cleanup = () => {
				settled = true
				waiters.delete(waiter)
				signal.removeEventListener("abort", onAbort)
			}
			const onAbort = () => {
				if (settled) return
				cleanup()
				reject(createOAuthAbortError())
				// Abort the shared POST only when nobody else is waiting for its result.
				if (waiters.size === 0) controller?.abort(signal.reason)
			}
			signal.addEventListener("abort", onAbort, { once: true })
			void promise.then(
				(value) => {
					if (settled) return
					cleanup()
					resolve(value)
				},
				(error) => {
					if (settled) return
					cleanup()
					reject(error)
				},
			)
		})
	}

	async forceRefreshAccessToken(signal?: AbortSignal): Promise<string | null> {
		return this.getAccessToken(true, signal)
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
