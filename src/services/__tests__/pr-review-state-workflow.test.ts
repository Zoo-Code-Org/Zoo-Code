import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it, vi } from "vitest"
import { parse } from "yaml"

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const workflow = parse(
	fs.readFileSync(path.join(repositoryRoot, ".github/workflows/label-pr-review-state.yml"), "utf8"),
)
const workflowScript = workflow.jobs.reconcile.steps[0].with.script as string

const SHA = "a".repeat(40)
const OLD_SHA = "b".repeat(40)
const REVIEWED_AT = Date.parse("2026-08-29T15:02:00Z")

type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"

interface HarnessOptions {
	prState?: "open" | "closed"
	draft?: boolean
	conflict?: boolean
	fork?: boolean
	eventName?: string
	workflowRunAssociated?: boolean
	existingGuide?: boolean
	existingGuideHead?: string
	existingGuidePendingHead?: string
	labels?: string[]
	prAuthor?: { login: string; type: "Bot" | "User" }
	addLabelsStatus?: number
	labelLookupStatus?: number
	removeLabelStatus?: number
	reviews?: Array<{
		login: string
		type: "Bot" | "User"
		state: ReviewState
		submittedAt: number
		commitId?: string
	}>
	permissions?: Record<string, string>
	permissionErrorStatus?: number
	requiredContexts?: string[]
	requiredIntegrationId?: number | null
	requiredRunAppId?: number
	requiredStatus?: "queued" | "in_progress" | "completed"
	requiredConclusion?: "success" | "failure"
	omitRequiredRuns?: boolean
	commitStatuses?: Array<{ context: string; state: "pending" | "success" | "failure" | "error"; id?: number }>
	includeFailedCodecov?: boolean
	branchRulesFail?: boolean
}

