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
const codeRabbitConfig = parse(fs.readFileSync(path.join(repositoryRoot, ".coderabbit.yaml"), "utf8"))
const workflowScript = workflow.jobs.reconcile.steps[0].with.script as string
const resolveScript = workflow.jobs.resolve.steps[0].with.script as string

const SHA = "a".repeat(40)
const OLD_SHA = "b".repeat(40)
const REVIEWED_AT = Date.parse("2026-08-29T15:02:00Z")

type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"

interface HarnessOptions {
	prState?: "open" | "closed"
	draft?: boolean
	conflict?: boolean
	mergeable?: boolean | null
	mergeableState?: string
	mergeabilitySequence?: Array<{ mergeable: boolean | null; mergeableState: string }>
	fork?: boolean
	eventName?: string
	issueCommentActor?: string
	workflowRunAssociated?: boolean
	workflowRunFallback?: "match" | "sha-mismatch" | "base-mismatch" | "none"
	workflowRunHeadBranch?: string
	workflowRunMissing?: "repository" | "branch" | "sha"
	workflowDispatchPrNumber?: number
	openPrNumbers?: number[]
	workflowRunPrNumbers?: number[]
	sharedState?: SharedState
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
		id?: number
	}>
	timelineEvents?: Array<{
		event: string
		actor?: string
		requestedReviewer?: string
		requestedTeam?: string
		createdAt?: number
	}>
	timelineErrorStatus?: number
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

/**
 * Remote state shared between two harness executions. Lets a test interleave
 * two reconcile runs against the same labels, guide comment, and gate status
 * to demonstrate how the job-level concurrency key serializes them.
 */
interface SharedState {
	labels: Set<string>
	guide: { body: string | null }
	gate: { status: { state: string; description: string } | null }
}

