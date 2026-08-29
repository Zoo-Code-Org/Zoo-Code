import fs from "node:fs"
import path from "node:path"

import { describe, expect, it, vi } from "vitest"
import { parse } from "yaml"

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const repositoryRoot = path.resolve(process.cwd(), "..")
const workflow = parse(
	fs.readFileSync(path.join(repositoryRoot, ".github/workflows/label-pr-review-state.yml"), "utf8"),
)
const workflowScript = workflow.jobs.reconcile.steps[0].with.script as string

const SHA = "a".repeat(40)
const CI_COMPLETED_AT = Date.parse("2026-08-29T15:00:00Z")
const REQUESTED_AT = Date.parse("2026-08-29T15:01:00Z")
const REVIEWED_AT = Date.parse("2026-08-29T15:02:00Z")

type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED"

interface HarnessOptions {
	prState?: "open" | "closed"
	draft?: boolean
	authorType?: "Bot" | "User"
	eventName?: string
	commentCreatedAt?: number
	senderType?: "Bot" | "User"
	existingGuide?: string
	reviews?: Array<{
		login: string
		type: "Bot" | "User"
		state: ReviewState
		submittedAt: number
		commitId?: string
	}>
	permissions?: Record<string, string>
	requiredContexts?: string[]
	branchRulesFail?: boolean
}

function triggerMarker(requestedAt = REQUESTED_AT, actor = "maintainer") {
	return `<!-- coderabbit-review-trigger:${SHA}:${actor}:${requestedAt} -->`
}

function guideWithTrigger(requestedAt = REQUESTED_AT) {
	return `<!-- zoo-code-pr-review-process -->\n${triggerMarker(requestedAt)}\n**Current step:** Waiting`
}

async function runWorkflow(options: HarnessOptions = {}) {
	const pr = {
		number: 1437,
		state: options.prState ?? "open",
		draft: options.draft ?? false,
		html_url: "https://github.com/Zoo-Code-Org/Zoo-Code/pull/1437",
		user: { login: options.authorType === "User" ? "author" : "zoomote[bot]", type: options.authorType ?? "Bot" },
		head: { sha: SHA, repo: { full_name: "Zoo-Code-Org/Zoo-Code" } },
		base: { ref: "main", repo: { full_name: "Zoo-Code-Org/Zoo-Code" } },
		labels: [] as Array<{ name: string }>,
		mergeable: true,
		mergeable_state: "clean",
	}
	const requiredContexts = options.requiredContexts ?? ["tests"]
	const checkRuns = requiredContexts
		.filter((name) => name !== "reconcile")
		.map((name, index) => ({
			id: index + 1,
			name,
			status: "completed",
			conclusion: "success",
			started_at: new Date(CI_COMPLETED_AT - 1_000).toISOString(),
			completed_at: new Date(CI_COMPLETED_AT).toISOString(),
			app: { id: 15368, slug: "github-actions" },
		}))
	const reviews = (options.reviews ?? []).map((review, index) => ({
		id: index + 1,
		state: review.state,
		commit_id: review.commitId ?? SHA,
		submitted_at: new Date(review.submittedAt).toISOString(),
		user: { login: review.login, type: review.type },
	}))
	const existingComments = options.existingGuide
		? [{ id: 10, user: { login: "github-actions[bot]" }, body: options.existingGuide }]
		: []

	const addLabels = vi.fn(async (_args: unknown) => undefined)
	const createComment = vi.fn(async (_args: unknown) => undefined)
	const updateComment = vi.fn(async (_args: unknown) => undefined)
	const createCheck = vi.fn(async (_args: unknown) => undefined)
	const updateCheck = vi.fn(async (_args: unknown) => undefined)
	const setFailed = vi.fn()
	const permissionFor = vi.fn(async ({ username }: { username: string }) => {
		const permission = options.permissions?.[username]
		if (!permission) {
			throw Object.assign(new Error("Not Found"), { status: 404 })
		}
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
								integration_id: 15368,
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
				getLabel: vi.fn(async () => ({ data: {} })),
				createLabel: vi.fn(async () => undefined),
				removeLabel: vi.fn(async () => undefined),
				addLabels,
				listComments: vi.fn(async () => existingComments),
				createComment,
				updateComment,
			},
			checks: {
				listForRef: vi.fn(async (args: { check_name?: string }) => (args.check_name ? [] : checkRuns)),
				create: createCheck,
				update: updateCheck,
			},
			repos: {
				listCommitStatusesForRef: vi.fn(async () => []),
				getCollaboratorPermissionLevel: permissionFor,
			},
		},
	}
	const context = {
		eventName: options.eventName ?? "issue_comment",
		repo: { owner: "Zoo-Code-Org", repo: "Zoo-Code" },
		payload: {
			action: "created",
			issue: { number: 1437, pull_request: {} },
			comment: {
				body: "@coderabbitai review",
				created_at: new Date(options.commentCreatedAt ?? REQUESTED_AT).toISOString(),
			},
			sender: { login: "maintainer", type: options.senderType ?? "User" },
		},
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
		createComment,
		updateComment,
		createCheck,
		updateCheck,
		setFailed,
		permissionFor,
	}
}