/** Executes the embedded github-script workflow against deterministic GitHub API doubles. */
async function runWorkflow(options: HarnessOptions = {}) {
	const headRepository = options.fork ? "contributor/Zoo-Code" : "Zoo-Code-Org/Zoo-Code"
	const pr = {
		number: 1437,
		state: options.prState ?? "open",
		draft: options.draft ?? false,
		html_url: "https://github.com/Zoo-Code-Org/Zoo-Code/pull/1437",
		user: options.prAuthor ?? { login: "zoomote[bot]", type: "Bot" },
		head: { sha: SHA, repo: { full_name: headRepository } },
		base: { ref: "main", repo: { full_name: "Zoo-Code-Org/Zoo-Code" } },
		labels: (options.labels ?? []).map((name) => ({ name })),
		mergeable: options.conflict ? false : true,
		mergeable_state: options.conflict ? "dirty" : "clean",
	}
	const requiredContexts = options.requiredContexts ?? ["tests"]
	const requiredRuns = (options.omitRequiredRuns ? [] : requiredContexts)
		.filter((name) => name !== "reconcile")
		.map((name, index) => ({
			id: index + 1,
			name,
			status: options.requiredStatus ?? "completed",
			conclusion:
				(options.requiredStatus ?? "completed") === "completed"
					? (options.requiredConclusion ?? "success")
					: null,
			started_at: "2026-08-29T15:00:00Z",
			completed_at: (options.requiredStatus ?? "completed") === "completed" ? "2026-08-29T15:01:00Z" : null,
			app: { id: options.requiredRunAppId ?? 15368, slug: "github-actions" },
		}))
	const checkRuns = options.includeFailedCodecov
		? [
				...requiredRuns,
				{
					id: 100,
					name: "codecov/patch",
					status: "completed",
					conclusion: "failure",
					started_at: "2026-08-29T15:00:00Z",
					completed_at: "2026-08-29T15:01:00Z",
					app: { id: 254, slug: "codecov" },
				},
			]
		: requiredRuns
	const reviews = (options.reviews ?? []).map((review, index) => ({
		id: index + 1,
		state: review.state,
		commit_id: review.commitId ?? SHA,
		submitted_at: new Date(review.submittedAt).toISOString(),
		user: { login: review.login, type: review.type },
	}))
	const existingComments =
		options.existingGuide || options.existingGuideHead || options.existingGuidePendingHead
			? [
					{
						id: 10,
						user: { login: "github-actions[bot]" },
						body:
							"<!-- zoo-code-pr-review-process -->\n**Current step:** Waiting" +
							(options.existingGuideHead
								? `\n<!-- coderabbit-review-label:${options.existingGuideHead} -->`
								: options.existingGuidePendingHead
									? `\n<!-- coderabbit-review-label:${options.existingGuidePendingHead}:pending -->`
									: ""),
					},
				]
			: []

	const addLabels = vi.fn(async (_args: unknown) => {
		if (options.addLabelsStatus) {
			throw Object.assign(new Error("Add labels failed"), { status: options.addLabelsStatus })
		}
	})
	const removeLabel = vi.fn(async (_args: unknown) => {
		if (options.removeLabelStatus) {
			throw Object.assign(new Error("Remove label failed"), { status: options.removeLabelStatus })
		}
	})
	const createComment = vi.fn(async (args: { body: string }) => ({
		data: { id: 11, user: { login: "github-actions[bot]" }, body: args.body },
	}))
	const updateComment = vi.fn(async (_args: unknown) => undefined)
	const createCommitStatus = vi.fn(async (_args: unknown) => undefined)
	const createLabel = vi.fn(async (_args: unknown) => undefined)
	const setFailed = vi.fn()
	const permissionFor = vi.fn(async ({ username }: { username: string }) => {
		if (options.permissionErrorStatus) {
			throw Object.assign(new Error("Permission lookup failed"), { status: options.permissionErrorStatus })
		}
		const permission = options.permissions?.[username]
		if (!permission) throw Object.assign(new Error("Not Found"), { status: 404 })
		return { data: { permission } }
	})

	const github = {
		paginate: vi.fn(async (target: unknown, args: unknown) => {
			if (typeof target === "string") {
				if (options.branchRulesFail) throw new Error("rules unavailable")
				return [
					{
						type: "required_status_checks",
						parameters: {
							required_status_checks: requiredContexts.map((context) => ({
								context,
								integration_id:
									options.requiredIntegrationId === undefined ? 15368 : options.requiredIntegrationId,
							})),
						},
					},
				]
			}
			if (typeof target !== "function") throw new Error("Unexpected paginate target")
			return target(args)
		}),
		rest: {
			pulls: {
				get: vi.fn(async () => ({ data: pr })),
				list: vi.fn(async () => [pr]),
				listReviews: vi.fn(async () => reviews),
			},
			issues: {
				getLabel: vi.fn(async () => {
					if (options.labelLookupStatus) {
						throw Object.assign(new Error("Label lookup failed"), { status: options.labelLookupStatus })
					}
					return { data: {} }
				}),
				createLabel,
				removeLabel,
				addLabels,
				listComments: vi.fn(async () => existingComments),
				createComment,
				updateComment,
			},
			checks: {
				listForRef: vi.fn(async () => checkRuns),
			},
			repos: {
				createCommitStatus,
				listCommitStatusesForRef: vi.fn(async () =>
					(options.commitStatuses ?? []).map((status, index) => ({
						id: status.id ?? index + 1,
						context: status.context,
						state: status.state,
						created_at: "2026-08-29T15:00:00Z",
						updated_at: "2026-08-29T15:01:00Z",
					})),
				),
				getCollaboratorPermissionLevel: permissionFor,
			},
		},
	}
	const eventName = options.eventName ?? "pull_request_target"
	const pullRequestPayload = {
		number: 1437,
		head: { repo: { full_name: headRepository } },
		base: { repo: { full_name: "Zoo-Code-Org/Zoo-Code" } },
	}
	const payload =
		eventName === "schedule"
			? {}
			: eventName === "workflow_run"
				? {
						workflow_run: {
							pull_requests: options.workflowRunAssociated === false ? [] : [{ number: 1437 }],
						},
					}
				: {
						action: "ready_for_review",
						pull_request: pullRequestPayload,
					}
	const context = {
		eventName,
		repo: { owner: "Zoo-Code-Org", repo: "Zoo-Code" },
		payload,
	}
	const core = {
		info: vi.fn(),
		debug: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
		setFailed,
	}

	await new AsyncFunction("github", "context", "core", workflowScript)(github, context, core)

	return {
		addLabels,
		removeLabel,
		createComment,
		updateComment,
		createCommitStatus,
		createLabel,
		setFailed,
		listPullRequests: github.rest.pulls.list,
		listCommitStatusesForRef: github.rest.repos.listCommitStatusesForRef,
	}
}

