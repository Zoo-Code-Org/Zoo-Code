import type * as vscode from "vscode"
import { createZooServer, type ZooClient, type ZooServerHandle } from "@zoo-code/sdk"

import { usePortableCore } from "../../utils/config"

/** Activation-time owner for the SDK-backed portable core process and client. */
export class PortableCoreService implements vscode.Disposable {
	readonly client: ZooClient
	readonly ipcPath: string
	readonly reused: boolean

	#abortController: AbortController
	#handle: ZooServerHandle
	#outputChannel: vscode.OutputChannel
	#disposed = false

	private constructor(input: {
		client: ZooClient
		handle: ZooServerHandle
		abortController: AbortController
		outputChannel: vscode.OutputChannel
	}) {
		this.client = input.client
		this.ipcPath = input.handle.ipcPath
		this.reused = input.handle.reused
		this.#handle = input.handle
		this.#abortController = input.abortController
		this.#outputChannel = input.outputChannel
	}

	/** Initialize the portable core only when `zoo-code.usePortableCore` is enabled. */
	static async create(
		_context: vscode.ExtensionContext,
		outputChannel: vscode.OutputChannel,
	): Promise<PortableCoreService | undefined> {
		if (!usePortableCore()) {
			return undefined
		}

		const abortController = new AbortController()

		try {
			const handle = await createZooServer({ signal: abortController.signal })
			const client = await handle.connect()
			outputChannel.appendLine(
				`[PortableCore] ${handle.reused ? "Reused" : "Started"} Zoo CLI server at ${handle.ipcPath}`,
			)
			return new PortableCoreService({ client, handle, abortController, outputChannel })
		} catch (error) {
			abortController.abort()
			outputChannel.appendLine(
				`[PortableCore] Initialization failed; continuing with legacy extension-host runtime: ${error instanceof Error ? error.message : String(error)}`,
			)
			return undefined
		}
	}

	/** Stop SDK client resources and the spawned CLI server, if this process owns it. */
	async dispose(): Promise<void> {
		if (this.#disposed) {
			return
		}

		this.#disposed = true
		this.#abortController.abort()

		try {
			await this.client.close()
		} catch (error) {
			this.#outputChannel.appendLine(
				`[PortableCore] Failed to close Zoo SDK client: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		try {
			await this.#handle.close()
		} catch (error) {
			this.#outputChannel.appendLine(
				`[PortableCore] Failed to stop Zoo CLI server: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
}