function buildHarnessPr(options: HarnessOptions) {
	const headRepository = options.fork ? "contributor/Zoo-Code" : "Zoo-Code-Org/Zoo-Code"
	return {
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
}

type HarnessPr = ReturnType<typeof buildHarnessPr>

function createListPullRequests(options: HarnessOptions, eventName: string, pr: HarnessPr) {
	return vi.fn(async ({ state }: { state?: string }) => {
		if (state === "open" && options.prState === "closed") return []
		if (eventName === "workflow_run" && options.workflowRunAssociated === false) {
			if (options.workflowRunFallback === "none" || options.workflowRunFallback === undefined) return []
			if (options.workflowRunFallback === "sha-mismatch") {
				return [{ ...pr, head: { ...pr.head, sha: OLD_SHA } }]
			}
			if (options.workflowRunFallback === "base-mismatch") {
				return [{ ...pr, base: { ...pr.base, repo: { full_name: "another/repository" } } }]
			}
		}
		if (options.openPrNumbers) {
			return options.openPrNumbers.map((number) => ({ ...pr, number }))
		}
		return [pr]
	})
}

function buildEventPayload(eventName: string, options: HarnessOptions) {
	const headRepository = options.fork ? "contributor/Zoo-Code" : "Zoo-Code-Org/Zoo-Code"
	const pullRequestPayload =
		eventName === "push"
			? undefined
			: {
					number: 1437,
					head: { repo: { full_name: headRepository } },
					base: { repo: { full_name: "Zoo-Code-Org/Zoo-Code" } },
				}
	return eventName === "schedule"
		? {}
		: eventName === "issue_comment"
			? {
					issue: { number: 1437, pull_request: {} },
					comment: { user: { login: options.issueCommentActor ?? "coderabbitai[bot]" } },
				}
			: eventName === "workflow_dispatch"
				? { inputs: { pull_request_number: String(options.workflowDispatchPrNumber ?? 1437) } }
				: eventName === "workflow_run"
					? {
							workflow_run: {
								pull_requests:
									options.workflowRunAssociated === false
										? []
										: (options.workflowRunPrNumbers ?? [1437]).map((number) => ({ number })),
								head_repository:
									options.workflowRunMissing === "repository"
										? null
										: { owner: { login: options.fork ? "contributor" : "Zoo-Code-Org" } },
								head_branch:
									options.workflowRunMissing === "branch"
										? null
										: (options.workflowRunHeadBranch ?? "feature/test"),
								head_sha: options.workflowRunMissing === "sha" ? null : SHA,
								id: 123456,
							},
						}
					: {
							action: "ready_for_review",
							pull_request: pullRequestPayload,
						}
}

/** Executes the embedded github-script workflow against deterministic GitHub API doubles. */
async function runWorkflow(options: HarnessOptions = {}) {
	const eventName = options.eventName ?? "pull_request_target"
	const pr = buildHarnessPr(options)
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
		id: review.id ?? index + 1,
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
	const remoteLabels = options.sharedState?.labels ?? new Set(pr.labels.map((label) => label.name))

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
		if (options.sharedState) {
			options.sharedState.guide.body = args.body
		}
		return { data: { id: 11, user: { login: "github-actions[bot]" }, body: args.body } }
	})
	const updateComment = vi.fn(async (args: { comment_id: number; body: string }) => {
		if (options.updateCommentErrorStatus) {
			throw Object.assign(new Error("Update comment failed"), { status: options.updateCommentErrorStatus })
		}
		if (options.sharedState) {
			options.sharedState.guide.body = args.body
		}
		return { data: { id: args.comment_id, user: { login: "github-actions[bot]" }, body: args.body } }
	})
	const listComments = vi.fn(async () => {
		if (options.listCommentsErrorStatus) {
			throw Object.assign(new Error("List comments failed"), { status: options.listCommentsErrorStatus })
		}
		if (options.sharedState) {
			return options.sharedState.guide.body
				? [{ id: 10, user: { login: "github-actions[bot]" }, body: options.sharedState.guide.body }]
				: []
		}
		return existingComments
	})
	const listEventsForTimeline = vi.fn(async () => {
		if (options.timelineErrorStatus) {
			throw Object.assign(new Error("List timeline events failed"), { status: options.timelineErrorStatus })
		}
		return (options.timelineEvents ?? []).map((event, index) => ({
			id: index + 1,
			event: event.event,
			created_at: new Date(event.createdAt ?? REVIEWED_AT).toISOString(),
			actor: event.actor ? { login: event.actor } : undefined,
			requested_reviewer: event.requestedReviewer ? { login: event.requestedReviewer } : undefined,
			requested_team: event.requestedTeam ? { slug: event.requestedTeam } : undefined,
		}))
	})
	const createCommitStatus = vi.fn(
		async (args: { sha: string; state: string; context: string; description: string; target_url: string }) => {
			if (options.createCommitStatusErrorStatus) {
				throw Object.assign(new Error("Commit status failed"), {
					status: options.createCommitStatusErrorStatus,
				})
			}
			if (options.sharedState) {
				options.sharedState.gate.status = { state: args.state, description: args.description }
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
	const listPullRequests = createListPullRequests(options, eventName, pr)
	let mergeabilityIndex = 0
	const getPullRequest = vi.fn(async () => {
		const mergeability = options.mergeabilitySequence?.[mergeabilityIndex++]
		return {
			data: mergeability
				? { ...pr, mergeable: mergeability.mergeable, mergeable_state: mergeability.mergeableState }
				: pr,
		}
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
				get: getPullRequest,
				list: listPullRequests,
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
				listEventsForTimeline,
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
	const payload = buildEventPayload(eventName, options)
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

	// The reconcile job runs one matrix shard per PR and receives the target
	// through the job's PR_NUMBER env mapping.
	const previousPrNumber = process.env.PR_NUMBER
	process.env.PR_NUMBER = String(pr.number)
	try {
		await new AsyncFunction("github", "context", "core", workflowScript)(github, context, core)
	} finally {
		if (previousPrNumber === undefined) {
			delete process.env.PR_NUMBER
		} else {
			process.env.PR_NUMBER = previousPrNumber
		}
	}

	return {
		addLabels,
		removeLabel,
		createComment,
		updateComment,
		listComments,
		listEventsForTimeline,
		createCommitStatus,
		createLabel,
		setFailed,
		info: core.info,
		warning: core.warning,
		getPullRequest,
		listPullRequests: github.rest.pulls.list,
		listCommitStatusesForRef: github.rest.repos.listCommitStatusesForRef,
		permissionFor,
	}
}

/** Executes the resolve job's embedded script against deterministic GitHub API doubles. */
async function runResolve(options: HarnessOptions = {}) {
	const eventName = options.eventName ?? "pull_request_target"
	const pr = buildHarnessPr(options)
	const listPullRequests = createListPullRequests(options, eventName, pr)
	const getPullRequest = vi.fn(async () => ({ data: pr }))
	const github = {
		paginate: vi.fn(async (target: unknown, args: unknown) => {
			if (typeof target !== "function") throw new Error("Unexpected paginate target")
			return target(args)
		}),
		rest: {
			pulls: {
				get: getPullRequest,
				list: listPullRequests,
			},
		},
	}
	const payload = buildEventPayload(eventName, options)
	const context = {
		eventName,
		repo: { owner: "Zoo-Code-Org", repo: "Zoo-Code" },
		payload,
	}
	const setOutput = vi.fn()
	const core = {
		info: vi.fn(),
		debug: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
		setFailed: vi.fn(),
		setOutput,
	}

	await new AsyncFunction("github", "context", "core", resolveScript)(github, context, core)

	const prNumbersOutput = setOutput.mock.calls.find(([name]) => name === "pr_numbers")?.[1] as string | undefined
	return {
		setOutput,
		listPullRequests,
		getPullRequest,
		info: core.info,
		prNumbers: () => (prNumbersOutput !== undefined ? (JSON.parse(prNumbersOutput) as number[]) : undefined),
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
	it("uses supported CodeRabbit access and review controls", () => {
		expect(codeRabbitConfig.chat.allow_non_org_members).toBe(false)
		expect(codeRabbitConfig.reviews.pre_merge_checks.override_requested_reviewers_only).toBe(true)
		expect(codeRabbitConfig.reviews.auto_review.auto_pause_after_reviewed_commits).toBe(0)
		expect(codeRabbitConfig.reviews.auto_review.labels).toEqual(["coderabbit-review-active"])
	})

	it("keeps privileged event handling metadata-only and least-privilege", () => {
		expect(workflow.permissions).toEqual({
			"pull-requests": "write",
			issues: "write",
			checks: "read",
			statuses: "write",
		})
		expect(JSON.stringify(workflow.jobs.reconcile.steps)).not.toMatch(/actions\/checkout|\bpnpm\b|\bnpm\b/)
		expect(workflowScript).not.toContain("@coderabbitai")
	})

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

	it("reconciles CodeRabbit status comments with the canonical bot identity", async () => {
		expect(workflow.on.issue_comment.types).toEqual(["created", "edited"])
		expect(workflow.jobs.reconcile.if).toContain("github.event.comment.user.login == 'coderabbitai[bot]'")

		const result = await runWorkflow({
			eventName: "issue_comment",
			fork: true,
			labels: ["awaiting-maintainer", "coderabbit-review-active"],
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "CHANGES_REQUESTED",
					submittedAt: REVIEWED_AT,
				},
			],
		})

		expect(result.getPullRequest).toHaveBeenCalledTimes(1)
		expect(result.listPullRequests).not.toHaveBeenCalled()
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-maintainer" }))
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "coderabbit-review-active" }))
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
		expect(result.setFailed).not.toHaveBeenCalled()
	})

	it("ignores contributor comments before privileged reconciliation", async () => {
		const result = await runWorkflow({
			eventName: "issue_comment",
			issueCommentActor: "outside-contributor",
			fork: true,
			labels: ["awaiting-maintainer"],
		})

		expect(result.getPullRequest).not.toHaveBeenCalled()
		expect(result.listPullRequests).not.toHaveBeenCalled()
		expect(result.addLabels).not.toHaveBeenCalled()
		expect(result.removeLabel).not.toHaveBeenCalled()
		expect(result.createComment).not.toHaveBeenCalled()
		expect(result.createCommitStatus).not.toHaveBeenCalled()
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
		expect(latestGuide(result)).toContain("Review-state labels are managed by this workflow")
	})

	it("starts CodeRabbit for zoomote-authored PRs after required CI passes", async () => {
		const result = await runWorkflow({
			prAuthor: { login: "zoomote[bot]", type: "Bot" },
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-coderabbit"] }))
		expect(latestGateStatus(result)?.state).toBe("pending")
		expect(latestGateStatus(result)?.description).toContain("Waiting for automated review")
		expect(result.info).toHaveBeenCalledWith(expect.stringContaining("coderabbit=pending"))
	})

	it("does not start CodeRabbit for draft zoomote-authored PRs", async () => {
		const result = await runWorkflow({
			draft: true,
			prAuthor: { login: "zoomote[bot]", type: "Bot" },
		})

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(latestGuide(result)).toContain("Mark the PR ready")
	})

	it("does not start CodeRabbit for zoomote-authored PRs while required CI fails", async () => {
		const result = await runWorkflow({
			prAuthor: { login: "zoomote[bot]", type: "Bot" },
			requiredConclusion: "failure",
		})

		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(latestGateStatus(result)?.description).toContain("Fix the failing required CI checks")
	})

	it("routes other bot-authored PRs directly to maintainer review", async () => {
		const result = await runWorkflow({
			prAuthor: { login: "dependabot[bot]", type: "Bot" },
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
		expect(result.addLabels).not.toHaveBeenCalledWith(
			expect.objectContaining({ labels: ["coderabbit-review-active"] }),
		)
		expect(latestGateStatus(result)?.state).toBe("success")
		expect(latestGateStatus(result)?.description).toContain("Awaiting fresh human maintainer")
		expect(result.info).toHaveBeenCalledWith(expect.stringContaining("coderabbit=optional"))
	})

	it("completes other bot-authored PR review after human maintainer approval", async () => {
		const result = await runWorkflow({
			prAuthor: { login: "dependabot[bot]", type: "Bot" },
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
			prAuthor: { login: "dependabot[bot]", type: "Bot" },
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
		expect(latestGuide(result)).toContain("a maintainer must restart it")
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

	it("clears awaiting-maintainer when a main push introduces conflicts", async () => {
		const resolution = await runResolve({ eventName: "push" })
		const result = await runWorkflow({
			eventName: "push",
			conflict: true,
			labels: ["awaiting-maintainer"],
		})

		expect(workflow.on.push.branches).toContain("main")
		expect(resolution.listPullRequests).toHaveBeenCalledWith(expect.objectContaining({ state: "open" }))
		expect(resolution.prNumbers()).toEqual([1437])
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-maintainer" }))
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["has-conflicts"] }))
	})

	it("preserves awaiting-maintainer when adding has-conflicts fails", async () => {
		const result = await runWorkflow({
			conflict: true,
			labels: ["awaiting-maintainer"],
			addLabelsStatus: 500,
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["has-conflicts"] }))
		expect(result.removeLabel).not.toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-maintainer" }))
		expect(result.setFailed).toHaveBeenCalledWith(expect.stringContaining("Could not add desired label"))
	})

	it("rechecks mergeability before tagging a PR awaiting maintainer", async () => {
		const result = await runWorkflow({
			eventName: "push",
			labels: ["awaiting-maintainer"],
			mergeabilitySequence: [
				{ mergeable: null, mergeableState: "unknown" },
				{ mergeable: false, mergeableState: "dirty" },
			],
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
			],
		})

		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-maintainer" }))
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["has-conflicts"] }))
	})

	it("preserves the current state while mergeability is unknown", async () => {
		const result = await runWorkflow({
			eventName: "push",
			labels: ["awaiting-maintainer", "coderabbit-review-active"],
			mergeabilitySequence: [
				{ mergeable: null, mergeableState: "unknown" },
				{ mergeable: null, mergeableState: "unknown" },
			],
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
			],
		})

		expect(result.removeLabel).not.toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-maintainer" }))
		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "coderabbit-review-active" }))
		expect(result.addLabels).not.toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
		expect(latestGateStatus(result)?.description).toContain("calculating mergeability")
		expect(latestGuide(result)).toContain("calculating mergeability")
	})

	it("preserves the current state when pending mergeability metadata cannot be updated", async () => {
		const result = await runWorkflow({
			eventName: "push",
			labels: ["awaiting-maintainer", "coderabbit-review-active"],
			mergeabilitySequence: [
				{ mergeable: null, mergeableState: "unknown" },
				{ mergeable: null, mergeableState: "unknown" },
			],
			removeLabelStatus: 500,
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
				},
			],
		})

		expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "coderabbit-review-active" }))
		expect(result.removeLabel).not.toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-maintainer" }))
		expect(result.setFailed).toHaveBeenCalledWith(expect.stringContaining("Remove label failed"))
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
		expect(latestGuide(result)).toContain(
			"After fixes are pushed and required CI passes, automated review restarts.",
		)
		expect(latestGuide(result)).not.toContain("@coderabbitai")
	})

	it("treats a fresh bot approval as automated review completion only", async () => {
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
		expect(latestGuide(result)).toContain("Automated review is complete for the latest commit")
		expect(latestGuide(result)).toContain("does not replace human approval")
	})

	it.each([
		["in_progress", undefined, "Wait for required CI checks"],
		["completed", "failure", "Fix the failing required CI checks"],
	] as const)(
		"explains why %s required CI blocks maintainer handoff",
		async (requiredStatus, requiredConclusion, text) => {
			const result = await runWorkflow({ requiredStatus, requiredConclusion })

			expect(latestGuide(result)).toContain(text)
			expect(latestGuide(result)).toContain("awaiting-maintainer")
		},
	)

	it.each([
		{ login: "CodeRabbitAI[bot]", type: "Bot" },
		{ login: "coderabbitai", type: "User" },
	] as const)("recognizes CodeRabbit review login $login", async ({ login, type }) => {
		const result = await runWorkflow({
			permissionErrorStatus: 500,
			reviews: [
				{
					login,
					type,
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
			expect.objectContaining({ context: "Zoo Code / PR review gate", sha: SHA, state: "pending" }),
		)
	})

	it("does not republish an unchanged review gate status", async () => {
		const result = await runWorkflow({
			gateStatuses: [
				{
					context: "Zoo Code / PR review gate",
					state: "pending",
					description: "Required CI passed. Waiting for automated review of the latest commit.",
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
		expect(latestGateStatus(result)?.description).toContain("Awaiting fresh human maintainer")
	})

	it("fails closed when branch rules are unavailable", async () => {
		const result = await runWorkflow({ branchRulesFail: true })

		expect(result.addLabels).not.toHaveBeenCalled()
		expect(latestGateStatus(result)?.description).toContain("required CI checks")
	})

	it("lists open PRs during scheduled reconciliation", async () => {
		const resolution = await runResolve({ eventName: "schedule" })

		expect(resolution.listPullRequests).toHaveBeenCalledWith(expect.objectContaining({ state: "open" }))
		expect(resolution.prNumbers()).toEqual([1437])

		const result = await runWorkflow({ eventName: "schedule" })

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("reconciles only the requested PR during manual dispatch", async () => {
		const resolution = await runResolve({ eventName: "workflow_dispatch", workflowDispatchPrNumber: 1437 })

		expect(resolution.listPullRequests).not.toHaveBeenCalled()
		expect(resolution.prNumbers()).toEqual([1437])

		const result = await runWorkflow({ eventName: "workflow_dispatch", workflowDispatchPrNumber: 1437 })

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("reconciles the PR associated with a workflow run", async () => {
		const resolution = await runResolve({ eventName: "workflow_run" })

		expect(resolution.listPullRequests).not.toHaveBeenCalled()
		expect(resolution.prNumbers()).toEqual([1437])

		const result = await runWorkflow({ eventName: "workflow_run" })

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
	})

	it("ignores closed PRs associated with workflow runs", async () => {
		const result = await runWorkflow({ eventName: "workflow_run", prState: "closed" })

		expect(result.createCommitStatus).not.toHaveBeenCalled()
		expect(result.addLabels).not.toHaveBeenCalled()
	})

	it("resolves an unassociated same-repository workflow run by exact head", async () => {
		const resolution = await runResolve({
			eventName: "workflow_run",
			workflowRunAssociated: false,
			workflowRunFallback: "match",
		})

		expect(resolution.listPullRequests).toHaveBeenCalledWith(
			expect.objectContaining({ head: "Zoo-Code-Org:feature/test", state: "open" }),
		)
		expect(resolution.prNumbers()).toEqual([1437])
	})

	it("ignores closed PRs when resolving an unassociated workflow run", async () => {
		const resolution = await runResolve({
			eventName: "workflow_run",
			prState: "closed",
			workflowRunAssociated: false,
			workflowRunFallback: "match",
		})

		expect(resolution.listPullRequests).toHaveBeenCalledTimes(1)
		expect(resolution.listPullRequests).toHaveBeenCalledWith(
			expect.objectContaining({ head: "Zoo-Code-Org:feature/test", state: "open" }),
		)
		expect(resolution.getPullRequest).not.toHaveBeenCalled()
		expect(resolution.prNumbers()).toEqual([])
	})

	it("resolves an unassociated fork workflow run by exact head", async () => {
		const resolution = await runResolve({
			eventName: "workflow_run",
			workflowRunAssociated: false,
			workflowRunFallback: "match",
			fork: true,
		})

		expect(resolution.listPullRequests).toHaveBeenCalledWith(
			expect.objectContaining({ head: "contributor:feature/test", state: "open" }),
		)
		expect(resolution.prNumbers()).toEqual([1437])
	})

	it("ignores an unassociated workflow run when the candidate head SHA differs", async () => {
		const resolution = await runResolve({
			eventName: "workflow_run",
			workflowRunAssociated: false,
			workflowRunFallback: "sha-mismatch",
		})

		expect(resolution.listPullRequests).toHaveBeenCalled()
		expect(resolution.getPullRequest).not.toHaveBeenCalled()
		expect(resolution.prNumbers()).toEqual([])
	})

	it("ignores an unassociated workflow run when the candidate base repository differs", async () => {
		const resolution = await runResolve({
			eventName: "workflow_run",
			workflowRunAssociated: false,
			workflowRunFallback: "base-mismatch",
		})

		expect(resolution.listPullRequests).toHaveBeenCalledTimes(1)
		expect(resolution.getPullRequest).not.toHaveBeenCalled()
		expect(resolution.prNumbers()).toEqual([])
	})

	it.each(["repository", "branch", "sha"] as const)(
		"ignores an unassociated workflow run with missing %s metadata",
		async (workflowRunMissing) => {
			const resolution = await runResolve({
				eventName: "workflow_run",
				workflowRunAssociated: false,
				workflowRunMissing,
			})

			expect(resolution.listPullRequests).not.toHaveBeenCalled()
			expect(resolution.getPullRequest).not.toHaveBeenCalled()
			expect(resolution.prNumbers()).toEqual([])
		},
	)

	it("does not sweep every PR when an unassociated workflow run has no exact match", async () => {
		const resolution = await runResolve({ eventName: "workflow_run", workflowRunAssociated: false })

		expect(resolution.listPullRequests).toHaveBeenCalledTimes(1)
		expect(resolution.listPullRequests).toHaveBeenCalledWith(
			expect.objectContaining({ head: "Zoo-Code-Org:feature/test", state: "open" }),
		)
		expect(resolution.prNumbers()).toEqual([])
	})

	it("invalidates prior automated and human reviews after a new push", async () => {
		const result = await runWorkflow({
			permissions: { maintainer: "write" },
			reviews: [
				{
					login: "coderabbitai[bot]",
					type: "Bot",
					state: "APPROVED",
					submittedAt: REVIEWED_AT,
					commitId: OLD_SHA,
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

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-coderabbit"] }))
		expect(result.addLabels).not.toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
		expect(latestGateStatus(result)?.state).toBe("pending")
	})

	describe("maintainer change-request blockers (#1671)", () => {
		const coderabbitApproval = {
			login: "coderabbitai[bot]",
			type: "Bot" as const,
			state: "APPROVED" as const,
			submittedAt: REVIEWED_AT,
		}
		const staleMaintainerChangeRequest = {
			login: "maintainer",
			type: "User" as const,
			state: "CHANGES_REQUESTED" as const,
			submittedAt: REVIEWED_AT + 1_000,
			commitId: OLD_SHA,
		}
		const authorReRequest = {
			event: "review_requested",
			actor: "contributor",
			requestedReviewer: "maintainer",
			createdAt: REVIEWED_AT + 2_000,
		}

		it("reconciles on review_request_removed without treating removal as clearing evidence", async () => {
			expect(workflow.on.pull_request_target.types).toContain("review_request_removed")

			const result = await runWorkflow({
				permissions: { maintainer: "write" },
				reviews: [coderabbitApproval, staleMaintainerChangeRequest],
				timelineEvents: [
					{
						event: "review_request_removed",
						actor: "contributor",
						requestedReviewer: "maintainer",
						createdAt: REVIEWED_AT + 2_000,
					},
				],
			})

			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
			expect(result.setFailed).not.toHaveBeenCalled()
		})

		it("keeps awaiting-author after an author push without a re-request", async () => {
			const result = await runWorkflow({
				labels: ["awaiting-author"],
				permissions: { maintainer: "write" },
				reviews: [coderabbitApproval, staleMaintainerChangeRequest],
			})

			expect(result.addLabels).not.toHaveBeenCalledWith(
				expect.objectContaining({ labels: ["awaiting-maintainer"] }),
			)
			expect(result.removeLabel).not.toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-author" }))
			expect(latestGuide(result)).toContain("re-request review")
			expect(latestGateStatus(result)?.state).toBe("pending")
		})

		it("keeps the blocker after a base-only merge", async () => {
			const result = await runWorkflow({
				eventName: "push",
				labels: ["awaiting-author"],
				permissions: { maintainer: "write" },
				reviews: [coderabbitApproval, staleMaintainerChangeRequest],
			})

			expect(result.removeLabel).not.toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-author" }))
			expect(result.addLabels).not.toHaveBeenCalledWith(
				expect.objectContaining({ labels: ["awaiting-maintainer"] }),
			)
		})

		it("does not clear a human blocker with a current-head CodeRabbit approval", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write" },
				reviews: [coderabbitApproval, staleMaintainerChangeRequest],
			})

			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
		})

		it("does not clear the blocker when another maintainer approves", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write", approver: "admin" },
				reviews: [
					coderabbitApproval,
					staleMaintainerChangeRequest,
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

		it("clears the blocker when the author re-requests review from the blocking maintainer", async () => {
			const result = await runWorkflow({
				labels: ["awaiting-author"],
				permissions: { maintainer: "write" },
				reviews: [coderabbitApproval, staleMaintainerChangeRequest],
				timelineEvents: [authorReRequest],
			})

			expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-author" }))
			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
			expect(latestGateStatus(result)?.state).toBe("success")
		})

		it("clears the blocker when the blocking maintainer re-requests their own review", async () => {
			const result = await runWorkflow({
				labels: ["awaiting-author"],
				permissions: { maintainer: "write" },
				reviews: [coderabbitApproval, staleMaintainerChangeRequest],
				timelineEvents: [
					{
						event: "review_requested",
						actor: "maintainer",
						requestedReviewer: "maintainer",
						createdAt: REVIEWED_AT + 2_000,
					},
				],
			})

			expect(result.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-author" }))
			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
			expect(latestGateStatus(result)?.state).toBe("success")
		})

		it("keeps the blocker when the maintainer self-re-request predates the blocking review", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write" },
				reviews: [coderabbitApproval, staleMaintainerChangeRequest],
				timelineEvents: [
					{
						event: "review_requested",
						actor: "maintainer",
						requestedReviewer: "maintainer",
						createdAt: REVIEWED_AT + 500,
					},
				],
			})

			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
			expect(result.addLabels).not.toHaveBeenCalledWith(
				expect.objectContaining({ labels: ["awaiting-maintainer"] }),
			)
		})

		it("clears the blocker when the blocking maintainer submits a newer approval", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write" },
				reviews: [
					coderabbitApproval,
					staleMaintainerChangeRequest,
					{
						login: "maintainer",
						type: "User",
						state: "APPROVED",
						submittedAt: REVIEWED_AT + 2_000,
					},
				],
			})

			expect(result.addLabels).not.toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
			expect(latestGateStatus(result)?.state).toBe("success")
			expect(latestGateStatus(result)?.description).toContain("required review sequence passed")
		})

		it("keeps the blocker when the blocking maintainer only comments", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write" },
				reviews: [
					coderabbitApproval,
					staleMaintainerChangeRequest,
					{
						login: "maintainer",
						type: "User",
						state: "COMMENTED",
						submittedAt: REVIEWED_AT + 2_000,
					},
				],
			})

			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
		})

		it("re-blocks when the maintainer's newer review also requests changes", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write" },
				reviews: [
					coderabbitApproval,
					staleMaintainerChangeRequest,
					{
						login: "maintainer",
						type: "User",
						state: "CHANGES_REQUESTED",
						submittedAt: REVIEWED_AT + 3_000,
					},
				],
				timelineEvents: [authorReRequest],
			})

			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
		})

		it("clears the blocker when the blocking review is dismissed", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write" },
				reviews: [
					coderabbitApproval,
					{
						login: "maintainer",
						type: "User",
						state: "DISMISSED",
						submittedAt: REVIEWED_AT + 1_000,
						commitId: OLD_SHA,
					},
				],
			})

			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
			expect(result.addLabels).not.toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
		})

		it("keeps multiple maintainer blockers independent", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write", "second-maintainer": "maintain" },
				reviews: [
					coderabbitApproval,
					staleMaintainerChangeRequest,
					{
						login: "second-maintainer",
						type: "User",
						state: "CHANGES_REQUESTED",
						submittedAt: REVIEWED_AT + 1_500,
						commitId: OLD_SHA,
					},
				],
				timelineEvents: [authorReRequest],
			})

			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
			expect(latestGateStatus(result)?.state).toBe("pending")
		})

		it("produces the same blocker state for reordered and duplicate timeline events", async () => {
			const reordered = await runWorkflow({
				labels: ["awaiting-author"],
				permissions: { maintainer: "write" },
				reviews: [coderabbitApproval, staleMaintainerChangeRequest],
				timelineEvents: [
					authorReRequest,
					{
						event: "review_requested",
						actor: "contributor",
						requestedReviewer: "maintainer",
						createdAt: REVIEWED_AT + 2_000,
					},
					{
						event: "review_request_removed",
						actor: "maintainer",
						requestedReviewer: "maintainer",
						createdAt: REVIEWED_AT + 3_000,
					},
					authorReRequest,
				],
			})

			expect(reordered.addLabels).toHaveBeenCalledWith(
				expect.objectContaining({ labels: ["awaiting-maintainer"] }),
			)
			expect(reordered.setFailed).not.toHaveBeenCalled()
		})

		it("produces the same blocker state for reordered review history", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write" },
				reviews: [
					{
						id: 3,
						login: "maintainer",
						type: "User",
						state: "APPROVED",
						submittedAt: REVIEWED_AT + 2_000,
					},
					{ ...staleMaintainerChangeRequest, id: 2 },
					{ ...coderabbitApproval, id: 1 },
				],
			})

			expect(result.addLabels).not.toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
			expect(latestGateStatus(result)?.state).toBe("success")
		})

		it("fails closed when timeline reconstruction is incomplete", async () => {
			const result = await runWorkflow({
				labels: ["awaiting-author"],
				permissions: { maintainer: "write" },
				timelineErrorStatus: 500,
				reviews: [coderabbitApproval, staleMaintainerChangeRequest],
			})

			expect(result.warning).toHaveBeenCalledWith(
				expect.stringContaining("could not reconstruct review-request history"),
			)
			expect(result.removeLabel).not.toHaveBeenCalledWith(expect.objectContaining({ name: "awaiting-author" }))
			expect(result.addLabels).not.toHaveBeenCalledWith(
				expect.objectContaining({ labels: ["awaiting-maintainer"] }),
			)
			expect(result.setFailed).not.toHaveBeenCalled()
		})

		it("does not clear an individual blocker for a team review request", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write" },
				reviews: [coderabbitApproval, staleMaintainerChangeRequest],
				timelineEvents: [
					{
						event: "review_requested",
						actor: "contributor",
						requestedTeam: "maintainers",
						createdAt: REVIEWED_AT + 2_000,
					},
				],
			})

			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
		})

		it("does not clear the blocker when a non-author re-requests review", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write", "other-maintainer": "write" },
				reviews: [coderabbitApproval, staleMaintainerChangeRequest],
				timelineEvents: [
					{
						event: "review_requested",
						actor: "other-maintainer",
						requestedReviewer: "maintainer",
						createdAt: REVIEWED_AT + 2_000,
					},
				],
			})

			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
		})

		it("does not clear the blocker for a re-request that predates the blocking review", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write" },
				reviews: [coderabbitApproval, staleMaintainerChangeRequest],
				timelineEvents: [
					{
						event: "review_requested",
						actor: "contributor",
						requestedReviewer: "maintainer",
						createdAt: REVIEWED_AT + 500,
					},
				],
			})

			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
		})

		it("does not clear the blocker for a re-request naming a different reviewer", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write", "other-maintainer": "write" },
				reviews: [coderabbitApproval, staleMaintainerChangeRequest],
				timelineEvents: [
					{
						event: "review_requested",
						actor: "contributor",
						requestedReviewer: "other-maintainer",
						createdAt: REVIEWED_AT + 2_000,
					},
				],
			})

			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
		})

		it("memoizes collaborator permission lookups across both review loops", async () => {
			const result = await runWorkflow({
				permissions: { maintainer: "write" },
				reviews: [
					coderabbitApproval,
					{
						login: "maintainer",
						type: "User",
						state: "CHANGES_REQUESTED",
						submittedAt: REVIEWED_AT + 1_000,
					},
				],
			})

			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
			expect(result.permissionFor.mock.calls.filter(([args]) => args.username === "maintainer")).toHaveLength(1)
		})

		it("ignores blockers from non-collaborator reviewers", async () => {
			const result = await runWorkflow({
				reviews: [
					coderabbitApproval,
					{
						login: "drive-by-reviewer",
						type: "User",
						state: "CHANGES_REQUESTED",
						submittedAt: REVIEWED_AT + 1_000,
						commitId: OLD_SHA,
					},
				],
			})

			expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-maintainer"] }))
			expect(result.addLabels).not.toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-author"] }))
			expect(result.setFailed).not.toHaveBeenCalled()
		})
	})
})