/** Returns the most recently created or updated managed guidance comment body. */
function latestGuide(result: Awaited<ReturnType<typeof runWorkflow>>) {
	const created = result.createComment.mock.calls.at(-1)?.[0] as { body?: string } | undefined
	const updated = result.updateComment.mock.calls.at(-1)?.[0] as { body?: string } | undefined
	return updated?.body ?? created?.body ?? ""
}

/** Returns the latest advisory gate commit-status payload. */
function latestGateStatus(result: Awaited<ReturnType<typeof runWorkflow>>) {
	return result.createCommitStatus.mock.calls.at(-1)?.[0] as
		| { state?: string; description?: string; context?: string; sha?: string }
		| undefined
}

describe("PR review-state workflow", () => {
	it("ignores events for closed pull requests", async () => {
		const result = await runWorkflow({ prState: "closed" })

		expect(result.addLabels).not.toHaveBeenCalled()
		expect(result.removeLabel).not.toHaveBeenCalled()
		expect(result.createComment).not.toHaveBeenCalled()
		expect(result.updateComment).not.toHaveBeenCalled()
		expect(result.createCommitStatus).not.toHaveBeenCalled()
		expect(result.setFailed).not.toHaveBeenCalled()
	})

	it("keeps fork review events read-only", async () => {
		const result = await runWorkflow({ eventName: "pull_request_review", fork: true })

		expect(result.addLabels).not.toHaveBeenCalled()
		expect(result.removeLabel).not.toHaveBeenCalled()
		expect(result.createComment).not.toHaveBeenCalled()
		expect(result.updateComment).not.toHaveBeenCalled()
		expect(result.createCommitStatus).not.toHaveBeenCalled()
		expect(result.setFailed).not.toHaveBeenCalled()
	})

	it("creates missing workflow labels", async () => {
		const result = await runWorkflow({ labelLookupStatus: 404 })

		expect(result.createLabel).toHaveBeenCalledTimes(4)
	})

	it("propagates non-404 label lookup failures", async () => {
		await expect(runWorkflow({ labelLookupStatus: 500 })).rejects.toThrow("Label lookup failed")
	})

	it("does not start automatic review for drafts", async () => {
		const result = await runWorkflow({ draft: true })

		expect(result.addLabels).not.toHaveBeenCalled()
		expect(latestGuide(result)).toContain("Mark the PR ready")
	})

	it("removes the CodeRabbit label while required CI is pending", async () => {
		const result = await runWorkflow({
			labels: ["coderabbit-review-active"],
			requiredStatus: "in_progress",
		})

		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "coderabbit-review-active" }))
		expect(latestGateStatus(result)?.description).toContain("required CI checks")
	})

	it("does not start CodeRabbit when required CI fails", async () => {
		const result = await runWorkflow({ requiredConclusion: "failure" })

		expect(result.addLabels).not.toHaveBeenCalled()
		expect(latestGateStatus(result)?.description).toContain("Fix the failing required CI checks")
	})

	it("starts CodeRabbit automatically after required CI passes", async () => {
		const result = await runWorkflow()

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-coderabbit"] }))
		expect(latestGuide(result)).toContain(`coderabbit-review-label:${SHA}`)
	})

	it("invalidates the gate before fallible metadata updates", async () => {
		const result = await runWorkflow({ addLabelsStatus: 500 })

		expect(result.setFailed).toHaveBeenCalled()
		expect(latestGateStatus(result)?.state).toBe("failure")
		expect(result.createCommitStatus.mock.invocationCallOrder[0]).toBeLessThan(
			result.addLabels.mock.invocationCallOrder[0],
		)
		expect(result.createComment.mock.invocationCallOrder[0]).toBeLessThan(
			result.addLabels.mock.invocationCallOrder[0],
		)
	})

	it("recycles a CodeRabbit label left over from an older head", async () => {
		const result = await runWorkflow({
			labels: ["coderabbit-review-active"],
			existingGuideHead: OLD_SHA,
		})

		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "coderabbit-review-active" }))
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("retries a CodeRabbit label recycle left in the pending state", async () => {
		const result = await runWorkflow({
			labels: ["coderabbit-review-active"],
			existingGuidePendingHead: SHA,
		})

		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "coderabbit-review-active" }))
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
		expect(latestGuide(result)).toContain(`coderabbit-review-label:${SHA} -->`)
		expect(latestGuide(result)).not.toContain(":pending")
	})

	it("tolerates an already-removed CodeRabbit label while recycling", async () => {
		const result = await runWorkflow({
			labels: ["coderabbit-review-active"],
			existingGuideHead: OLD_SHA,
			removeLabelStatus: 404,
		})

		expect(result.setFailed).not.toHaveBeenCalled()
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("keeps a CodeRabbit label already bound to the current head", async () => {
		const result = await runWorkflow({
			labels: ["coderabbit-review-active"],
			existingGuideHead: SHA,
		})

		expect(result.removeLabel).not.toHaveBeenCalled()
		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
	})

	it("ignores a failed optional Codecov check", async () => {
		const result = await runWorkflow({ includeFailedCodecov: true })

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("uses a legacy commit status for an unpinned required context", async () => {
		const result = await runWorkflow({
			requiredIntegrationId: null,
			omitRequiredRuns: true,
			commitStatuses: [{ context: "tests", state: "success" }],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("uses only the latest legacy status for a required context", async () => {
		const result = await runWorkflow({
			requiredIntegrationId: null,
			omitRequiredRuns: true,
			commitStatuses: [
				{ id: 1, context: "tests", state: "failure" },
				{ id: 2, context: "tests", state: "success" },
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("does not use a legacy status for an integration-pinned check", async () => {
		const result = await runWorkflow({
			requiredRunAppId: 999,
			commitStatuses: [{ context: "tests", state: "success" }],
		})

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(result.listCommitStatusesForRef).not.toHaveBeenCalled()
		expect(latestGateStatus(result)?.description).toContain("required CI checks")
	})

	it("keeps the gate pending when a required check has not reported", async () => {
		const result = await runWorkflow({ omitRequiredRuns: true })

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(latestGateStatus(result)?.description).toContain("required CI checks")
	})

	it("removes CodeRabbit activation when the PR has conflicts", async () => {
		const result = await runWorkflow({
			conflict: true,
			labels: ["coderabbit-review-active"],
		})

		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "coderabbit-review-active" }))
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["has-conflicts"] }))
	})

	it("routes CodeRabbit change requests back to the author", async () => {
		const result = await runWorkflow({
			labels: ["coderabbit-review-active"],
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "CHANGES_REQUESTED",
					submittedAt: REVIEWED_AT,
				},
			],
		})

		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "coderabbit-review-active" }))
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
	})

	it("moves approved ready PRs to maintainer review", async () => {
		const result = await runWorkflow({
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
	})

	it("recognizes CodeRabbit regardless of login casing", async () => {
		const result = await runWorkflow({
			reviews: [
				{
					login: "CodeRabbitAI[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
	})

	it("preserves CodeRabbit approval after a later comment", async () => {
		const result = await runWorkflow({
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "COMMENTED",
					submittedAt: REVIEWED_AT + 1_000,
				},
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
	})

	it("invalidates a dismissed CodeRabbit approval", async () => {
		const result = await runWorkflow({
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "DISMISSED",
					submittedAt: REVIEWED_AT + 1_000,
				},
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-coderabbit"] }))
	})

	it("preserves manual draft approvals until the PR is ready", async () => {
		const result = await runWorkflow({
			draft: true,
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-ready"] }))
	})

	it("treats non-collaborator reviews as non-maintainer input", async () => {
		const result = await runWorkflow({
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
				{
					login: "drive-by-reviewer",
					type: "User",
					state: "APPROVED",
					submittedAt: REVIEWED_AT + 1_000,
				},
			],
		})

		expect(result.setFailed).not.toHaveBeenCalled()
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
	})

	it("does not count the PR author's own approval", async () => {
		const result = await runWorkflow({
			prAuthor: { login: "author", type: "User" },
			permissions: { author: "write" },
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
				{
					login: "Author",
					type: "User",
					state: "APPROVED",
					submittedAt: REVIEWED_AT + 1_000,
				},
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
		expect(latestGateStatus(result)?.state).toBe("failure")
	})

	it("keeps awaiting-author when any maintainer requests changes", async () => {
		const result = await runWorkflow({
			permissions: { reviewer: "write", approver: "maintain" },
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
				{
					login: "reviewer",
					type: "User",
					state: "CHANGES_REQUESTED",
					submittedAt: REVIEWED_AT + 1_000,
				},
				{
					login: "approver",
					type: "User",
					state: "APPROVED",
					submittedAt: REVIEWED_AT + 2_000,
				},
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
		expect(latestGateStatus(result)?.state).toBe("failure")
	})

	it("keeps draft PRs awaiting the author when a maintainer requests changes", async () => {
		const result = await runWorkflow({
			draft: true,
			permissions: { maintainer: "write" },
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
				{
					login: "maintainer",
					type: "User",
					state: "CHANGES_REQUESTED",
					submittedAt: REVIEWED_AT + 1_000,
				},
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
	})

	it("passes only after a later non-author maintainer approval", async () => {
		const result = await runWorkflow({
			permissions: { maintainer: "write" },
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
				{
					login: "maintainer",
					type: "User",
					state: "APPROVED",
					submittedAt: REVIEWED_AT + 1_000,
				},
			],
		})

		expect(latestGateStatus(result)?.state).toBe("success")
	})

	it("uses review order when approvals share the same timestamp", async () => {
		const result = await runWorkflow({
			permissions: { maintainer: "write" },
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
				{
					login: "maintainer",
					type: "User",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
			],
		})

		expect(latestGateStatus(result)?.state).toBe("success")
	})

	it("publishes the review gate as a standalone commit status", async () => {
		const result = await runWorkflow()

		expect(latestGateStatus(result)).toEqual(
			expect.objectContaining({ context: "PR review gate", sha: SHA, state: "failure" }),
		)
	})

	it("reports non-404 permission lookup failures", async () => {
		const result = await runWorkflow({
			permissionErrorStatus: 500,
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
				{
					login: "maintainer",
					type: "User",
					state: "APPROVED",
					submittedAt: REVIEWED_AT + 1_000,
				},
			],
		})

		expect(result.setFailed).toHaveBeenCalled()
	})

	it("excludes the reconciliation job from required checks", async () => {
		const result = await runWorkflow({ requiredContexts: ["tests", "reconcile"] })

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("fails closed when branch rules are unavailable", async () => {
		const result = await runWorkflow({ branchRulesFail: true })

		expect(result.addLabels).not.toHaveBeenCalled()
		expect(latestGateStatus(result)?.description).toContain("required CI checks")
	})

	it("lists open PRs during scheduled reconciliation", async () => {
		const result = await runWorkflow({ eventName: "schedule" })

		expect(result.listPullRequests).toHaveBeenCalled()
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("reconciles the PR associated with a workflow run", async () => {
		const result = await runWorkflow({ eventName: "workflow_run" })

		expect(result.listPullRequests).not.toHaveBeenCalled()
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("ignores closed PRs associated with workflow runs", async () => {
		const result = await runWorkflow({ eventName: "workflow_run", prState: "closed" })

		expect(result.createCommitStatus).not.toHaveBeenCalled()
		expect(result.addLabels).not.toHaveBeenCalled()
	})

	it("does not list every PR when a workflow run has no associated PR", async () => {
		const result = await runWorkflow({ eventName: "workflow_run", workflowRunAssociated: false })

		expect(result.listPullRequests).not.toHaveBeenCalled()
		expect(result.createCommitStatus).not.toHaveBeenCalled()
	})

	it("ignores CodeRabbit reviews from an older head", async () => {
		const result = await runWorkflow({
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
					commitId: OLD_SHA,
				},
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})
})
