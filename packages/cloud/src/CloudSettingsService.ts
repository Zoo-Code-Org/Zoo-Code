import EventEmitter from "events"

import type { ExtensionContext } from "vscode"

import { z } from "zod"

import {
	type SettingsService,
	type SettingsServiceEvents,
	type AuthService,
	type AuthState,
	type UserFeatures,
	type UserSettingsConfig,
	type UserSettingsData,
	type CloudUserInfo,
	OrganizationAllowList,
	OrganizationSettings,
	organizationSettingsSchema,
	userSettingsDataSchema,
	ORGANIZATION_ALLOW_ALL,
} from "@roo-code/types"

import { getRooCodeApiUrl } from "./config.js"
import { RefreshTimer } from "./RefreshTimer.js"

const ORGANIZATION_SETTINGS_CACHE_KEY = "organization-settings"
const ORGANIZATION_ID_CACHE_KEY = "organization-settings-org-id"
const USER_SETTINGS_CACHE_KEY = "user-settings"

const parseExtensionSettingsResponse = (data: unknown) => {
	const shapeResult = z.object({ organization: z.unknown(), user: z.unknown() }).safeParse(data)

	if (!shapeResult.success) {
		return { success: false, error: shapeResult.error } as const
	}

	const orgResult = organizationSettingsSchema.safeParse(shapeResult.data.organization)

	if (!orgResult.success) {
		return { success: false, error: orgResult.error } as const
	}

	const userResult = userSettingsDataSchema.safeParse(shapeResult.data.user)

	if (!userResult.success) {
		return { success: false, error: userResult.error } as const
	}

	return {
		success: true,
		data: { organization: orgResult.data, user: userResult.data },
	} as const
}

export class CloudSettingsService extends EventEmitter<SettingsServiceEvents> implements SettingsService {
	private context: ExtensionContext
	private authService: AuthService
	private settings: OrganizationSettings | undefined = undefined
	private userSettings: UserSettingsData | undefined = undefined
	private currentOrganizationId: string | null = null
	private timer: RefreshTimer
	private log: (...args: unknown[]) => void
	private onAuthStateChanged?: (data: { state: AuthState; previousState: AuthState }) => Promise<void>
	private onUserInfo?: (data: { userInfo: CloudUserInfo }) => Promise<void>

	constructor(context: ExtensionContext, authService: AuthService, log?: (...args: unknown[]) => void) {
		super()

		this.context = context
		this.authService = authService
		this.log = log || console.log

		this.timer = new RefreshTimer({
			callback: async () => {
				return await this.fetchSettings()
			},
			successInterval: 3_600_000,
			initialBackoffMs: 1000,
			maxBackoffMs: 3_600_000,
		})
	}

	public async initialize(): Promise<void> {
		this.loadCachedSettings()

		// Clear cached settings if we have missed a log out.
		if (this.authService.getState() == "logged-out" && (this.settings || this.userSettings)) {
			await this.removeSettings()
		}

		this.detachAuthListeners()

		this.onAuthStateChanged = async (data: { state: AuthState; previousState: AuthState }) => {
			try {
				if (data.state === "active-session") {
					this.timer.start()
				} else if (data.previousState === "active-session") {
					this.timer.stop()

					if (data.state === "logged-out") {
						await this.removeSettings()
					}
				}
			} catch (error) {
				this.log(`[cloud-settings] error processing auth-state-changed: ${error}`, error)
			}
		}

		this.onUserInfo = async (data: { userInfo: CloudUserInfo }) => {
			try {
				const newOrgId = data.userInfo?.organizationId || null
				if (newOrgId !== this.currentOrganizationId) {
					this.currentOrganizationId = newOrgId
					this.settings = undefined
					await this.context.globalState.update(ORGANIZATION_SETTINGS_CACHE_KEY, undefined)
					await this.context.globalState.update(ORGANIZATION_ID_CACHE_KEY, newOrgId)
					this.emit("settings-updated", {} as Record<string, never>)
					if (this.authService.hasActiveSession()) {
						await this.fetchSettings()
					}
				}
			} catch (error) {
				this.log(`[cloud-settings] error processing user-info: ${error}`, error)
			}
		}

		this.authService.on("auth-state-changed", this.onAuthStateChanged)
		this.authService.on("user-info", this.onUserInfo)

		if (this.authService.hasActiveSession()) {
			this.timer.start()
		}
	}

	private async fetchSettings(): Promise<boolean> {
		const token = this.authService.getSessionToken()

		if (!token) {
			return false
		}

		const requestOrganizationId = this.currentOrganizationId
		const requestToken = token
		const isStale = () =>
			requestOrganizationId !== this.currentOrganizationId || requestToken !== this.authService.getSessionToken()

		try {
			const response = await fetch(`${getRooCodeApiUrl()}/api/extension-settings`, {
				headers: {
					Authorization: `Bearer ${token}`,
				},
			})

			if (!response.ok) {
				this.log("[cloud-settings] Failed to fetch extension settings:", response.status, response.statusText)
				return false
			}

			const data = await response.json()

			if (isStale()) {
				this.log("[cloud-settings] Discarding stale extension settings response")
				return false
			}

			const result = parseExtensionSettingsResponse(data)

			if (!result.success) {
				this.log("[cloud-settings] Invalid extension settings format:", result.error)
				return false
			}

			const { organization: newOrgSettings, user: newUserSettings } = result.data

			let orgChanged = false
			let userChanged = false

			// Check for organization settings changes
			if (!this.settings || this.settings.version !== newOrgSettings.version) {
				this.settings = newOrgSettings
				orgChanged = true
			}

			// Check for user settings changes
			if (!this.userSettings || this.userSettings.version !== newUserSettings.version) {
				this.userSettings = newUserSettings
				userChanged = true
			}

			// Emit a single event if either settings changed
			if (orgChanged || userChanged) {
				this.emit("settings-updated", {} as Record<string, never>)
			}

			const hasChanges = orgChanged || userChanged

			if (hasChanges) {
				await this.cacheSettings()
			}

			return true
		} catch (error) {
			this.log("[cloud-settings] Error fetching extension settings:", error)
			return false
		}
	}

