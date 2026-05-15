import type { MessageChunk, Session, SessionCreateOptions, SessionListOptions, ZooClient } from "@zoo-code/sdk"

export type PortableSessionSendOptions = {
	mode?: string
	model?: string
	parts?: unknown[]
}

/** Thin VS Code-side adapter over the SDK session API. */
export class PortableSessionAdapter {
	constructor(private readonly client: ZooClient) {}

	/** Create a portable-core session through the Zoo SDK. */
	createSession(options: SessionCreateOptions = {}): Promise<Session> {
		return this.client.createSession(options)
	}

	/** List portable-core sessions, optionally scoped to a workspace directory. */
	listSessions(options: SessionListOptions = {}): Promise<Session[]> {
		return this.client.listSessions(options)
	}

	/** Fetch a portable-core session snapshot. */
	getSession(sessionID: string): Promise<Session> {
		return this.client.getSession(sessionID)
	}

	/** Send a message to the portable core and stream response chunks. */
	sendMessage(
		sessionID: string,
		message: string,
		options: PortableSessionSendOptions = {},
	): AsyncIterableIterator<MessageChunk> {
		return this.client.sendMessage(sessionID, message, options)
	}

	/** Abort a portable-core session. */
	abortSession(sessionID: string): Promise<void> {
		return this.client.abortSession(sessionID)
	}
}
