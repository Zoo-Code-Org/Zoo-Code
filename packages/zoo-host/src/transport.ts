import { performance } from "node:perf_hooks"

import { hostEventSchema, type HostEvent } from "@roo-code/zoo-protocol"

export type SendIPC = (message: unknown) => Promise<void>
type OutboundHostEvent<T> = T extends HostEvent ? Omit<T, "v" | "seq" | "hostId"> : never

export class HostTransport {
	private sequence = 0
	private heartbeat: NodeJS.Timeout | undefined

	constructor(
		public readonly hostId: string,
		private readonly sendIPC: SendIPC,
	) {}

	public get lastSequence(): number {
		return this.sequence
	}

	public async send(event: OutboundHostEvent<HostEvent>): Promise<void> {
		const message = hostEventSchema.parse({ v: 1, seq: ++this.sequence, hostId: this.hostId, ...event })
		await this.sendIPC(message)
	}

	public startHeartbeat(intervalMs = 1_000): void {
		if (this.heartbeat) return
		this.heartbeat = setInterval(() => {
			void this.send({ type: "host.heartbeat", monotonicMs: performance.now() }).catch(() => this.stopHeartbeat())
		}, intervalMs)
		this.heartbeat.unref()
	}

	public stopHeartbeat(): void {
		if (this.heartbeat) clearInterval(this.heartbeat)
		this.heartbeat = undefined
	}
}
