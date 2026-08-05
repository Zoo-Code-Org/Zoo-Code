import fs from "node:fs"
import path from "node:path"

import { runOverridesSchema, type RunOverrides } from "@roo-code/zoo-protocol"

export type OutputFormat = "text" | "json" | "stream-json"

export type SharedOptions = {
	cwd: string
	provider?: string
	profile?: string
	model?: string
	mode?: string
	reasoningEffort?: RunOverrides["reasoningEffort"]
	approval?: RunOverrides["approval"]
	ephemeral?: boolean
	timeout?: string
	debug?: boolean
}

export function resolveWorkspace(input: string): string {
	const resolved = fs.realpathSync(path.resolve(input))
	if (!fs.statSync(resolved).isDirectory()) throw new Error(`Workspace is not a directory: ${input}`)
	return resolved
}

export function parseDuration(value: string | undefined): number | undefined {
	if (value === undefined) return undefined
	const match = /^(\d+)(ms|s|m|h)$/.exec(value)
	if (!match) throw new Error(`Invalid duration: ${value}`)
	const amount = Number(match[1])
	const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"]
	const duration = amount * multiplier
	if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error(`Invalid duration: ${value}`)
	return duration
}

export function runOverrides(
	options: Pick<SharedOptions, "provider" | "profile" | "model" | "mode" | "reasoningEffort" | "approval">,
): RunOverrides | undefined {
	const parsed = runOverridesSchema.parse({
		provider: options.provider,
		profile: options.profile,
		model: options.model,
		mode: options.mode,
		reasoningEffort: options.reasoningEffort,
		approval: options.approval,
	})
	return Object.values(parsed).some((value) => value !== undefined) ? parsed : undefined
}
