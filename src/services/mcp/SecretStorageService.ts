import * as vscode from "vscode"
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"

export interface StoredMcpOAuthData {
	tokens: OAuthTokens
	/** Unix ms timestamp after which the access token should be considered expired. */
	expires_at: number
	/**
	 * Issuer of the authorization server that issued these tokens. Refresh is
	 * allowed only against the same issuer. Missing on data saved by older versions.
	 */
	issuer?: string
	/**
	 * RFC 8707 resource used during authorization and token requests. This keeps
	 * refresh requests consistent after the extension restarts.
	 */
	resource_indicator?: string
	/**
	 * Full DCR response from the auth server, persisted so that fields like
	 * client_secret, grant_types, and token_endpoint_auth_method survive restarts.
	 * Note: redirect_uris within this object may be stale (port changes between
	 * sessions); callers must override redirect_uris with the current value.
	 */
	client_info?: OAuthClientInformationFull
}

/**
 * Thin wrapper around VS Code SecretStorage for persisting MCP OAuth tokens.
 * Tokens are stored per server path and optional static client ID. Dynamic
 * registrations keep the legacy per-server key for backward compatibility.
 */
export class SecretStorageService {
	private readonly _storage: vscode.SecretStorage
	private readonly _namespace = "mcp.oauth."

	constructor(context: vscode.ExtensionContext) {
		this._storage = context.secrets
	}

	private _key(serverUrl: string, clientId?: string): string {
		const url = new URL(serverUrl)
		const normalizedPath = url.pathname.replace(/\/$/, "")
		const encodedPath = Buffer.from(normalizedPath).toString("base64url")

		if (clientId) {
			const encodedClientId = Buffer.from(clientId).toString("base64url")
			const encodedResource = Buffer.from(`${normalizedPath}${url.search}`).toString("base64url")
			return `${this._namespace}${url.protocol}//${url.host}.p-${encodedResource}.c-${encodedClientId}.data`
		}

		// Dynamic registrations keep the legacy key for backward compatibility.
		const pathSuffix = normalizedPath ? `.${encodedPath}` : ""
		return `${this._namespace}${url.host}${pathSuffix}.data`
	}

	async getOAuthData(serverUrl: string, clientId?: string): Promise<StoredMcpOAuthData | undefined> {
		const raw = await this._storage.get(this._key(serverUrl, clientId))
		if (!raw) return undefined
		try {
			return JSON.parse(raw) as StoredMcpOAuthData
		} catch {
			return undefined
		}
	}

	async saveOAuthData(serverUrl: string, data: StoredMcpOAuthData, clientId?: string): Promise<void> {
		await this._storage.store(this._key(serverUrl, clientId), JSON.stringify(data))
	}

	async hasOAuthData(serverUrl: string, clientId?: string): Promise<boolean> {
		const raw = await this._storage.get(this._key(serverUrl, clientId))
		return raw !== undefined
	}

	async deleteOAuthData(serverUrl: string, clientId?: string): Promise<void> {
		await this._storage.delete(this._key(serverUrl, clientId))
	}

	/**
	 * Subscribe to changes for a specific server URL's OAuth data.
	 * The callback fires (in all VS Code windows) immediately when another
	 * window writes or deletes the token for this server.
	 *
	 * @returns A dispose function — call it to stop listening.
	 */
	onDidChange(serverUrl: string, callback: () => void, clientId?: string): () => void {
		const key = this._key(serverUrl, clientId)
		const disposable = this._storage.onDidChange((e) => {
			if (e.key === key) {
				callback()
			}
		})
		return () => disposable.dispose()
	}
}
