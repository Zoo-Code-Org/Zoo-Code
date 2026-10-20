import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it, vi } from "vitest"
import { parse } from "yaml"

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const workflow = parse(
	fs.readFileSync(
		path.join(repositoryRoot, ".github/workflows/label-pr-review-state-fork-review-followup.yml"),
		"utf8",
	),
)
const dispatchScript = workflow.jobs.dispatch.steps[0].with.script as string

const SHA = "a".repeat(40)
const OLD_SHA = "b".repeat(40)

interface HarnessOptions {
	workflowRunEvent?: string
	fork?: boolean
	associatedPrNumbers?: number[]
	fallback?: "match" | "sha-mismatch" | "base-mismatch" | "none"
	headRepository?: null
	headSha?: string
	failDispatchFor?: number
}

function buildForkPr() {
	return {
		number: 1437,
		state: "open",
		head: { sha: SHA, repo: { full_name: "contributor/Zoo-Code" } },
		base: { ref: "main", repo: { full_name: "Zoo-Code-Org/Zoo-Code" } },
	}
}

/** Executes the embedded github-script follow-up against deterministic GitHub API doubles. */
async function runFollowup(options: HarnessOptions = {}) {
	const fork = options.fork ?? true
	const pr = buildForkPr()
	const listPullRequests = vi.fn(async ({ state }: { state?: string }) => {
		if (state !== "open") return []
		if (options.fallback === "match") return [pr]
		if (options.fallback === "sha-mismatch") return [{ ...pr, head: { ...pr.head, sha: OLD_SHA } }]
		if (options.fallback === "base-mismatch") {
			return [{ ...pr, base: { ...pr.base, repo: { full_name: "someone-else/Zoo-Code" } } }]
		}
		return []
	})
	const createWorkflowDispatch = vi.fn(async ({ inputs }: { inputs: { pull_request_number: string } }) => {
		if (Number(inputs.pull_request_number) === options.failDispatchFor) throw new Error("dispatch rejected")
		return { status: 204 }
	})
	const github = {
		paginate: vi.fn(async (target: unknown, args: unknown) => {
			if (typeof target !== "function") throw new Error("Unexpected paginate target")
			return target(args)
		}),
		rest: {
			pulls: { list: listPullRequests },
			actions: { createWorkflowDispatch },
		},
	}
	const context = {
		eventName: "workflow_run",
		repo: { owner: "Zoo-Code-Org", repo: "Zoo-Code" },
		payload: {
			workflow_run: {
				id: 987654,
				event: options.workflowRunEvent ?? "pull_request_review",
				pull_requests: (options.associatedPrNumbers ?? []).map((number) => ({ number })),
				head_repository:
					options.headRepository === null
						? null
						: {
								owner: { login: fork ? "contributor" : "Zoo-Code-Org" },
								fork,
							},
				head_branch: "feature/test",
				head_sha: options.headSha ?? SHA,
			},
		},
	}
	const core = {
		info: vi.fn(),
		debug: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
		setFailed: vi.fn(),
	}

	await new AsyncFunction("github", "context", "core", dispatchScript)(github, context, core)

	return { listPullRequests, createWorkflowDispatch, info: core.info, setFailed: core.setFailed }
}