describe("PR review-state workflow concurrency groups (#1707)", () => {
	// Minimal evaluator for the exact GitHub expression subset used by the
	// workflow- and job-level concurrency groups: top-level `||` chains, `&&`,
	// loose `==`, `github.`/`matrix.` property paths, `[0]` indexing (null
	// parent -> null), parenthesized operands, and string/number literals.
	// GitHub expressions use loose truthiness, so `||`/`&&` return operand
	// values rather than booleans and missing properties evaluate to null
	// instead of throwing.
	interface GithubExpressionContext {
		event_name: string
		run_id: number
		event: {
			pull_request?: {
				number: number
				head?: { repo?: { full_name?: string } | null }
				base?: { repo?: { full_name?: string } | null }
			}
			issue?: { number: number }
			workflow_run?: { id?: number; pull_requests?: Array<{ number: number }> }
			inputs?: { pull_request_number: number }
		}
	}

	interface MatrixContext {
		pr_number?: number | null
	}

	interface ExpressionRoots {
		github: GithubExpressionContext
		matrix?: MatrixContext
	}

	function splitTopLevel(expression: string, operator: "||" | "&&" | "==" | "!="): string[] {
		const parts: string[] = []
		let depth = 0
		let inString = false
		let start = 0
		for (let index = 0; index < expression.length; index++) {
			const char = expression[index]
			if (char === "'") {
				inString = !inString
			} else if (!inString && char === "(") {
				depth++
			} else if (!inString && char === ")") {
				depth--
			} else if (!inString && depth === 0 && expression.startsWith(operator, index)) {
				parts.push(expression.slice(start, index))
				index += operator.length - 1
				start = index + 1
			}
		}
		parts.push(expression.slice(start))
		return parts
	}

	function isTruthy(value: unknown): boolean {
		return value !== null && value !== undefined && value !== false && value !== 0 && value !== ""
	}

	function looseEquals(left: unknown, right: unknown): boolean {
		if (left === null || left === undefined || right === null || right === undefined) {
			return (left ?? null) === (right ?? null)
		}
		if (typeof left === "string" && typeof right === "string") {
			return left.toLowerCase() === right.toLowerCase()
		}
		return left === right
	}

	function resolvePath(path: string, roots: ExpressionRoots): unknown {
		let value: unknown = roots
		for (const segment of path.split(".")) {
			if (value === null || value === undefined) {
				return null
			}
			const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(\d+)\])?$/.exec(segment)
			if (!match) {
				throw new Error(`Unsupported path segment: ${segment}`)
			}
			value = (value as Record<string, unknown>)[match[1]]
			if (match[2] !== undefined) {
				if (!Array.isArray(value)) {
					return null
				}
				value = value[Number(match[2])] ?? null
			}
		}
		return value ?? null
	}

	function evaluatePrimary(expression: string, roots: ExpressionRoots): unknown {
		const current = expression.trim()
		if (current.startsWith("(")) {
			// Strip the parentheses only when the first one wraps the whole expression.
			let depth = 0
			for (let index = 0; index < current.length; index++) {
				if (current[index] === "(") {
					depth++
				} else if (current[index] === ")") {
					depth--
				}
				if (depth === 0) {
					if (index === current.length - 1) {
						return evaluateExpression(current.slice(1, -1), roots)
					}
					break
				}
			}
		}
		if (current.startsWith("'") && current.endsWith("'")) {
			return current.slice(1, -1)
		}
		if (/^\d+$/.test(current)) {
			return Number(current)
		}
		if (/^(github|matrix)\./.test(current)) {
			return resolvePath(current, roots)
		}
		return evaluateExpression(current, roots)
	}

	function evaluateComparison(expression: string, roots: ExpressionRoots): unknown {
		const notEquals = splitTopLevel(expression, "!=")
		if (notEquals.length > 1) {
			return !looseEquals(evaluatePrimary(notEquals[0], roots), evaluatePrimary(notEquals[1], roots))
		}
		const parts = splitTopLevel(expression, "==")
		if (parts.length === 1) {
			return evaluatePrimary(parts[0], roots)
		}
		return looseEquals(evaluatePrimary(parts[0], roots), evaluatePrimary(parts[1], roots))
	}

	function evaluateAndChain(expression: string, roots: ExpressionRoots): unknown {
		let result: unknown = true
		for (const part of splitTopLevel(expression, "&&")) {
			result = evaluateComparison(part, roots)
			if (!isTruthy(result)) {
				return result
			}
		}
		return result
	}

	function evaluateExpression(expression: string, roots: ExpressionRoots): unknown {
		let result: unknown = null
		for (const part of splitTopLevel(expression, "||")) {
			result = evaluateAndChain(part, roots)
			if (isTruthy(result)) {
				return result
			}
		}
		return result
	}

	function evaluateTemplate(template: string, roots: ExpressionRoots): string {
		return template.replace(/\$\{\{(.+?)\}\}/gs, (_match, expression: string) => {
			const value = evaluateExpression(expression, roots)
			return isTruthy(value) ? String(value) : ""
		})
	}

	/** Evaluates the workflow-level concurrency group for an event context. */
	function workflowGroupFor(github: GithubExpressionContext): string {
		return evaluateTemplate(workflow.concurrency.group as string, { github })
	}

	/** Evaluates the mutating job's per-shard concurrency group for a matrix shard. */
	function shardGroupFor(github: GithubExpressionContext, matrix: MatrixContext): string {
		return evaluateTemplate(workflow.jobs.reconcile.concurrency.group as string, { github, matrix })
	}

	function contextFor(overrides: {
		event_name: string
		run_id?: number
		event?: GithubExpressionContext["event"]
	}): GithubExpressionContext {
		return {
			event_name: overrides.event_name,
			run_id: overrides.run_id ?? 21057,
			event: overrides.event ?? {},
		}
	}

	it("keeps cancel-in-progress disabled at both levels", () => {
		expect(workflow.concurrency["cancel-in-progress"]).toBe(false)
		expect(workflow.jobs.reconcile.concurrency["cancel-in-progress"]).toBe(false)
	})

	it("keys every single-PR event type for the same PR to the same workflow-level group", () => {
		const contexts = [
			contextFor({ event_name: "pull_request_target", event: { pull_request: { number: 1664 } } }),
			contextFor({ event_name: "pull_request_review", event: { pull_request: { number: 1664 } } }),
			// CodeRabbit status comments arrive as issue_comment events on the PR.
			contextFor({ event_name: "issue_comment", event: { issue: { number: 1664 } } }),
			contextFor({ event_name: "workflow_dispatch", event: { inputs: { pull_request_number: 1664 } } }),
		]

		for (const context of contexts) {
			expect(workflowGroupFor(context)).toBe("label-pr-review-state-1664")
		}
	})

	it("keys different PRs to different workflow-level groups so unrelated triggers cannot starve a pending run", () => {
		// The #1707 regression: with one shared group, a trigger for PR B superseded
		// PR A's pending reconcile. Per-PR keys make that supersession impossible.
		const prA = contextFor({ event_name: "pull_request_target", event: { pull_request: { number: 1664 } } })
		const prB = contextFor({ event_name: "pull_request_target", event: { pull_request: { number: 1707 } } })

		const groupA = workflowGroupFor(prA)
		const groupB = workflowGroupFor(prB)
		expect(groupA).toBe("label-pr-review-state-1664")
		expect(groupB).toBe("label-pr-review-state-1707")
		expect(groupB).not.toBe(groupA)
	})

	it("keys issue comments by issue number, matching the PR group for the same numeric id", () => {
		// Issues and PRs share one GitHub number sequence, so an issue-comment run
		// can never collide with a different PR's group.
		const issueComment = contextFor({ event_name: "issue_comment", event: { issue: { number: 1707 } } })
		const prEvent = contextFor({ event_name: "pull_request_target", event: { pull_request: { number: 1707 } } })

		expect(workflowGroupFor(issueComment)).toBe(workflowGroupFor(prEvent))
	})

	it("keys workflow_run events by the unique triggering run id rather than a PR number", () => {
		// A workflow_run can reconcile several associated PRs; keying by the first
		// PR's number would let an unrelated event for that PR supersede the whole
		// run and starve the remaining PRs. The run id is unique per triggering
		// run, so multi-PR runs can neither supersede nor be superseded by
		// unrelated events.
		const multiPrRun = contextFor({
			event_name: "workflow_run",
			event: { workflow_run: { id: 35477088534, pull_requests: [{ number: 1664 }, { number: 1707 }] } },
		})
		expect(workflowGroupFor(multiPrRun)).toBe("label-pr-review-state-35477088534")
		expect(workflowGroupFor(multiPrRun)).not.toBe("label-pr-review-state-1664")
		expect(workflowGroupFor(multiPrRun)).not.toBe("label-pr-review-state-1707")

		const otherRun = contextFor({
			event_name: "workflow_run",
			event: { workflow_run: { id: 35477090001, pull_requests: [{ number: 1664 }] } },
		})
		expect(workflowGroupFor(otherRun)).toBe("label-pr-review-state-35477090001")
		expect(workflowGroupFor(otherRun)).not.toBe(workflowGroupFor(multiPrRun))
	})

	it("keys fork workflow runs without associated PRs by run id instead of falling through", () => {
		// Fork workflow_run events leave pull_requests empty; the run id key
		// inherently covers them so they never contend with other runs.
		const forkRun = contextFor({
			event_name: "workflow_run",
			event: { workflow_run: { id: 777000111, pull_requests: [] } },
		})

		expect(workflowGroupFor(forkRun)).toBe("label-pr-review-state-777000111")
		expect(workflowGroupFor(forkRun)).not.toBe("label-pr-review-state-21057")
	})

	it("shares a single sweep group for the hourly schedule and pushes to main", () => {
		const scheduled = contextFor({ event_name: "schedule" })
		const push = contextFor({ event_name: "push" })

		expect(workflowGroupFor(scheduled)).toBe("label-pr-review-state-sweep")
		expect(workflowGroupFor(push)).toBe("label-pr-review-state-sweep")
	})

	it("falls back to a unique per-run workflow-level group when no event field resolves", () => {
		const runA = contextFor({ event_name: "repository_dispatch", run_id: 101 })
		const runB = contextFor({ event_name: "repository_dispatch", run_id: 102 })

		expect(workflowGroupFor(runA)).toBe("label-pr-review-state-101")
		expect(workflowGroupFor(runB)).toBe("label-pr-review-state-102")
	})

	it("keys every mutating shard per PR in one shared job-level group namespace", () => {
		// The serialization point for a PR: direct-event shards, sweep-resolved
		// shards, and workflow_run-resolved shards must all map to the identical
		// job-level group so their non-atomic writes can never interleave.
		const triggerContexts = [
			contextFor({ event_name: "pull_request_target", event: { pull_request: { number: 1664 } } }),
			contextFor({ event_name: "issue_comment", event: { issue: { number: 1664 } } }),
			contextFor({ event_name: "workflow_dispatch", event: { inputs: { pull_request_number: 1664 } } }),
			contextFor({
				event_name: "workflow_run",
				event: { workflow_run: { id: 999, pull_requests: [{ number: 1664 }] } },
			}),
			contextFor({ event_name: "schedule" }),
			contextFor({ event_name: "push" }),
		]

		for (const context of triggerContexts) {
			expect(shardGroupFor(context, { pr_number: 1664 })).toBe("label-pr-review-state-reconcile-1664")
		}
		expect(shardGroupFor(triggerContexts[0], { pr_number: 1707 })).toBe("label-pr-review-state-reconcile-1707")
		expect(shardGroupFor(triggerContexts[0], { pr_number: 1707 })).not.toBe("label-pr-review-state-reconcile-1664")
	})

	it("keeps workflow-level and job-level groups disjoint for every trigger path", () => {
		// Live regression (run 35548066989): for direct single-PR triggers the
		// shard group equaled the workflow-level group its own run held, and
		// GitHub failed the job at startup with no logs — concurrency groups are
		// one repo-wide namespace across workflow and job levels. The same
		// collision would apply to a workflow_run.id that numerically matches a
		// PR number. The `-reconcile-` infix makes the two levels disjoint.
		const contexts = [
			contextFor({ event_name: "pull_request_target", event: { pull_request: { number: 1664 } } }),
			contextFor({ event_name: "pull_request_review", event: { pull_request: { number: 1664 } } }),
			contextFor({ event_name: "issue_comment", event: { issue: { number: 1664 } } }),
			contextFor({ event_name: "workflow_dispatch", event: { inputs: { pull_request_number: 1664 } } }),
			// workflow_run.id numerically equal to the PR number: the exact
			// overlap the distinct namespace also has to cover.
			contextFor({
				event_name: "workflow_run",
				event: { workflow_run: { id: 1664, pull_requests: [{ number: 1664 }] } },
			}),
			contextFor({
				event_name: "workflow_run",
				event: { workflow_run: { id: 999, pull_requests: [{ number: 1664 }, { number: 1707 }] } },
			}),
			contextFor({ event_name: "schedule" }),
			contextFor({ event_name: "push" }),
		]

		for (const context of contexts) {
			const workflowGroup = workflowGroupFor(context)
			// The disjointness is structural: workflow-level groups never carry
			// the reconcile infix that every shard group carries.
			expect(workflowGroup).not.toContain("-reconcile-")
			for (const prNumber of [1664, 1707, 1437, 999]) {
				expect(shardGroupFor(context, { pr_number: prNumber })).not.toBe(workflowGroup)
			}
		}
	})

	it("keys read-only fork review runs per-run at both levels so they cannot starve mutating runs", () => {
		// Fork pull_request_review runs get a read-only token (see isReadOnlyRun
		// in the reconcile script) and write nothing, so they must not hold the
		// PR-keyed groups whose newest-pending-wins could supersede a queued
		// mutating run for the same PR.
		const forkReview = contextFor({
			event_name: "pull_request_review",
			run_id: 606000111,
			event: {
				pull_request: {
					number: 1664,
					head: { repo: { full_name: "contributor/Zoo-Code" } },
					base: { repo: { full_name: "Zoo-Code-Org/Zoo-Code" } },
				},
			},
		})
		const mutating = contextFor({ event_name: "issue_comment", event: { issue: { number: 1664 } } })

		expect(workflowGroupFor(forkReview)).toBe("label-pr-review-state-606000111")
		expect(workflowGroupFor(mutating)).toBe("label-pr-review-state-1664")
		expect(workflowGroupFor(forkReview)).not.toBe(workflowGroupFor(mutating))

		// The `-ro-` infix keeps the read-only shard group from ever numerically
		// colliding with a mutating shard group for the same PR.
		expect(shardGroupFor(forkReview, { pr_number: 1664 })).toBe("label-pr-review-state-reconcile-ro-606000111")
		expect(shardGroupFor(mutating, { pr_number: 1664 })).toBe("label-pr-review-state-reconcile-1664")
		expect(shardGroupFor(forkReview, { pr_number: 1664 })).not.toBe(shardGroupFor(mutating, { pr_number: 1664 }))
	})

	it("keeps same-repo review events PR-keyed at both levels", () => {
		const sameRepoReview = contextFor({
			event_name: "pull_request_review",
			event: {
				pull_request: {
					number: 1664,
					head: { repo: { full_name: "Zoo-Code-Org/Zoo-Code" } },
					base: { repo: { full_name: "Zoo-Code-Org/Zoo-Code" } },
				},
			},
		})

		expect(workflowGroupFor(sameRepoReview)).toBe("label-pr-review-state-1664")
		expect(shardGroupFor(sameRepoReview, { pr_number: 1664 })).toBe("label-pr-review-state-reconcile-1664")
	})

	it("fails toward run-scoped groups when review head repository metadata is missing", () => {
		// A missing head.repo cannot be proven same-repo, so the guard treats the
		// run as read-only-safe (run-scoped) rather than PR-keyed.
		const missingHead = contextFor({
			event_name: "pull_request_review",
			run_id: 606000222,
			event: {
				pull_request: {
					number: 1664,
					base: { repo: { full_name: "Zoo-Code-Org/Zoo-Code" } },
				},
			},
		})

		expect(workflowGroupFor(missingHead)).toBe("label-pr-review-state-606000222")
		expect(shardGroupFor(missingHead, { pr_number: 1664 })).toBe("label-pr-review-state-reconcile-ro-606000222")
	})

	it("keeps the empty-resolution shard fallback unique per run", () => {
		const runA = contextFor({
			event_name: "workflow_run",
			run_id: 555000111,
			event: { workflow_run: { id: 1, pull_requests: [] } },
		})
		const runB = contextFor({
			event_name: "workflow_run",
			run_id: 555000222,
			event: { workflow_run: { id: 2, pull_requests: [] } },
		})

		const groupA = shardGroupFor(runA, { pr_number: null })
		const groupB = shardGroupFor(runB, { pr_number: null })
		expect(groupA).toBe("label-pr-review-state-reconcile-555000111")
		expect(groupB).toBe("label-pr-review-state-reconcile-555000222")
		expect(groupA).not.toBe(groupB)
		expect(groupA).not.toBe("label-pr-review-state-reconcile-1664")
	})

	it("fans out one serialized shard per resolved PR", () => {
		expect(workflow.jobs.reconcile.needs).toBe("resolve")
		expect(workflow.jobs.reconcile.strategy["fail-fast"]).toBe(false)
		expect(String(workflow.jobs.reconcile.strategy.matrix.pr_number)).toContain(
			"fromJSON(needs.resolve.outputs.pr_numbers)",
		)
		expect(String(workflow.jobs.resolve.outputs.pr_numbers)).toContain("steps.resolve.outputs.pr_numbers")
		expect(String(workflow.jobs.reconcile.env.PR_NUMBER)).toContain("matrix.pr_number")
		expect(String(workflow.jobs.reconcile.if)).toContain("needs.resolve.outputs.pr_numbers != '[]'")
	})

	it("resolves a direct single-PR event to one shard carrying the shared per-PR group", async () => {
		const resolution = await runResolve({ eventName: "pull_request_target" })

		expect(resolution.prNumbers()).toEqual([1437])

		const context = contextFor({ event_name: "pull_request_target", event: { pull_request: { number: 1437 } } })
		expect(shardGroupFor(context, { pr_number: resolution.prNumbers()?.[0] })).toBe(
			"label-pr-review-state-reconcile-1437",
		)
	})

	it("resolves a sweep to one shard per open PR, each serializing with direct runs for that PR", async () => {
		const resolution = await runResolve({ eventName: "schedule", openPrNumbers: [1664, 1665, 1666] })

		expect(resolution.prNumbers()).toEqual([1664, 1665, 1666])

		const sweepContext = contextFor({ event_name: "schedule" })
		const groups = (resolution.prNumbers() ?? []).map((prNumber) =>
			shardGroupFor(sweepContext, { pr_number: prNumber }),
		)
		expect(groups).toEqual([
			"label-pr-review-state-reconcile-1664",
			"label-pr-review-state-reconcile-1665",
			"label-pr-review-state-reconcile-1666",
		])

		// A direct event for one of those PRs lands in the identical group, so the
		// sweep shard and the direct shard serialize instead of racing.
		const directContext = contextFor({
			event_name: "pull_request_target",
			event: { pull_request: { number: 1665 } },
		})
		expect(shardGroupFor(directContext, { pr_number: 1665 })).toBe(groups[1])
	})

	it("resolves every PR associated with a multi-PR workflow run", async () => {
		const resolution = await runResolve({ eventName: "workflow_run", workflowRunPrNumbers: [1664, 1707] })

		expect(resolution.prNumbers()).toEqual([1664, 1707])

		const context = contextFor({
			event_name: "workflow_run",
			event: { workflow_run: { id: 123456, pull_requests: [{ number: 1664 }, { number: 1707 }] } },
		})
		expect(workflowGroupFor(context)).toBe("label-pr-review-state-123456")
		expect(shardGroupFor(context, { pr_number: 1664 })).toBe("label-pr-review-state-reconcile-1664")
		expect(shardGroupFor(context, { pr_number: 1707 })).toBe("label-pr-review-state-reconcile-1707")
	})

	it("demonstrates the stale-overwrite race that per-PR shard serialization prevents", async () => {
		// The reconcile script is intentionally non-atomic: it reads CI, reviews,
		// labels, and the guide comment, then writes the gate status, labels, and
		// guide. Two shards for the same PR running concurrently can interleave
		// those reads and writes. This simulates the interleave deterministically:
		// a shard working from a stale snapshot lands its writes after a fresher
		// shard and clobbers the newer gate status and guide comment. The shared
		// job-level group keyed per PR is what makes that interleave impossible
		// in production.
		const sharedState: SharedState = {
			labels: new Set(["awaiting-coderabbit"]),
			guide: { body: null },
			gate: { status: null },
		}

		// Fresher shard: CI is green and automated review approved the head commit.
		const fresh = await runWorkflow({
			sharedState,
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

		expect(fresh.setFailed).not.toHaveBeenCalled()
		expect(sharedState.labels.has("awaiting-maintainer")).toBe(true)
		expect(sharedState.labels.has("awaiting-coderabbit")).toBe(false)
		expect(sharedState.gate.status?.state).toBe("success")
		expect(sharedState.guide.body).toContain("Awaiting fresh human maintainer")

		// Stale shard: its snapshot still shows CI pending, so its writes land on
		// top of the fresher shard's gate status and guide comment.
		const stale = await runWorkflow({
			sharedState,
			labels: ["awaiting-coderabbit"],
			requiredStatus: "in_progress",
		})

		expect(stale.setFailed).not.toHaveBeenCalled()
		expect(sharedState.gate.status?.state).toBe("pending")
		expect(sharedState.gate.status?.description).toContain("Wait for required CI checks")
		expect(sharedState.guide.body).toContain("Wait for required CI checks")

		// Both shards map to the identical job-level group for this PR, so GitHub
		// serializes them (one running per group, newest pending wins) and this
		// interleaving cannot occur in production.
		const directContext = contextFor({
			event_name: "pull_request_target",
			event: { pull_request: { number: 1437 } },
		})
		const sweepContext = contextFor({ event_name: "schedule" })
		expect(shardGroupFor(directContext, { pr_number: 1437 })).toBe("label-pr-review-state-reconcile-1437")
		expect(shardGroupFor(sweepContext, { pr_number: 1437 })).toBe(shardGroupFor(directContext, { pr_number: 1437 }))
	})

	it("tolerates label-bootstrap creation races between concurrent shards", async () => {
		const result = await runWorkflow({ labelLookupStatus: 404, createLabelStatus: 422 })

		expect(result.createLabel).toHaveBeenCalled()
		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["coderabbit-review-active"] }))
		expect(result.setFailed).not.toHaveBeenCalled()
	})
})
