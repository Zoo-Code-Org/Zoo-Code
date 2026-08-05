import { execFile as execFileCallback, spawn } from "node:child_process"
import { promisify } from "node:util"

import type { SecretStorage, SecretStorageChangeEvent } from "@roo-code/vscode-shim"

const execFile = promisify(execFileCallback)

export interface VaultBackend {
	get(account: string): Promise<string | undefined>
	store(account: string, value: string): Promise<void>
	delete(account: string): Promise<void>
}

async function spawnWithInput(command: string, args: string[], input: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk))
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
		child.once("error", reject)
		child.once("close", (code) =>
			code === 0 ? resolve(stdout) : reject(new Error(`${command} failed (${code}): ${stderr.trim()}`)),
		)
		child.stdin.end(input)
	})
}

export function createSystemVaultBackend(service = "Zoo Code CLI", platform = process.platform): VaultBackend {
	if (platform === "darwin") {
		return {
			async get(account) {
				try {
					const { stdout } = await execFile("security", [
						"find-generic-password",
						"-s",
						service,
						"-a",
						account,
						"-w",
					])
					return stdout.trimEnd()
				} catch (error) {
					if ((error as NodeJS.ErrnoException & { code?: number }).code === 44) return undefined
					throw error
				}
			},
			async store(account, value) {
				await spawnWithInput("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w"], `${value}\n`)
			},
			async delete(account) {
				try {
					await execFile("security", ["delete-generic-password", "-s", service, "-a", account])
				} catch (error) {
					if ((error as NodeJS.ErrnoException & { code?: number }).code !== 44) throw error
				}
			},
		}
	}
	if (platform === "linux") {
		return {
			async get(account) {
				try {
					const { stdout } = await execFile("secret-tool", ["lookup", "service", service, "account", account])
					return stdout.trimEnd() || undefined
				} catch {
					return undefined
				}
			},
			async store(account, value) {
				await spawnWithInput(
					"secret-tool",
					["store", `--label=${service}`, "service", service, "account", account],
					value,
				)
			},
			async delete(account) {
				await execFile("secret-tool", ["clear", "service", service, "account", account])
			},
		}
	}
	throw new Error(`Persisted Zoo CLI credentials are unsupported on ${platform}`)
}

export class VaultSecretStorage implements SecretStorage {
	private readonly listeners = new Set<(event: SecretStorageChangeEvent) => unknown>()

	constructor(private readonly backend: VaultBackend) {}

	public readonly onDidChange = (listener: (event: SecretStorageChangeEvent) => unknown) => {
		this.listeners.add(listener)
		return { dispose: () => this.listeners.delete(listener) }
	}

	public get(key: string): Promise<string | undefined> {
		return this.backend.get(key)
	}

	public async store(key: string, value: string): Promise<void> {
		await this.backend.store(key, value)
		this.fire(key)
	}

	public async delete(key: string): Promise<void> {
		await this.backend.delete(key)
		this.fire(key)
	}

	private fire(key: string): void {
		for (const listener of this.listeners) listener({ key })
	}
}
