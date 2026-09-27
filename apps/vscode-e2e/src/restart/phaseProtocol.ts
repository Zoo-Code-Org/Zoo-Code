import * as path from "path"
import * as fs from "fs/promises"

import { createWriteStream } from "fs"

export const PHASE_RESULT_VERSION = 1 as const

export type RestartPhase = "create" | "verify"
export type PhaseStatus = "passed" | "failed"

export type PhaseError = {
	message: string
	stack?: string
}

export type PhaseResult = {
	version: typeof PHASE_RESULT_VERSION
	phase: RestartPhase
	status: PhaseStatus
	values?: Record<string, string>
	error?: PhaseError
}

const phaseResultNames: Record<RestartPhase, string> = {
	create: "01-create.json",
	verify: "02-verify.json",
}

export function getPhaseResultPath(resultsDir: string, phase: RestartPhase): string {
	const resolvedResultsDir = path.resolve(resultsDir)
	const resultPath = path.resolve(resolvedResultsDir, phaseResultNames[phase])
	if (path.dirname(resultPath) !== resolvedResultsDir) {
		throw new Error(`Phase result path escaped the results directory: ${phase}`)
	}
	return resultPath
}

export function serializePhaseError(error: unknown): PhaseError {
	if (error instanceof Error) {
		return {
			message: error.message.slice(0, 2_000),
			...(error.stack && { stack: error.stack.slice(0, 4_000) }),
		}
	}

	return { message: String(error).slice(0, 2_000) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

export function validatePhaseResult(value: unknown): asserts value is PhaseResult {
	if (!isRecord(value) || value.version !== PHASE_RESULT_VERSION) {
		throw new Error("Invalid phase result version")
	}
	if (value.phase !== "create" && value.phase !== "verify") {
		throw new Error("Invalid phase result phase")
	}
	if (value.status !== "passed" && value.status !== "failed") {
		throw new Error("Invalid phase result status")
	}
	if (value.values !== undefined) {
		if (!isRecord(value.values) || Object.values(value.values).some((entry) => typeof entry !== "string")) {
			throw new Error("Phase result values must be string-valued")
		}
	}
	if (value.error !== undefined) {
		if (!isRecord(value.error) || typeof value.error.message !== "string") {
			throw new Error("Invalid phase result error")
		}
		if (value.error.stack !== undefined && typeof value.error.stack !== "string") {
			throw new Error("Invalid phase result error stack")
		}
	}
}

export async function writePhaseResult(resultsDir: string, result: PhaseResult): Promise<void> {
	validatePhaseResult(result)
	const targetPath = getPhaseResultPath(resultsDir, result.phase)
	const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
	try {
		await writeJsonAtomically(temporaryPath, result)
		await fs.rename(temporaryPath, targetPath)
	} finally {
		await fs.rm(temporaryPath, { force: true })
	}
}

async function writeJsonAtomically(filePath: string, value: PhaseResult): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await new Promise<void>((resolve, reject) => {
		const stream = createWriteStream(filePath, { encoding: "utf8" })
		stream.once("error", reject)
		stream.once("finish", resolve)
		stream.end(JSON.stringify(value))
	})
}

export async function readPhaseResult(resultsDir: string, phase: RestartPhase): Promise<PhaseResult> {
	const result = JSON.parse(await fs.readFile(getPhaseResultPath(resultsDir, phase), "utf8")) as unknown
	validatePhaseResult(result)
	if (result.phase !== phase) {
		throw new Error(`Phase result does not match requested phase: ${phase}`)
	}
	return result
}
