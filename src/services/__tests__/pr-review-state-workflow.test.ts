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
const WORKFLOW_RUN_URL = "https://github.com/Zoo-Code-Org/Zoo-Code/actions/runs/123456"

type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"

interface HarnessOptions {
	prState?: "open" | "closed"
	draft?: boolean
	conflict?: boolean
	mergeable?: boolean | null
	mergeableState?: string
	fork?: boolean
	eventName?: string
	workflowRunAssociated?: boolean
	workflowDispatchPrNumber?: number
	existingGuide?: boolean
	existingGuideHead?: string
	existingGuidePendingHead?: string
	labels?: string[]
	prAuthor?: { login: string; type: "Bot" | "User" }
	addLabelsStatus?: number
	addLabelsFailOnceName?: string
	labelLookupStatus?: number
	createLabelStatus?: number
	listCommentsErrorStatus?: number
	createCommentErrorStatus?: number
	updateCommentErrorStatus?: number
	removeLabelStatus?: number
	removeLabelFailOnceName?: string
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
	gateStatuses?: Array<{
		context: string
		state: "pending" | "success" | "failure" | "error"
		description: string
		targetUrl: string
		id?: number
	}>
	gateStatusLookupErrorStatus?: number
	createCommitStatusErrorStatus?: number
	includeFailedCodecov?: boolean
	additionalCheckRuns?: Array<{
		id: number
		name: string
		status: "queued" | "in_progress" | "completed"
		conclusion: "success" | "failure" | null
		appId: number
	}>
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
		user: options.prAuthor ?? { login: "contributor", type: "User" },
		head: { sha: SHA, repo: { full_name: headRepository } },
		base: { ref: "main", repo: { full_name: "Zoo-Code-Org/Zoo-Code" } },
		labels: (options.labels ?? []).map((name) => ({ name })),
		mergeable: options.mergeable !== undefined ? options.mergeable : options.conflict ? false : true,
		mergeable_state: options.mergeableState ?? (options.conflict ? "dirty" : "clean"),
	}
	const requiredContexts = options.requiredContexts ?? ["tests"]
	const requiredRuns = (options.omitRequiredRuns ? [] : requiredContexts)
		.filter((name) => name !== "Zoo Code / reconcile PR review state")
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
	const checkRuns = [
		...requiredRuns,
		...(options.additionalCheckRuns ?? []).map((run) => ({
			id: run.id,
			name: run.name,
			status: run.status,
			conclusion: run.conclusion,
			started_at: "2026-08-29T14:00:00Z",
			completed_at: run.status === "completed" ? "2026-08-29T14:01:00Z" : null,
			app: { id: run.appId, slug: "test-app" },
		})),
		...(options.includeFailedCodecov
			? [
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
			: []),
	]
	const reviews = (options.reviews ?? []).map((review, index) => ({
		id: index + 1,
		state: review.state,
		commit_id: review.commitId ?? SHA,
		submitted_at: new Date(review.submittedAt).toISOString(),
		user: { login: review.login, type: review.type },
	}))
	const existingComments = [
		...(options.existingGuide || options.existingGuideHead || options.existingGuidePendingHead
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
			: []),
	]
	const remoteLabels = new Set(pr.labels.map((label) => label.name))

	let addLabelsFailedOnce = false
	const addLabels = vi.fn(async (args: { labels: string[] }) => {
		if (
			options.addLabelsFailOnceName &&
			args.labels.includes(options.addLabelsFailOnceName) &&
			!addLabelsFailedOnce
		) {
			addLabelsFailedOnce = true
			throw Object.assign(new Error("Add label failed once"), { status: 500 })
		}
		if (options.addLabelsStatus) {
			throw Object.assign(new Error("Add labels failed"), { status: options.addLabelsStatus })
		}
		for (const label of args.labels) remoteLabels.add(label)
	})
	let removeLabelFailedOnce = false
	const removeLabel = vi.fn(async (args: { name: string }) => {
		if (options.removeLabelFailOnceName === args.name && !removeLabelFailedOnce) {
			removeLabelFailedOnce = true
			throw Object.assign(new Error("Remove label failed once"), { status: 500 })
		}
		if (options.removeLabelStatus) {
			throw Object.assign(new Error("Remove label failed"), { status: options.removeLabelStatus })
		}
		remoteLabels.delete(args.name)
	})
	const createComment = vi.fn(async (args: { body: string }) => {
		if (options.createCommentErrorStatus) {
			throw Object.assign(new Error("Create comment failed"), { status: options.createCommentErrorStatus })
		}
		return { data: { id: 11, user: { login: "github-actions[bot]" }, body: args.body } }
	})
	const updateComment = vi.fn(async (args: { comment_id: number; body: string }) => {
		if (options.updateCommentErrorStatus) {
			throw Object.assign(new Error("Update comment failed"), { status: options.updateCommentErrorStatus })
		}
		return { data: { id: args.comment_id, user: { login: "github-actions[bot]" }, body: args.body } }
	})
	const listComments = vi.fn(async () => {
		if (options.listCommentsErrorStatus) {
			throw Object.assign(new Error("List comments failed"), { status: options.listCommentsErrorStatus })
		}
		return existingComments
	})
	const createCommitStatus = vi.fn(
		async (args: { sha: string; state: string; context: string; description: string; target_url: string }) => {
			if (options.createCommitStatusErrorStatus) {
				throw Object.assign(new Error("Commit status failed"), {
					status: options.createCommitStatusErrorStatus,
				})
			}
			return { data: args }
		},
	)
	const createLabel = vi.fn(async (_args: unknown) => {
		if (options.createLabelStatus) {
			throw Object.assign(new Error("Create label failed"), { status: options.createLabelStatus })
		}
	})
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
				get: vi.fn(async () => ({ data: { labels: [...remoteLabels].map((name) => ({ name })) } })),
				getLabel: vi.fn(async () => {
					if (options.labelLookupStatus) {
						throw Object.assign(new Error("Label lookup failed"), { status: options.labelLookupStatus })
					}
					return { data: {} }
				}),
				createLabel,
				removeLabel,
				addLabels,
				listComments,
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
				getCombinedStatusForRef: vi.fn(async () => {
					if (options.gateStatusLookupErrorStatus) {
						throw Object.assign(new Error("Gate status lookup failed"), {
							status: options.gateStatusLookupErrorStatus,
						})
					}
					return {
						data: {
							statuses: (options.gateStatuses ?? []).map((status, index) => ({
								id: status.id ?? index + 1,
								context: status.context,
								state: status.state,
								description: status.description,
								target_url: status.targetUrl,
							})),
						},
					}
				}),
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
			: eventName === "workflow_dispatch"
				? { inputs: { pull_request_number: String(options.workflowDispatchPrNumber ?? 1437) } }
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
		runId: 123456,
		serverUrl: "https://github.com",
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
		listComments,
		createCommitStatus,
		createLabel,
		setFailed,
		warning: core.warning,
		listPullRequests: github.rest.pulls.list,
		listCommitStatusesForRef: github.rest.repos.listCommitStatusesForRef,
	}
}

