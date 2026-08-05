import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"

import {
	hostHelloSchema,
	parentHelloSchema,
	validateParentHello,
	ZOO_HOST_PROTOCOL_VERSION,
} from "@roo-code/zoo-protocol"

import { activateExtensionHost } from "./bootstrap.js"
import { HostCommandDispatcher } from "./dispatcher.js"
import { validateHostRoots, type HostRoots } from "./roots.js"
import { createSystemVaultBackend, VaultSecretStorage } from "./security.js"
import { HostTransport } from "./transport.js"

type ChildConfig = HostRoots & { hostId?: string; buildVersion: string }

function sendProcessMessage(message: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.send || !process.connected) return reject(new Error("Zoo host IPC channel is unavailable"))
		process.send(message, (error) => (error ? reject(error) : resolve()))
	})
}

export async function runChild(config: ChildConfig): Promise<void> {
	if (!process.send) throw new Error("zoo-host must be started with a Node IPC channel")
	const roots = validateHostRoots({
		extensionRoot: config.extensionRoot,
		workspaceRoot: config.workspaceRoot,
		storageRoot: config.storageRoot,
		appRoot: config.appRoot,
	})
	const hostId = config.hostId ?? randomUUID()
	const hello = hostHelloSchema.parse({
		type: "hello",
		hostId,
		supportedVersions: [ZOO_HOST_PROTOCOL_VERSION],
		capabilities: {
			[ZOO_HOST_PROTOCOL_VERSION]: [
				"task:start",
				"task:resume",
				"task:input",
				"task:cancel",
				"ask:respond",
				"history:list",
				"host:snapshot",
				"host:shutdown",
				"checkpoint:unavailable",
			],
		},
		buildVersion: config.buildVersion,
	})
	await sendProcessMessage(hello)

	const selection = await new Promise<ReturnType<typeof parentHelloSchema.parse>>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Host negotiation timed out")), 10_000)
		process.once("message", (message) => {
			clearTimeout(timeout)
			try {
				resolve(parentHelloSchema.parse(message))
			} catch (error) {
				reject(error)
			}
		})
	})
	const negotiation = validateParentHello(hello, selection)
	if (!negotiation.ok) throw new Error(negotiation.message)

	const secretStorage = new VaultSecretStorage(createSystemVaultBackend())
	const extension = await activateExtensionHost(roots, secretStorage)
	const transport = new HostTransport(hostId, sendProcessMessage)
	const dispatcher = new HostCommandDispatcher(extension.api, transport, roots.workspaceRoot)
	transport.startHeartbeat()
	process.on("message", (message) => {
		void dispatcher.dispatch(message).catch(async (error) => {
			await transport.send({
				type: "command.error",
				commandId: "invalid",
				error: {
					code: "invalid_usage",
					kind: "configuration",
					phase: undefined,
					message: error instanceof Error ? error.message : String(error),
				},
			})
		})
	})
	process.once("disconnect", () => {
		transport.stopHeartbeat()
		void extension.dispose()
	})
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const config = JSON.parse(process.env.ZOO_HOST_CONFIG ?? "null") as ChildConfig | null
	if (!config) throw new Error("ZOO_HOST_CONFIG is required")
	void runChild(config).catch((error) => {
		process.stderr.write(`zoo-host failed: ${error instanceof Error ? error.message : String(error)}\n`)
		process.exitCode = 70
	})
}
