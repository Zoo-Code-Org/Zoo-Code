import type {
	MessageChunk,
	Mode,
	ConfigProvidersResult,
	PermissionReply,
	Session,
	SessionCreateOptions,
	SessionListOptions,
	ZooClient,
	ZooConfig,
	ZooServerEvent,
} from "@zoo-code/sdk"

export type PortableSessionSendOptions = {
	mode?: string
	model?: string
	parts?: unknown[]
}

/** Thin VS Code-side adapter over the SDK session API. */
export class PortableSessionAdapter {
	constructor(private readonly client: ZooClient) {}

	/** Create a portable-core session through the Zoo SDK. */
	async createSession(options: SessionCreateOptions = {}): Promise<Session> {
		return validateSession(await this.client.createSession(options), "createSession")
	}

	/** List portable-core sessions, optionally scoped to a workspace directory. */
	async listSessions(options: SessionListOptions = {}): Promise<Session[]> {
		const sessions = await this.client.listSessions(options)
		if (!Array.isArray(sessions)) {
			throw new Error("Portable core listSessions returned an invalid session list")
		}
		return sessions.map((session, index) => validateSession(session, `listSessions[${index}]`))
	}

	/** Fetch a portable-core session snapshot. */
	async getSession(sessionID: string): Promise<Session> {
		return validateSession(await this.client.getSession(sessionID), "getSession")
	}

	/** Send a message to the portable core and stream response chunks. */
	sendMessage(
		sessionID: string,
		message: string,
		options: PortableSessionSendOptions = {},
	): AsyncIterableIterator<MessageChunk> {
		return validateMessageChunks(this.client.sendMessage(sessionID, message, options))
	}

	/** Abort a portable-core session. */
	abortSession(sessionID: string): Promise<void> {
		return this.client.abortSession(sessionID)
	}

	/** Subscribe to portable-core server events, including tool approval requests. */
	subscribeEvents(): AsyncIterableIterator<ZooServerEvent> {
		return this.client.subscribeEvents()
	}

	/** Reply to a pending portable-core permission request. */
	replyPermission(requestID: string, reply: PermissionReply): Promise<void> {
		return this.client.replyPermission(requestID, reply)
	}

	/** List portable-core modes/agents available for message routing. */
	listModes(): Promise<Mode[]> {
		return this.client.listModes().then(validateModeList)
	}

	/** Read the portable-core configuration snapshot. */
	getConfig(): Promise<ZooConfig> {
		return this.client.getConfig()
	}

	/** Read configured providers/defaults from the portable core. */
	getConfigProviders(): Promise<ConfigProvidersResult> {
		return this.client.getConfigProviders().then(validateConfigProvidersResult)
	}
}

function validateSession(value: unknown, source: string): Session {
	if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") {
		throw new Error(`Portable core ${source} returned a session without a string id`)
	}

	return value as Session
}

async function* validateMessageChunks(
	chunks: AsyncIterableIterator<MessageChunk>,
): AsyncIterableIterator<MessageChunk> {
	for await (const chunk of chunks) {
		if (!chunk || typeof chunk !== "object" || typeof (chunk as { type?: unknown }).type !== "string") {
			throw new Error("Portable core sendMessage returned a chunk without a string type")
		}

		yield chunk
	}
}

function validateModeList(value: unknown): Mode[] {
	if (!Array.isArray(value)) {
		throw new Error("Portable core listModes returned an invalid mode list")
	}

	return value.map((mode, index) => {
		if (!mode || typeof mode !== "object" || typeof (mode as { id?: unknown }).id !== "string") {
			throw new Error(`Portable core listModes[${index}] returned a mode without a string id`)
		}

		if (typeof (mode as { name?: unknown }).name !== "string") {
			throw new Error(`Portable core listModes[${index}] returned a mode without a string name`)
		}

		return mode as Mode
	})
}

function validateConfigProvidersResult(value: unknown): ConfigProvidersResult {
	if (!value || typeof value !== "object") {
		throw new Error("Portable core getConfigProviders returned an invalid provider config result")
	}

	const result = value as ConfigProvidersResult
	if (result.default !== undefined && (!result.default || typeof result.default !== "object")) {
		throw new Error("Portable core getConfigProviders returned an invalid default provider config")
	}

	if (result.providers === undefined) {
		return result
	}

	const providers = Array.isArray(result.providers) ? result.providers : Object.values(result.providers)
	providers.forEach((provider, index) => {
		if (!provider || typeof provider !== "object" || typeof (provider as { id?: unknown }).id !== "string") {
			throw new Error(
				`Portable core getConfigProviders.providers[${index}] returned a provider without a string id`,
			)
		}
	})

	return result
}
