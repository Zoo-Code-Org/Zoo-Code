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
const staleWorkflow = parse(fs.readFileSync(path.join(repositoryRoot, ".github/workflows/stale.yml"), "utf8"))
const staleStep = workflow.jobs.reconcile.steps[1]
const staleScript = staleStep.with.script as string

const DAY_MS = 24 * 60 * 60 * 1000
const SHA = "a".repeat(40)

interface HarnessOptions {
	prNumber?: number
	prState?: "open" | "closed"
	prCreatedDaysAgo?: number
	authorLogin?: string
	labels?: string[]
	fork?: boolean
	eventName?: string
	commits?: Array<{ authorLogin: string | null; daysAgo: number }>
	comments?: Array<{ login: string; daysAgo: number }>
	reviews?: Array<{ login: string; daysAgo: number }>
	timeline?: Array<{ event: string; daysAgo: number }>
}

/** Executes the embedded stale-clock github-script step against deterministic GitHub API doubles. */
async function runStaleStep(options: HarnessOptions = {}) {
	const now = Date.now()
	const iso = (daysAgo: number) => new Date(now - daysAgo * DAY_MS).toISOString()
	const authorLogin = options.authorLogin ?? "contributor"
	const pr = {
		number: options.prNumber ?? 28,
		state: options.prState ?? "open",
		created_at: iso(options.prCreatedDaysAgo ?? 200),
		user: { login: authorLogin, type: "User" },
		head: { sha: SHA, repo: { full_name: options.fork ? "contributor/Zoo-Code" : "Zoo-Code-Org/Zoo-Code" } },
		base: { ref: "main", repo: { full_name: "Zoo-Code-Org/Zoo-Code" } },
		labels: (options.labels ?? []).map((name) => ({ name })),
	}

	const getPullRequest = vi.fn(async () => ({ data: pr }))
	const updatePullRequest = vi.fn(async (_args: { state: string }) => ({ data: {} }))
	const addLabels = vi.fn(async (_args: { labels: string[] }) => ({}))
	const removeLabel = vi.fn(async (_args: { name: string }) => ({}))
	const createComment = vi.fn(async (args: { body: string }) => ({ data: { id: 1, body: args.body } }))
	const listCommits = vi.fn(async () =>
		(options.commits ?? []).map((commit) => ({
			author: commit.authorLogin ? { login: commit.authorLogin } : null,
			commit: { author: { date: iso(commit.daysAgo) }, committer: { date: iso(commit.daysAgo) } },
		})),
	)
	const listComments = vi.fn(async () =>
		(options.comments ?? []).map((comment) => ({
			user: { login: comment.login },
			created_at: iso(comment.daysAgo),
		})),
	)
	const listReviews = vi.fn(async () =>
		(options.reviews ?? []).map((review) => ({
			user: { login: review.login },
			submitted_at: iso(review.daysAgo),
		})),
	)
	const listEventsForTimeline = vi.fn(async () =>
		(options.timeline ?? []).map((event) => ({
			event: event.event,
			created_at: iso(event.daysAgo),
		})),
	)

	const github = {
		paginate: vi.fn(async (target: unknown, args: unknown) => {
			if (typeof target !== "function") throw new Error("Unexpected paginate target")
			return target(args)
		}),
		rest: {
			pulls: {
				get: getPullRequest,
				update: updatePullRequest,
				listCommits,
				listReviews,
			},
			issues: {
				addLabels,
				removeLabel,
				createComment,
				listComments,
				listEventsForTimeline,
			},
		},
	}
	const context = {
		eventName: options.eventName ?? "schedule",
		repo: { owner: "Zoo-Code-Org", repo: "Zoo-Code" },
		payload: {},
	}
	const core = {
		info: vi.fn(),
		debug: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
		setFailed: vi.fn(),
	}

	const previousEnv = { prNumber: process.env.PR_NUMBER, group: process.env.CONCURRENCY_GROUP }
	process.env.PR_NUMBER = String(pr.number)
	process.env.CONCURRENCY_GROUP = `label-pr-review-state-reconcile-${pr.number}`
	try {
		await new AsyncFunction("github", "context", "core", staleScript)(github, context, core)
	} finally {
		for (const [key, value] of [
			["PR_NUMBER", previousEnv.prNumber],
			["CONCURRENCY_GROUP", previousEnv.group],
		] as const) {
			if (value === undefined) {
				delete process.env[key]
			} else {
				process.env[key] = value
			}
		}
	}

	return {
		addLabels,
		removeLabel,
		createComment,
		updatePullRequest,
		setFailed: core.setFailed,
		info: core.info,
	}
}

type StaleResult = Awaited<ReturnType<typeof runStaleStep>>

function addedLabels(result: StaleResult) {
	return result.addLabels.mock.calls.flatMap(([args]) => args.labels)
}

function removedLabels(result: StaleResult) {
	return result.removeLabel.mock.calls.map(([args]) => args.name)
}

function commentBodies(result: StaleResult) {
	return result.createComment.mock.calls.map(([args]) => args.body)
}