	private async cacheSettings(): Promise<void> {
		// Store settings in separate globalState values
		if (this.settings) {
			await this.context.globalState.update(ORGANIZATION_SETTINGS_CACHE_KEY, this.settings)
			await this.context.globalState.update(ORGANIZATION_ID_CACHE_KEY, this.currentOrganizationId)
		}

		if (this.userSettings) {
			await this.context.globalState.update(USER_SETTINGS_CACHE_KEY, this.userSettings)
		}
	}

	private getCurrentOrganizationId(): string | null {
		return this.authService.getUserInfo?.()?.organizationId || this.authService.getStoredOrganizationId?.() || null
	}

	private loadCachedSettings(): void {
		this.settings = this.context.globalState.get<OrganizationSettings>(ORGANIZATION_SETTINGS_CACHE_KEY)
		this.userSettings = this.context.globalState.get<UserSettingsData>(USER_SETTINGS_CACHE_KEY)

		const cachedOrgId = this.context.globalState.get<string | null>(ORGANIZATION_ID_CACHE_KEY) ?? null
		const currentOrgId = this.getCurrentOrganizationId()
		this.currentOrganizationId = currentOrgId

		if (currentOrgId && cachedOrgId !== currentOrgId) {
			this.settings = undefined
		}
	}

	public getAllowList(): OrganizationAllowList {
		const currentOrgId = this.getCurrentOrganizationId()
		if (currentOrgId && (!this.settings || this.currentOrganizationId !== currentOrgId)) {
			return { allowAll: false, providers: {} }
		}
		return this.settings?.allowList || ORGANIZATION_ALLOW_ALL
	}

	public getSettings(): OrganizationSettings | undefined {
		const currentOrgId = this.getCurrentOrganizationId()
		if (currentOrgId && this.currentOrganizationId !== currentOrgId) {
			return undefined
		}
		return this.settings
	}

	public getUserSettings(): UserSettingsData | undefined {
		return this.userSettings
	}

	public getUserFeatures(): UserFeatures {
		return this.userSettings?.features || {}
	}

	public getUserSettingsConfig(): UserSettingsConfig {
		return this.userSettings?.settings || {}
	}

	public async updateUserSettings(settings: Partial<UserSettingsConfig>): Promise<boolean> {
		const token = this.authService.getSessionToken()

		if (!token) {
			this.log("[cloud-settings] No session token available for updating user settings")
			return false
		}

		try {
			const currentVersion = this.userSettings?.version
			const requestBody: {
				settings: Partial<UserSettingsConfig>
				version?: number
			} = {
				settings,
			}

			// Include current version for optimistic locking if we have cached settings
			if (currentVersion !== undefined) {
				requestBody.version = currentVersion
			}

			const response = await fetch(`${getRooCodeApiUrl()}/api/user-settings`, {
				method: "PATCH",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify(requestBody),
			})

			if (!response.ok) {
				if (response.status === 409) {
					this.log(
						"[cloud-settings] Version conflict when updating user settings - settings may have been updated elsewhere",
					)
				} else {
					this.log("[cloud-settings] Failed to update user settings:", response.status, response.statusText)
				}
				return false
			}

			const updatedUserSettings = await response.json()
			const result = userSettingsDataSchema.safeParse(updatedUserSettings)

			if (!result.success) {
				this.log("[cloud-settings] Invalid user settings response format:", result.error)
				return false
			}

			if (!this.userSettings || result.data.version > this.userSettings.version) {
				this.userSettings = result.data
				await this.cacheSettings()
				this.emit("settings-updated", {} as Record<string, never>)
			}

			return true
		} catch (error) {
			this.log("[cloud-settings] Error updating user settings:", error)
			return false
		}
	}

	public isTaskSyncEnabled(): boolean {
		// Org settings take precedence
		if (this.authService.getStoredOrganizationId()) {
			return this.settings?.cloudSettings?.recordTaskMessages ?? false
		}

		// User settings default to true if unspecified
		const userSettings = this.userSettings
		if (userSettings) {
			return userSettings.settings.taskSyncEnabled ?? true
		}

		return false
	}

	private async removeSettings(): Promise<void> {
		this.settings = undefined
		this.userSettings = undefined

		// Clear both cache keys
		await this.context.globalState.update(ORGANIZATION_SETTINGS_CACHE_KEY, undefined)
		await this.context.globalState.update(ORGANIZATION_ID_CACHE_KEY, undefined)
		await this.context.globalState.update(USER_SETTINGS_CACHE_KEY, undefined)
	}

	private detachAuthListeners(): void {
		if (this.onAuthStateChanged) {
			this.authService.off("auth-state-changed", this.onAuthStateChanged)
			this.onAuthStateChanged = undefined
		}
		if (this.onUserInfo) {
			this.authService.off("user-info", this.onUserInfo)
			this.onUserInfo = undefined
		}
	}

	public dispose(): void {
		this.detachAuthListeners()
		this.removeAllListeners()
		this.timer.stop()
	}
}