/** Returns the most recently created or updated managed guidance comment body. */
function latestGuide(result: Awaited<ReturnType<typeof runWorkflow>>) {
	const created = result.createComment.mock.calls.at(-1)?.[0]
	const updated = result.updateComment.mock.calls.at(-1)?.[0]
	return updated?.body ?? created?.body ?? ""
}

/** Returns the latest advisory gate commit-status payload. */
function latestGateStatus(result: Awaited<ReturnType<typeof runWorkflow>>) {
	return result.createCommitStatus.mock.calls.at(-1)?.[0]
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

	it("reconciles same-repository review events", async () => {
		const result = await runWorkflow({ eventName: "pull_request_review" })

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
		expect(result.createCommitStatus).toHaveBeenCalled()
	})

	it("reconciles fork PRs from pull_request_target", async () => {
		const result = await runWorkflow({ eventName: "pull_request_target", fork: true })

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
		expect(result.createCommitStatus).toHaveBeenCalled()
		expect(result.setFailed).not.toHaveBeenCalled()
	})

	it("creates missing workflow labels", async () => {
		const result = await runWorkflow({ labelLookupStatus: 404 })

		expect(result.createLabel).toHaveBeenCalledTimes(4)
	})

	it("fails closed when a managed label cannot be created", async () => {
		await expect(runWorkflow({ labelLookupStatus: 404, createLabelStatus: 500 })).rejects.toThrow(
			"Create label failed",
		)
	})

	it("propagates non-404 label lookup failures", async () => {
		await expect(runWorkflow({ labelLookupStatus: 500 })).rejects.toThrow("Label lookup failed")
	})

	it("does not start automatic review for drafts", async () => {
		const result = await runWorkflow({ draft: true })

		expect(result.addLabels).not.toHaveBeenCalled()
		expect(latestGuide(result)).toContain("Mark the PR ready")
	})

	it("routes bot-authored PRs directly to maintainer review", async () => {
		const result = await runWorkflow({
			prAuthor: { login: "zoomote[bot]", type: "Bot" },
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(latestGateStatus(result)?.state).toBe("success")
		expect(latestGateStatus(result)?.description).toContain("Ready for human maintainer")
	})

	it("completes bot-authored PR review after human maintainer approval", async () => {
		const result = await runWorkflow({
			prAuthor: { login: "zoomote[bot]", type: "Bot" },
			permissions: { maintainer: "write" },
			reviews: [
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

	it("honors manually requested CodeRabbit changes on bot-authored PRs", async () => {
		const result = await runWorkflow({
			prAuthor: { login: "zoomote[bot]", type: "Bot" },
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "CHANGES_REQUESTED",
					submittedAt: REVIEWED_AT,
				},
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
		expect(latestGateStatus(result)?.state).toBe("pending")
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
		expect(latestGateStatus(result)?.state).toBe("pending")
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

	it.each(["awaiting-ready", "awaiting-maintainer"])("removes stale %s state", async (staleLabel) => {
		const result = await runWorkflow({ labels: [staleLabel] })

		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: staleLabel }))
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-coderabbit"] }))
	})

	it("removes stale awaiting-coderabbit after CodeRabbit approval", async () => {
		const result = await runWorkflow({
			labels: ["awaiting-coderabbit"],
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
			],
		})

		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-coderabbit" }))
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
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

	it("recovers a recycled CodeRabbit activation label after one failed add", async () => {
		const result = await runWorkflow({
			labels: ["coderabbit-review-active"],
			existingGuideHead: OLD_SHA,
			addLabelsFailOnceName: "coderabbit-review-active",
		})

		expect(
			result.addLabels.mock.calls.filter(([args]) => args.labels.includes("coderabbit-review-active")),
		).toHaveLength(2)
		expect(result.setFailed).not.toHaveBeenCalled()
		expect(latestGuide(result)).toContain(`coderabbit-review-label:${SHA} -->`)
		expect(latestGuide(result)).not.toContain(":pending")
	})

	it("fails closed when a recycled CodeRabbit activation label cannot be restored", async () => {
		const result = await runWorkflow({
			labels: ["coderabbit-review-active"],
			existingGuideHead: OLD_SHA,
			addLabelsStatus: 500,
		})

		expect(
			result.addLabels.mock.calls.filter(([args]) => args.labels.includes("coderabbit-review-active")),
		).toHaveLength(2)
		expect(result.setFailed).toHaveBeenCalledWith(expect.stringContaining("Add labels failed"))
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "coderabbit-review-active" }))
		expect(latestGuide(result)).toContain(`coderabbit-review-label:${SHA}:pending -->`)
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

	it("uses the latest run for the required integration", async () => {
		const result = await runWorkflow({
			additionalCheckRuns: [{ id: 0, name: "tests", status: "completed", conclusion: "failure", appId: 15368 }],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("ignores a newer same-name run from another integration", async () => {
		const result = await runWorkflow({
			additionalCheckRuns: [{ id: 100, name: "tests", status: "completed", conclusion: "failure", appId: 999 }],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("allows an empty required-check ruleset", async () => {
		const result = await runWorkflow({ requiredContexts: [] })

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("does not treat unknown mergeability as a conflict", async () => {
		const result = await runWorkflow({ mergeable: null, mergeableState: "unknown" })

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
		expect(result.addLabels).not.toHaveBeenCalledWith(expect.objectContaining({ labels: ["has-conflicts"] }))
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

	it("blocks an unpinned context when its check passes but its status fails", async () => {
		const result = await runWorkflow({
			requiredIntegrationId: null,
			commitStatuses: [{ context: "tests", state: "failure" }],
		})

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(latestGateStatus(result)?.description).toContain("failing required CI checks")
	})

	it("keeps an unpinned context pending when its check passes but its status is pending", async () => {
		const result = await runWorkflow({
			requiredIntegrationId: null,
			commitStatuses: [{ context: "tests", state: "pending" }],
		})

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(latestGateStatus(result)?.description).toContain("required CI checks")
	})

	it("reports failure when an unpinned check is pending but its status failed", async () => {
		const result = await runWorkflow({
			requiredIntegrationId: null,
			requiredStatus: "in_progress",
			commitStatuses: [{ context: "tests", state: "failure" }],
		})

		expect(latestGateStatus(result)?.description).toContain("failing required CI checks")
	})

	it("reports failure when an unpinned check failed but its status is pending", async () => {
		const result = await runWorkflow({
			requiredIntegrationId: null,
			requiredConclusion: "failure",
			commitStatuses: [{ context: "tests", state: "pending" }],
		})

		expect(latestGateStatus(result)?.description).toContain("failing required CI checks")
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

	it("keeps an external same-name review gate pending when it has not reported", async () => {
		const result = await runWorkflow({
			requiredContexts: ["PR review gate"],
			requiredIntegrationId: 15368,
			omitRequiredRuns: true,
		})

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(latestGateStatus(result)?.description).toContain("required CI checks")
	})

	it("keeps an external same-name review gate blocked when it fails", async () => {
		const result = await runWorkflow({
			requiredContexts: ["PR review gate"],
			requiredIntegrationId: 15368,
			requiredRunAppId: 15368,
			requiredConclusion: "failure",
		})

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(latestGateStatus(result)?.description).toContain("failing required CI checks")
	})

	it("keeps another workflow's reconcile check pending when it has not reported", async () => {
		const result = await runWorkflow({
			requiredContexts: ["reconcile"],
			requiredIntegrationId: 15368,
			omitRequiredRuns: true,
		})

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(latestGateStatus(result)?.description).toContain("required CI checks")
	})

	it("keeps another workflow's reconcile check blocked when it fails", async () => {
		const result = await runWorkflow({
			requiredContexts: ["reconcile"],
			requiredIntegrationId: 15368,
			requiredRunAppId: 15368,
			requiredConclusion: "failure",
		})

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(latestGateStatus(result)?.description).toContain("failing required CI checks")
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
		expect(latestGateStatus(result)?.state).toBe("success")
	})

	it("ignores maintainer approvals from an older head", async () => {
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
					commitId: OLD_SHA,
				},
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
		expect(latestGateStatus(result)?.state).toBe("success")
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
		expect(latestGateStatus(result)?.state).toBe("pending")
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

	it("passes once CodeRabbit approval makes the PR ready for maintainer review", async () => {
		const result = await runWorkflow({
			permissions: { maintainer: "write" },
			reviews: [
				{
					login: "maintainer",
					type: "User",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT + 1_000,
				},
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
		expect(latestGateStatus(result)?.state).toBe("success")
	})

	it("publishes the review gate as a standalone commit status", async () => {
		const result = await runWorkflow()

		expect(latestGateStatus(result)).toEqual(
			expect.objectContaining({
				context: "Zoo Code / PR review gate",
				sha: SHA,
				state: "pending",
				target_url: WORKFLOW_RUN_URL,
			}),
		)
	})

	it("does not republish an unchanged review gate status", async () => {
		const result = await runWorkflow({
			gateStatuses: [
				{
					context: "Zoo Code / PR review gate",
					state: "pending",
					description: "Required CI passed. Wait for CodeRabbit to approve the latest commit.",
					targetUrl: "https://github.com/Zoo-Code-Org/Zoo-Code/pull/1437",
				},
			],
		})

		expect(result.createCommitStatus).not.toHaveBeenCalled()
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-coderabbit"] }))
	})

	it("continues metadata reconciliation when gate publication fails", async () => {
		const result = await runWorkflow({ createCommitStatusErrorStatus: 500 })

		expect(result.setFailed).not.toHaveBeenCalled()
		expect(result.warning).toHaveBeenCalledWith(
			expect.stringContaining("could not publish Zoo Code / PR review gate"),
		)
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
		expect(latestGuide(result)).toContain(`coderabbit-review-label:${SHA}`)
	})

	it("fails closed when a successful gate cannot be invalidated", async () => {
		const result = await runWorkflow({
			createCommitStatusErrorStatus: 500,
			gateStatuses: [
				{
					context: "Zoo Code / PR review gate",
					state: "success",
					description: "Approved",
					targetUrl: "https://github.com/Zoo-Code-Org/Zoo-Code/pull/1437",
				},
			],
		})

		expect(result.setFailed).toHaveBeenCalledWith(
			expect.stringContaining("could not invalidate Zoo Code / PR review gate"),
		)
	})

	it("fails closed when review-guide comments cannot be listed", async () => {
		const result = await runWorkflow({ listCommentsErrorStatus: 500 })

		expect(result.setFailed).toHaveBeenCalledWith(expect.stringContaining("List comments failed"))
		expect(latestGateStatus(result)?.state).toBe("pending")
	})

	it("fails closed when the review-guide comment cannot be created", async () => {
		const result = await runWorkflow({ createCommentErrorStatus: 500 })

		expect(result.setFailed).toHaveBeenCalledWith(expect.stringContaining("Create comment failed"))
		expect(latestGateStatus(result)?.state).toBe("pending")
	})

	it("fails closed when the review-guide comment cannot be updated", async () => {
		const result = await runWorkflow({ existingGuide: true, updateCommentErrorStatus: 500 })

		expect(result.setFailed).toHaveBeenCalledWith(expect.stringContaining("Update comment failed"))
		expect(latestGateStatus(result)?.state).toBe("pending")
	})

	it("publishes a pending gate and continues reconciliation when status lookup fails", async () => {
		const result = await runWorkflow({ gateStatusLookupErrorStatus: 500 })

		expect(result.setFailed).not.toHaveBeenCalled()
		expect(result.warning).toHaveBeenCalledWith(
			expect.stringContaining("could not inspect Zoo Code / PR review gate"),
		)
		expect(latestGateStatus(result)?.state).toBe("pending")
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("does not publish success when gate status lookup fails at the maintainer handoff", async () => {
		const result = await runWorkflow({
			gateStatusLookupErrorStatus: 500,
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
			],
		})

		expect(result.setFailed).not.toHaveBeenCalled()
		expect(result.warning).toHaveBeenCalledWith(
			expect.stringContaining("could not inspect Zoo Code / PR review gate"),
		)
		expect(result.createCommitStatus).not.toHaveBeenCalledWith(expect.objectContaining({ state: "success" }))
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
	})

	it("forces gate invalidation after a reconciliation failure even when status lookup fails", async () => {
		const result = await runWorkflow({
			gateStatusLookupErrorStatus: 500,
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
		expect(latestGateStatus(result)?.state).toBe("pending")
	})

	it("reports non-404 permission lookup failures", async () => {
		const result = await runWorkflow({
			labels: ["awaiting-maintainer", "coderabbit-review-active"],
			gateStatuses: [
				{
					context: "Zoo Code / PR review gate",
					state: "success",
					description: "Approved",
					targetUrl: "https://github.com/Zoo-Code-Org/Zoo-Code/pull/1437",
				},
			],
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
		expect(latestGateStatus(result)?.state).toBe("pending")
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-maintainer" }))
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "coderabbit-review-active" }))
	})

	it("fails closed when repository rules require the advisory reconciliation job", async () => {
		const result = await runWorkflow({
			requiredContexts: ["tests", "Zoo Code / reconcile PR review state"],
		})

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(result.warning).toHaveBeenCalledWith(expect.stringContaining("self-referential required check"))
		expect(latestGateStatus(result)?.description).toContain("must not require")
	})

	it("fails closed for a self-referential reconciliation rule from any integration", async () => {
		const result = await runWorkflow({
			requiredContexts: ["Zoo Code / reconcile PR review state"],
			requiredIntegrationId: 999,
			omitRequiredRuns: true,
		})

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(result.warning).toHaveBeenCalledWith(expect.stringContaining("self-referential required check"))
		expect(latestGateStatus(result)?.description).toContain("must not require")
	})

	it("fails closed when repository rules require the advisory review gate", async () => {
		const result = await runWorkflow({
			requiredContexts: ["Zoo Code / PR review gate"],
		})

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(result.warning).toHaveBeenCalledWith(expect.stringContaining("self-referential required check"))
		expect(latestGateStatus(result)?.description).toContain("must not require")
	})

	it("reports self-referential configuration before merge conflicts", async () => {
		const result = await runWorkflow({
			conflict: true,
			labels: ["coderabbit-review-active", "awaiting-maintainer"],
			requiredContexts: ["Zoo Code / PR review gate"],
		})

		expect(result.warning).toHaveBeenCalledWith(expect.stringContaining("self-referential required check"))
		expect(latestGateStatus(result)?.description).toContain("must not require")
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "coderabbit-review-active" }))
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-maintainer" }))
		expect(result.addLabels).not.toHaveBeenCalledWith(expect.objectContaining({ labels: ["has-conflicts"] }))
	})

	it("preserves configuration-error when review-guide lookup fails", async () => {
		const result = await runWorkflow({
			requiredContexts: ["Zoo Code / PR review gate"],
			listCommentsErrorStatus: 500,
		})

		expect(result.setFailed).toHaveBeenCalledWith(expect.stringContaining("List comments failed"))
		expect(latestGateStatus(result)?.description).toContain("must not require")
		expect(result.createCommitStatus.mock.invocationCallOrder[0]).toBeLessThan(
			result.listComments.mock.invocationCallOrder[0],
		)
	})

	it("preserves configuration-error when metadata cleanup fails", async () => {
		const result = await runWorkflow({
			requiredContexts: ["Zoo Code / PR review gate"],
			labels: ["coderabbit-review-active", "awaiting-maintainer"],
			removeLabelStatus: 500,
		})

		expect(result.setFailed).toHaveBeenCalledWith(expect.stringContaining("could not clear review metadata"))
		expect(latestGateStatus(result)?.description).toContain("must not require")
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "coderabbit-review-active" }))
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-maintainer" }))
	})

	it("attempts every stale label removal when one cleanup fails", async () => {
		const result = await runWorkflow({
			permissionErrorStatus: 500,
			labels: ["awaiting-coderabbit", "awaiting-maintainer", "stale-awaiting-author"],
			removeLabelStatus: 500,
		})

		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-coderabbit" }))
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-maintainer" }))
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "stale-awaiting-author" }))
		expect(result.setFailed).toHaveBeenCalledWith(expect.stringContaining("could not clear review metadata"))
	})

	it("outer cleanup removes a label added before partial reconciliation failure", async () => {
		const result = await runWorkflow({
			labels: ["has-conflicts"],
			removeLabelFailOnceName: "has-conflicts",
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-coderabbit"] }))
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-coderabbit" }))
		expect(result.setFailed).toHaveBeenCalledWith(expect.stringContaining("Remove label failed once"))
	})

	it("does not exclude a reconcile check from another integration", async () => {
		const result = await runWorkflow({
			requiredContexts: ["reconcile"],
			requiredIntegrationId: 999,
			requiredRunAppId: 15368,
		})

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(latestGateStatus(result)?.description).toContain("required CI checks")
	})

	it("accepts a completed reconcile check from another integration", async () => {
		const result = await runWorkflow({
			requiredContexts: ["reconcile"],
			requiredIntegrationId: 999,
			additionalCheckRuns: [
				{ id: 100, name: "reconcile", status: "completed", conclusion: "success", appId: 999 },
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("passes fork review gates at the maintainer handoff", async () => {
		const result = await runWorkflow({
			eventName: "schedule",
			fork: true,
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
			],
		})

		expect(latestGateStatus(result)?.state).toBe("success")
		expect(latestGateStatus(result)?.description).toContain("Ready for human maintainer")
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

	it("reconciles only the requested PR during manual dispatch", async () => {
		const result = await runWorkflow({ eventName: "workflow_dispatch", workflowDispatchPrNumber: 1437 })

		expect(result.listPullRequests).not.toHaveBeenCalled()
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