function latestGuide(result: Awaited<ReturnType<typeof runWorkflow>>) {
	const created = result.createComment.mock.calls.at(-1)?.[0] as { body?: string } | undefined
	const updated = result.updateComment.mock.calls.at(-1)?.[0] as { body?: string } | undefined
	return updated?.body ?? created?.body ?? ""
}

function latestCheck(result: Awaited<ReturnType<typeof runWorkflow>>) {
	const created = result.createCheck.mock.calls.at(-1)?.[0] as
		| { conclusion?: string; output?: { summary?: string } }
		| undefined
	const updated = result.updateCheck.mock.calls.at(-1)?.[0] as
		| { conclusion?: string; output?: { summary?: string } }
		| undefined
	return updated ?? created
}

describe("PR review-state workflow", () => {
	it("ignores comment events for closed pull requests", async () => {
		const result = await runWorkflow({ prState: "closed" })

		expect(result.createComment).not.toHaveBeenCalled()
		expect(result.createCheck).not.toHaveBeenCalled()
	})

	it("records draft review requests and waits for CodeRabbit", async () => {
		const result = await runWorkflow({ draft: true, permissions: { maintainer: "write" } })

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-coderabbit"] }))
		expect(latestGuide(result)).toContain(triggerMarker())
		expect(latestCheck(result)?.output?.summary).not.toContain("coderabbit-review-trigger")
	})

	it("moves approved draft reviews to awaiting-ready", async () => {
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
			],
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-ready"] }))
		expect(latestGuide(result)).toContain("Mark the draft ready for maintainer review")
	})

	it("keeps the first accepted trigger for repeated commands", async () => {
		const result = await runWorkflow({
			draft: true,
			commentCreatedAt: REVIEWED_AT + 1_000,
			existingGuide: guideWithTrigger(),
			permissions: { maintainer: "write" },
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
		expect(latestGuide(result)).toContain(triggerMarker())
		expect(latestGuide(result)).not.toContain(String(REVIEWED_AT + 1_000))
	})

	it("rejects commands created before required CI completed", async () => {
		const result = await runWorkflow({
			draft: true,
			commentCreatedAt: CI_COMPLETED_AT - 1,
			permissions: { maintainer: "write" },
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-review-trigger"] }))
		expect(latestGuide(result)).not.toContain("coderabbit-review-trigger")
	})

	it("rejects bot-authored review commands", async () => {
		const result = await runWorkflow({
			draft: true,
			senderType: "Bot",
			permissions: { maintainer: "write" },
		})

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-review-trigger"] }))
		expect(latestGuide(result)).not.toContain("coderabbit-review-trigger")
	})

	it("routes CodeRabbit change requests back to the author", async () => {
		const result = await runWorkflow({
			draft: true,
			permissions: { maintainer: "write" },
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
	})

	it("treats non-collaborator reviews as non-maintainer input", async () => {
		const result = await runWorkflow({
			authorType: "User",
			eventName: "pull_request_review",
			existingGuide: guideWithTrigger(),
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

	it("excludes the reconciliation job from required checks", async () => {
		const result = await runWorkflow({ requiredContexts: ["tests", "reconcile"] })

		expect(result.addLabels).toHaveBeenCalledWith(expect.objectContaining({ labels: ["awaiting-review-trigger"] }))
	})

	it("passes only after a later non-author maintainer approval", async () => {
		const result = await runWorkflow({
			authorType: "User",
			eventName: "pull_request_review",
			existingGuide: guideWithTrigger(),
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

		expect(latestCheck(result)?.conclusion).toBe("success")
		expect(result.addLabels).not.toHaveBeenCalled()
	})

	it("fails closed when branch rules are unavailable", async () => {
		const result = await runWorkflow({ branchRulesFail: true })

		expect(result.addLabels).not.toHaveBeenCalled()
		expect(latestCheck(result)?.output?.summary).toContain("required CI checks")
	})
})
