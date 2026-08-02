import type { RooTerminalCallbacks, RooTerminalProcessResultPromise } from "./types"
import { BaseTerminal, buildReuseExternalChecks } from "./BaseTerminal"
import { ExecaTerminalProcess } from "./ExecaTerminalProcess"
import { mergePromise } from "./mergePromise"
import type { ShellInvocationPlan } from "./shell/types"

export class ExecaTerminal extends BaseTerminal {
	/** The shell invocation plan for this terminal. Set before runCommand. */
	private shellPlan?: ShellInvocationPlan

	constructor(id: number, cwd: string, reuseKey: string = "execa") {
		super("execa", id, cwd, reuseKey)
	}

	/**
	 * Unlike the VSCode terminal, this is never closed.
	 */
	public override isClosed(): boolean {
		return false
	}

	/**
	 * Execa reuse predicate. Execa terminals are reusable when idle, unowned,
	 * not closed, and have matching CWD/reuse key. Health is not required.
	 */
	public override canReuse(options: {
		cwd: string
		reuseKey: string
		hasProcess: boolean
		shellIntegrationDefined?: boolean
		hasStaleActiveShellExecution?: boolean
	}): boolean {
		return this.lifecycle.canReuse(
			buildReuseExternalChecks(this, {
				cwd: options.cwd,
				reuseKey: options.reuseKey,
				hasProcess: options.hasProcess,
				isClosed: this.isClosed(),
			}),
		)
	}

	/**
	 * Sets the shell invocation plan for this terminal. Must be called
	 * before {@link runCommand} to use the new plan-based execution.
	 * If not set, falls back to the legacy `shell: true` path.
	 */
	public setShellInvocationPlan(plan: ShellInvocationPlan): void {
		this.shellPlan = plan
	}

	/**
	 * Gets the shell invocation plan, if set.
	 */
	public getShellInvocationPlan(): ShellInvocationPlan | undefined {
		return this.shellPlan
	}

	public override runCommand(
		command: string,
		callbacks: RooTerminalCallbacks,
		executionId?: string,
	): RooTerminalProcessResultPromise {
		const effectiveExecutionId = executionId ?? `legacy-${this.id}-${Date.now()}`

		if (this.lifecycle.ownerExecutionId === undefined) {
			this.lifecycle.acquireOwner(effectiveExecutionId)
		}

		if (this.lifecycle.state === "idle") {
			this.lifecycle.transition("fallback-ready", effectiveExecutionId)
		}

		this.lifecycle.markCommandSubmitted(effectiveExecutionId)

		const process = new ExecaTerminalProcess(this)
		process.command = command
		process.executionId = effectiveExecutionId
		this.process = process

		process.on("line", (line) => callbacks.onLine(line, process))
		process.once("completed", (output) => callbacks.onCompleted(output, process))
		process.once("shell_execution_started", (pid) => callbacks.onShellExecutionStarted(pid, process))
		process.once("shell_execution_complete", (details) => callbacks.onShellExecutionComplete(details, process))

		const plan = this.shellPlan

		const promise = new Promise<void>((resolve, reject) => {
			process.once("continue", () => resolve())
			process.once("error", (error) => reject(error))
			process.run(command, plan)
		})

		return mergePromise(process, promise)
	}
}