describe("fork review follow-up workflow (#2046, #2086)", () => {
	it("listens to the label workflow without listing itself", () => {
		expect(workflow.name).toBe("Label PR review state fork review follow-up")
		expect(workflow.on.workflow_run.workflows).toEqual(["Label PR review state"])
		expect(workflow.on.workflow_run.workflows).not.toContain(workflow.name)
		expect(String(workflow.jobs.dispatch.if).trim()).toBe(
			"github.event.workflow_run.event == 'pull_request_review'",
		)
	})

	it("dispatches an input and workflow that the label workflow declares", () => {
		const label = parse(
			fs.readFileSync(path.join(repositoryRoot, ".github/workflows/label-pr-review-state.yml"), "utf8"),
		)
		const call = /createWorkflowDispatch\(\{[\s\S]*?workflow_id: '([^']+)'[\s\S]*?inputs: \{ (\w+):/.exec(
			dispatchScript,
		)

		expect(call?.[1]).toBe("label-pr-review-state.yml")
		expect(Object.keys(label.on.workflow_dispatch.inputs)).toContain(call?.[2])
		expect(workflow.on.workflow_run.workflows).toEqual([label.name])
	})

	it("dispatches a privileged reconciliation for the fork PR a read-only review run targeted", async () => {
		// Fork runs backfill pull_requests empty, so the follow-up resolves the
		// PR by exact head owner, branch, and SHA.
		const result = await runFollowup({ associatedPrNumbers: [], fallback: "match" })

		expect(result.listPullRequests).toHaveBeenCalledWith(
			expect.objectContaining({ head: "contributor:feature/test", state: "open" }),
		)
		expect(result.createWorkflowDispatch).toHaveBeenCalledTimes(1)
		expect(result.createWorkflowDispatch).toHaveBeenCalledWith({
			owner: "Zoo-Code-Org",
			repo: "Zoo-Code",
			workflow_id: "label-pr-review-state.yml",
			ref: "main",
			inputs: { pull_request_number: "1437" },
		})
		expect(result.setFailed).not.toHaveBeenCalled()
	})

	it("dispatches directly for runs whose pull_requests are populated", async () => {
		const result = await runFollowup({ associatedPrNumbers: [1437] })

		expect(result.listPullRequests).not.toHaveBeenCalled()
		expect(result.createWorkflowDispatch).toHaveBeenCalledTimes(1)
	})

	it("dispatches every PR a run targets and reports a failed dispatch without skipping the rest", async () => {
		const both = await runFollowup({ associatedPrNumbers: [1, 2] })

		expect(both.createWorkflowDispatch).toHaveBeenCalledTimes(2)
		expect(both.setFailed).not.toHaveBeenCalled()

		const partial = await runFollowup({ associatedPrNumbers: [1, 2], failDispatchFor: 1 })

		expect(partial.createWorkflowDispatch).toHaveBeenCalledTimes(2)
		expect(partial.setFailed).toHaveBeenCalledWith(expect.stringContaining("#1: dispatch rejected"))
	})

	it("ignores a completed run that was not triggered by pull_request_review", async () => {
		// The runs this workflow dispatches complete with event
		// 'workflow_dispatch'; filtering them out stops the chain after one hop.
		for (const workflowRunEvent of ["schedule", "push", "workflow_dispatch", "pull_request_target"]) {
			const result = await runFollowup({ workflowRunEvent, fallback: "match" })

			expect(result.listPullRequests).not.toHaveBeenCalled()
			expect(result.createWorkflowDispatch).not.toHaveBeenCalled()
		}
	})

	it("ignores a same-repository review run, which already wrote its labels", async () => {
		const result = await runFollowup({ fork: false, associatedPrNumbers: [1437] })

		expect(result.listPullRequests).not.toHaveBeenCalled()
		expect(result.createWorkflowDispatch).not.toHaveBeenCalled()
	})

	it("dispatches nothing when no open PR matches the run's exact head", async () => {
		const result = await runFollowup({ fallback: "sha-mismatch" })

		expect(result.listPullRequests).toHaveBeenCalledTimes(1)
		expect(result.createWorkflowDispatch).not.toHaveBeenCalled()
	})

	it("dispatches nothing when the matching PR targets another base repository", async () => {
		const result = await runFollowup({ fallback: "base-mismatch" })

		expect(result.listPullRequests).toHaveBeenCalledTimes(1)
		expect(result.createWorkflowDispatch).not.toHaveBeenCalled()
	})

	it("dispatches nothing when the run has no head repository or head SHA to resolve", async () => {
		for (const options of [{ headRepository: null }, { headSha: "" }] as const) {
			const result = await runFollowup({ ...options, fallback: "match" })

			expect(result.listPullRequests).not.toHaveBeenCalled()
			expect(result.createWorkflowDispatch).not.toHaveBeenCalled()
		}
	})
})
