import { spawn } from "child_process"
import * as path from "path"

import { readPhaseResult, type RestartPhase, type PhaseResult } from "./phaseProtocol"
import type { ScenarioWorkspace } from "./scenarioWorkspace"

export type RestartCoordinatorOptions = {
	vscodeExecutablePath: string
	extensionDevelopmentPath: string
	extensionTestsPath: string
	scenario: string
	workspace: ScenarioWorkspace
	environment: NodeJS.ProcessEnv
	expectedExitPolicies: readonly ExpectedExitPolicy[]
}

export type ExpectedExitPolicy = {
	phase: RestartPhase
	termination: "graceful-quit"
	code: number
	signal: NodeJS.Signals | null
}

function phaseEnvironment(options: RestartCoordinatorOptions, phase: RestartPhase): NodeJS.ProcessEnv {
	return {
		...options.environment,
		E2E_PHASE: phase,
		E2E_SCENARIO: options.scenario,
		E2E_RESULTS_DIR: options.workspace.results,
	}
}

function phaseArguments(options: RestartCoordinatorOptions): string[] {
	return [
		options.workspace.workspace,
		`--user-data-dir=${options.workspace.userData}`,
		`--extensions-dir=${options.workspace.extensions}`,
		// A headless runner has no keyring. Without a password store the safeStorage
		// backend keeps context.secrets in memory, so a restart phase cannot see the
		// profiles the create phase saved.
		"--password-store=basic",
		"--no-sandbox",
		"--disable-gpu-sandbox",
		"--disable-updates",
		"--skip-welcome",
		"--skip-release-notes",
		"--disable-workspace-trust",
		`--extensionTestsPath=${options.extensionTestsPath}`,
		`--extensionDevelopmentPath=${options.extensionDevelopmentPath}`,
	]
}

function isEnvironmentSkip(result: PhaseResult): boolean {
	return result.status === "failed" && result.error?.message.startsWith("ENVIRONMENT_SKIP:") === true
}

async function runPhase(options: RestartCoordinatorOptions, phase: RestartPhase): Promise<PhaseResult> {
	const args = phaseArguments(options)
	console.log(`[restart:${phase}] spawning VS Code: ${path.basename(options.vscodeExecutablePath)}`)

	const child = spawn(options.vscodeExecutablePath, args, {
		env: phaseEnvironment(options, phase),
		shell: process.platform === "win32",
		stdio: ["ignore", "pipe", "pipe"],
	})

	child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[restart:${phase}] ${chunk}`))
	child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[restart:${phase}] ${chunk}`))

	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject)
		child.once("close", (code, signal) => resolve({ code, signal }))
	})

	const result = await readPhaseResult(options.workspace.results, phase)

	if (isEnvironmentSkip(result)) {
		// The scenario proves nothing where VS Code secret storage cannot persist at all.
		// Report the limitation loudly but keep the run green; a keyring environment runs
		// the real restart assertion.
		console.warn(
			`[restart:${phase}] environment skip: ${result.error?.message.slice("ENVIRONMENT_SKIP:".length).trim()}`,
		)
		return result
	}

	if (result.status !== "passed") {
		throw new Error(`[restart:${phase}] phase result was not passed: ${result.error?.message ?? "unknown failure"}`)
	}

	const expectedExit = options.expectedExitPolicies.find((policy) => policy.phase === phase)
	const isExpectedNonzeroExit =
		exit.code !== 0 &&
		expectedExit !== undefined &&
		expectedExit.termination === "graceful-quit" &&
		exit.code === expectedExit.code &&
		exit.signal === expectedExit.signal
	const isSuccessfulExit = exit.code === 0 && exit.signal === null
	if (!isSuccessfulExit && !isExpectedNonzeroExit) {
		throw new Error(`[restart:${phase}] VS Code exited with ${exit.code ?? exit.signal}`)
	}

	return result
}

export async function runRestartScenario(options: RestartCoordinatorOptions): Promise<void> {
	await runPhase(options, "create")
	await runPhase(options, "verify")
}
