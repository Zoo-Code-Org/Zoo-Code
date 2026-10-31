import { EventEmitter } from "node:events"
import net from "node:net"

import {
	IpcMessageType,
	IpcOrigin,
	ipcMessageSchema,
	type Ack,
	type IpcMessage,
	type TaskCommand,
} from "@roo-code/types"

// The extension side frames IPC messages with node-ipc: a js-message envelope
// terminated by a form feed. The launcher has to match that framing byte for
// byte, so this client owns it instead of depending on @roo-code/ipc, whose
// client half has no other consumer.
const DELIMITER = "\f"

const RETRY_MS = 500

// Defensive ceiling on pre-delimiter accumulation, enforced in UTF-8 bytes of
// the pending frame rather than UTF-16 code units, so the wire size a peer can
// force the client to hold is bounded regardless of the character mix. A
// legitimate task event is orders of magnitude smaller than this, and the
// node-ipc client this replaces had no ceiling at all, so the bound is pure
// hardening: it cannot truncate a real frame in practice.
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

const envelope = (data: unknown): string => JSON.stringify({ type: "message", data }) + DELIMITER

// node-ipc rewrites non-pipe socket paths on Windows before listening, so a
// client must apply the same rewrite to reach the socket the server created.
export const resolveSocketPath = (socketPath: string): string => {
	if (process.platform !== "win32" || socketPath.startsWith("\\\\.\\pipe\\")) return socketPath
	return `\\\\.\\pipe\\${socketPath.replace(/^\//, "").replace(/\//g, "-")}`
}

export interface EvalIpcClientEvents {
	[IpcMessageType.Connect]: []
	[IpcMessageType.Disconnect]: []
	[IpcMessageType.Ack]: [data: Ack]
	[IpcMessageType.TaskEvent]: [data: unknown]
}

export interface EvalIpcClientOptions {
	// Test seam only; production always uses MAX_FRAME_BYTES.
	maxFrameBytes?: number
}

export class EvalIpcClient extends EventEmitter<EvalIpcClientEvents> {
	private readonly _socketPath: string
	private readonly _log: (...args: unknown[]) => void
	private readonly _maxFrameBytes: number
	private _socket?: net.Socket
	private _buffer = ""
	// UTF-8 size of _buffer, maintained incrementally so the ceiling check stays
	// O(chunk) instead of re-measuring the whole pending frame on every event.
	private _bufferBytes = 0
	private _retry?: NodeJS.Timeout
	private _isConnected = false
	private _clientId?: string
	private _closed = false

	constructor(
		socketPath: string,
		log: (...args: unknown[]) => void = console.log,
		options: EvalIpcClientOptions = {},
	) {
		super()

		this._socketPath = socketPath
		this._log = log
		this._maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES

		this.connect()
	}

	// The launcher connects immediately after spawning the host, before the
	// extension has created the socket, so a refused connection is expected and
	// must be retried until the host comes up.
	private connect() {
		if (this._closed) return

		const socket = (this._socket = net.connect(resolveSocketPath(this._socketPath)))
		socket.setEncoding("utf8")
		socket.on("connect", () => this.onConnect())
		socket.on("close", () => this.onClose())
		socket.on("error", (error) => this.log(`[client#error] ${error.message}`))
		socket.on("data", (chunk: string) => this.onData(chunk))
	}

	private onConnect() {
		if (this._isConnected) return

		this._isConnected = true
		this.emit(IpcMessageType.Connect)
	}

	private onClose() {
		// A close before the first connect is a refused attempt, not a lost
		// session; only a connected client reports a disconnect.
		if (this._isConnected) {
			this._isConnected = false
			this.emit(IpcMessageType.Disconnect)
		}

		// The rest of a partial frame can never arrive on a new socket, so
		// keeping it would corrupt the first frame of the next session.
		this._buffer = ""
		this._bufferBytes = 0

		if (this._closed) return

		this._retry = setTimeout(() => this.connect(), RETRY_MS)
		this._retry.unref?.()
	}

	private onData(chunk: string) {
		// A frame is complete only once the delimiter arrives; a partial frame
		// stays buffered so large task events are never truncated. Each chunk is
		// scanned once and only its trailing partial segment is measured, so the
		// byte accounting stays O(chunk) even on a delimiter-free flood.
		let offset = 0
		let index: number

		while ((index = chunk.indexOf(DELIMITER, offset)) !== -1) {
			const segment = chunk.slice(offset, index)
			const frameBytes = this._bufferBytes + Buffer.byteLength(segment, "utf8")

			// A delimiter in the same chunk as the overrun must not buy the frame a
			// pass: the ceiling applies to the assembled frame, not just the tail.
			// Returning (not breaking) stops the scan, so the closed connection
			// cannot re-populate the buffer and log a second time.
			if (frameBytes > this._maxFrameBytes) {
				this.onOversizedFrame()
				return
			}

			const frame = this._buffer + segment
			this._buffer = ""
			this._bufferBytes = 0
			if (frame.length > 0) this.onFrame(frame)
			offset = index + DELIMITER.length
		}

		const tail = chunk.slice(offset)

		if (tail.length > 0) {
			this._buffer += tail
			this._bufferBytes += Buffer.byteLength(tail, "utf8")
		}

		if (this._bufferBytes > this._maxFrameBytes) this.onOversizedFrame()
	}

	// Bounded log line only: the pending bytes may carry credentials, so neither
	// their content nor their exact size is written out.
	private onOversizedFrame() {
		this._buffer = ""
		this._bufferBytes = 0
		this._closed = true

		if (this._retry) {
			clearTimeout(this._retry)
			this._retry = undefined
		}

		this.log("[client#onData] frame exceeded MAX_FRAME_BYTES, dropping connection")

		this._socket?.destroy()
	}

	private onFrame(frame: string) {
		let parsed: unknown

		try {
			parsed = JSON.parse(frame)
		} catch {
			this.log("[client#onFrame] unparseable frame")
			return
		}

		const result = ipcMessageSchema.safeParse((parsed as { data?: unknown } | null)?.data)

		if (!result.success) {
			// Payload values may carry credentials, so only the count is logged.
			this.log("[client#onFrame] invalid payload", { issueCount: result.error.issues.length })
			return
		}

		const message = result.data

		if (message.origin !== IpcOrigin.Server) return

		switch (message.type) {
			case IpcMessageType.Ack:
				this._clientId = message.data.clientId
				this.emit(IpcMessageType.Ack, message.data)
				break
			case IpcMessageType.TaskEvent:
				this.emit(IpcMessageType.TaskEvent, message.data)
				break
		}
	}

	private log(...args: unknown[]) {
		this._log(...args)
	}

	public sendCommand(command: TaskCommand) {
		if (this._clientId === undefined) {
			this.log("[client#sendCommand] no client id yet")
			return
		}

		this.sendMessage({
			type: IpcMessageType.TaskCommand,
			origin: IpcOrigin.Client,
			clientId: this._clientId,
			data: command,
		})
	}

	public sendMessage(message: IpcMessage) {
		if (this._closed || !this._socket || this._socket.destroyed) return
		this._socket.write(envelope(message))
	}

	public disconnect() {
		this._closed = true

		if (this._retry) {
			clearTimeout(this._retry)
			this._retry = undefined
		}

		try {
			this._socket?.end()
			this._socket?.destroy()
		} catch (error) {
			this.log(`[client#disconnect] ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	public get socketPath() {
		return this._socketPath
	}

	public get clientId() {
		return this._clientId
	}

	public get isConnected() {
		return this._isConnected
	}

	public get isReady() {
		return this._isConnected && this._clientId !== undefined
	}
}