describe("stale PR clock workflow", () => {
	it("adds a stale-clock step to the reconcile job", () => {
		expect(staleStep.name).toBe("Reconcile stale PR clock")
		expect(staleStep.uses).toContain("actions/github-script")
	})

	it("keeps both actions/stale jobs in debug-only mode while the new step is proven", () => {
		for (const job of Object.values(staleWorkflow.jobs) as Array<{
			steps: Array<{ with?: Record<string, unknown> }>
		}>) {
			for (const step of job.steps) {
				expect(step.with?.["debug-only"]).toBe(true)
			}
		}
	})

	it("closes an inactive PR even when bot activity keeps it updated", async () => {
		const result = await runStaleStep({
			labels: ["stale-inactive"],
			commits: [
				{ authorLogin: "contributor", daysAgo: 100 },
				// A maintainer push to the branch is not author activity.
				{ authorLogin: "maintainer", daysAgo: 1 },
			],
			// The hourly review-status comment from github-actions[bot] must not reset the clock.
			comments: [{ login: "github-actions[bot]", daysAgo: 0.02 }],
		})
		expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
		expect(result.updatePullRequest.mock.calls[0][0]).toMatchObject({ state: "closed" })
		expect(commentBodies(result).some((body) => body.includes("60+ days of inactivity"))).toBe(true)
		expect(result.setFailed).not.toHaveBeenCalled()
	})

	it("marks a PR stale-inactive after 60 days of author inactivity and posts the message once", async () => {
		const result = await runStaleStep({
			commits: [{ authorLogin: "contributor", daysAgo: 61 }],
		})
		expect(addedLabels(result)).toEqual(["stale-inactive"])
		expect(commentBodies(result).some((body) => body.includes("no activity for 60 days"))).toBe(true)
		expect(result.updatePullRequest).not.toHaveBeenCalled()
	})

	it("does not repost the stale message while the stale label is already applied", async () => {
		const result = await runStaleStep({
			labels: ["stale-inactive"],
			commits: [{ authorLogin: "contributor", daysAgo: 62 }],
		})
		expect(result.addLabels).not.toHaveBeenCalled()
		expect(result.createComment).not.toHaveBeenCalled()
		expect(result.updatePullRequest).not.toHaveBeenCalled()
	})

	it("clears stale labels when the author acts inside the window", async () => {
		const result = await runStaleStep({
			labels: ["stale-inactive"],
			comments: [{ login: "contributor", daysAgo: 5 }],
		})
		expect(removedLabels(result)).toEqual(["stale-inactive"])
		expect(result.updatePullRequest).not.toHaveBeenCalled()
		expect(result.addLabels).not.toHaveBeenCalled()
	})

	it("never closes an exempt PR", async () => {
		const result = await runStaleStep({
			labels: ["do-not-close", "stale-inactive"],
			commits: [{ authorLogin: "contributor", daysAgo: 200 }],
		})
		expect(result.updatePullRequest).not.toHaveBeenCalled()
		expect(removedLabels(result)).toEqual(["stale-inactive"])
	})

	it("marks an awaiting-author PR stale-awaiting-author after 14 days of author inactivity", async () => {
		const result = await runStaleStep({
			labels: ["awaiting-author"],
			comments: [{ login: "contributor", daysAgo: 15 }],
		})
		expect(addedLabels(result)).toEqual(["stale-awaiting-author"])
		expect(commentBodies(result).some((body) => body.includes("awaiting author changes for 14 days"))).toBe(true)
		expect(result.updatePullRequest).not.toHaveBeenCalled()
	})

	it("closes an awaiting-author PR after 14 days plus the 7 day grace", async () => {
		const result = await runStaleStep({
			labels: ["awaiting-author", "stale-awaiting-author"],
			comments: [{ login: "contributor", daysAgo: 22 }],
		})
		expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
		expect(commentBodies(result).some((body) => body.includes("author inactivity after requested changes"))).toBe(
			true,
		)
	})

	it("counts a ready_for_review event as author activity", async () => {
		const result = await runStaleStep({
			labels: ["stale-inactive"],
			commits: [{ authorLogin: "contributor", daysAgo: 100 }],
			timeline: [{ event: "ready_for_review", daysAgo: 10 }],
		})
		expect(result.updatePullRequest).not.toHaveBeenCalled()
		expect(removedLabels(result)).toEqual(["stale-inactive"])
	})

	it("counts an author review as author activity", async () => {
		const result = await runStaleStep({
			labels: ["stale-awaiting-author"],
			reviews: [{ login: "contributor", daysAgo: 3 }],
		})
		expect(result.updatePullRequest).not.toHaveBeenCalled()
		expect(removedLabels(result)).toEqual(["stale-awaiting-author"])
	})

	it("writes nothing for a fork PR on a read-only pull_request_review run", async () => {
		const result = await runStaleStep({
			eventName: "pull_request_review",
			fork: true,
			commits: [{ authorLogin: "contributor", daysAgo: 200 }],
		})
		expect(result.updatePullRequest).not.toHaveBeenCalled()
		expect(result.addLabels).not.toHaveBeenCalled()
		expect(result.removeLabel).not.toHaveBeenCalled()
		expect(result.createComment).not.toHaveBeenCalled()
	})

	it("skips PRs that are no longer open", async () => {
		const result = await runStaleStep({
			prState: "closed",
			commits: [{ authorLogin: "contributor", daysAgo: 200 }],
		})
		expect(result.updatePullRequest).not.toHaveBeenCalled()
		expect(result.addLabels).not.toHaveBeenCalled()
		expect(result.removeLabel).not.toHaveBeenCalled()
	})
})
