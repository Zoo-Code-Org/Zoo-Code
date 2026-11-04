import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
// Fixed wall clock: every age in these tests is exact and deterministic.
const NOW = Date.parse("2026-10-17T12:00:00Z")

interface CommitFixture {
	authorLogin?: string | null
	committerLogin?: string | null
	/** Git author date. Defaults to daysAgo. */
	authorDateDaysAgo?: number
	/** Git committer date. Defaults to authorDateDaysAgo. */
	committerDateDaysAgo?: number
	daysAgo?: number
}

interface TimelineFixture {
	event: string
	daysAgo: number
	actor?: string | null
	label?: string
}

interface FailureFixture {
	status?: number
	message: string
}

interface StaleFailures {
	removeLabel?: FailureFixture
	addLabels?: FailureFixture
	createComment?: FailureFixture
	updatePullRequest?: FailureFixture
	listComments?: FailureFixture
	listEventsForTimeline?: FailureFixture
	listCommits?: FailureFixture
	listRepoCommits?: FailureFixture
	listReviews?: FailureFixture
}

interface HarnessOptions {
	prNumber?: number
	prState?: "open" | "closed"
	prCreatedDaysAgo?: number
	prCommitCount?: number
	authorLogin?: string | null
	/** GitHub user.type for the PR author. Defaults to "User". */
	userType?: "User" | "Bot"
	labels?: string[]
	fork?: boolean
	eventName?: string
	commits?: CommitFixture[]
	comments?: Array<{ login: string; daysAgo: number }>
	reviews?: Array<{ login: string; daysAgo: number }>
	timeline?: TimelineFixture[]
	env?: { STALE_DRY_RUN?: string }
	/**
	 * Runs the step with STALE_DRY_RUN unset, so the scheduled-run default
	 * applies. Behavior tests default to explicit writes instead.
	 */
	dryRun?: boolean
	failures?: StaleFailures
	/** Opts out of the harness default assertion that the step never fails. */
	allowFailure?: boolean
}

function failWith(failure?: FailureFixture): Error | undefined {
	if (!failure) return undefined
	const error = new Error(failure.message)
	if (failure.status !== undefined) {
		;(error as Error & { status?: number }).status = failure.status
	}
	return error
}

function rejectOnceWith(mock: { mockRejectedValueOnce: (error: unknown) => unknown }, failure?: FailureFixture) {
	const error = failWith(failure)
	if (error) mock.mockRejectedValueOnce(error)
}

/** Executes the embedded stale-clock github-script step against deterministic GitHub API doubles. */
async function runStaleStep(options: HarnessOptions = {}) {
	vi.setSystemTime(NOW)
	const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY_MS).toISOString()
	const authorLogin = options.authorLogin === undefined ? "contributor" : options.authorLogin
	const pr = {
		number: options.prNumber ?? 28,
		state: options.prState ?? "open",
		created_at: iso(options.prCreatedDaysAgo ?? 200),
		commits: options.prCommitCount ?? options.commits?.length ?? 0,
		user: authorLogin === null ? null : { login: authorLogin, type: options.userType ?? "User" },
		head: { sha: SHA, repo: { full_name: options.fork ? "contributor/Zoo-Code" : "Zoo-Code-Org/Zoo-Code" } },
		base: { ref: "main", repo: { full_name: "Zoo-Code-Org/Zoo-Code" } },
		labels: (options.labels ?? []).map((name) => ({ name })),
	}

	const commitData = () =>
		(options.commits ?? []).map((commit) => {
			const daysAgo = commit.daysAgo ?? 0
			const authorDateDaysAgo = commit.authorDateDaysAgo ?? daysAgo
			const committerDateDaysAgo = commit.committerDateDaysAgo ?? authorDateDaysAgo
			return {
				author: commit.authorLogin ? { login: commit.authorLogin } : null,
				committer: commit.committerLogin ? { login: commit.committerLogin } : null,
				commit: {
					author: { date: iso(authorDateDaysAgo) },
					committer: { date: iso(committerDateDaysAgo) },
				},
			}
		})

	const getPullRequest = vi.fn(async () => ({ data: pr }))
	const updatePullRequest = vi.fn(async (_args: { state: string }) => ({ data: {} }))
	const addLabels = vi.fn(async (_args: { labels: string[] }) => ({ data: {} }))
	const removeLabel = vi.fn(async (_args: { name: string }) => ({ data: {} }))
	const createComment = vi.fn(async (args: { body: string }) => ({ data: { id: 1, body: args.body } }))
	const listCommits = vi.fn(async (args: { pull_number?: number; per_page?: number; page?: number }) => {
		const perPage = args.per_page ?? 100
		const page = args.page ?? 1
		return { data: commitData().slice((page - 1) * perPage, page * perPage) }
	})
	const listRepoCommits = vi.fn(async (args: { sha: string; since?: string; per_page?: number; page?: number }) => {
		const perPage = args.per_page ?? 100
		const page = args.page ?? 1
		return { data: commitData().slice((page - 1) * perPage, page * perPage) }
	})
	const listComments = vi.fn(async (_args: { issue_number?: number; per_page?: number; since?: string }) => ({
		data: (options.comments ?? []).map((comment) => ({
			user: { login: comment.login },
			created_at: iso(comment.daysAgo),
			updated_at: iso(comment.daysAgo),
		})),
	}))
	const listReviews = vi.fn(async (_args: { pull_number?: number; per_page?: number }) => ({
		data: (options.reviews ?? []).map((review) => ({
			user: { login: review.login },
			submitted_at: iso(review.daysAgo),
		})),
	}))
	const listEventsForTimeline = vi.fn(async (_args: { issue_number?: number; per_page?: number }) => ({
		data: (options.timeline ?? []).map((event) => ({
			event: event.event,
			created_at: iso(event.daysAgo),
			actor: event.actor === undefined ? undefined : event.actor === null ? null : { login: event.actor },
			label: event.label === undefined ? undefined : { name: event.label },
		})),
	}))

	rejectOnceWith(updatePullRequest, options.failures?.updatePullRequest)
	rejectOnceWith(removeLabel, options.failures?.removeLabel)
	rejectOnceWith(addLabels, options.failures?.addLabels)
	rejectOnceWith(createComment, options.failures?.createComment)
	rejectOnceWith(listComments, options.failures?.listComments)
	rejectOnceWith(listEventsForTimeline, options.failures?.listEventsForTimeline)
	rejectOnceWith(listCommits, options.failures?.listCommits)
	rejectOnceWith(listRepoCommits, options.failures?.listRepoCommits)
	rejectOnceWith(listReviews, options.failures?.listReviews)

	const github = {
		paginate: vi.fn(async (target: unknown, args: unknown) => {
			if (typeof target !== "function") throw new Error("Unexpected paginate target")
			const response = (await (target as (a: unknown) => Promise<{ data: unknown[] }>)(args)) as {
				data: unknown[]
			}
			return response.data
		}),
		rest: {
			pulls: {
				get: getPullRequest,
				update: updatePullRequest,
				listCommits,
				listReviews,
			},
			repos: {
				listCommits: listRepoCommits,
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

	const previousEnv: Array<[string, string | undefined]> = [
		["PR_NUMBER", process.env.PR_NUMBER],
		["CONCURRENCY_GROUP", process.env.CONCURRENCY_GROUP],
		["STALE_DRY_RUN", process.env.STALE_DRY_RUN],
	]
	process.env.PR_NUMBER = String(pr.number)
	process.env.CONCURRENCY_GROUP = `label-pr-review-state-reconcile-${pr.number}`
	if (options.env?.STALE_DRY_RUN !== undefined) {
		process.env.STALE_DRY_RUN = options.env.STALE_DRY_RUN
	} else if (options.dryRun) {
		delete process.env.STALE_DRY_RUN
	} else {
		process.env.STALE_DRY_RUN = "false"
	}
	try {
		await new AsyncFunction("github", "context", "core", staleScript)(github, context, core)
	} finally {
		for (const [key, value] of previousEnv) {
			if (value === undefined) {
				delete process.env[key]
			} else {
				process.env[key] = value
			}
		}
	}

	// The step must complete without failing unless the test opts out.
	if (!options.allowFailure) {
		expect(core.setFailed).not.toHaveBeenCalled()
	}

	return {
		addLabels,
		removeLabel,
		createComment,
		updatePullRequest,
		listComments,
		listCommits,
		listRepoCommits,
		listEventsForTimeline,
		listReviews,
		setFailed: core.setFailed,
		info: core.info,
		warning: core.warning,
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

function daysSince(isoValue: string | undefined) {
	return (NOW - Date.parse(isoValue ?? "")) / DAY_MS
}

/** A PR past both thresholds whose stale label was applied inside the grace window. */
const closableFixture = {
	labels: ["stale-inactive"],
	commits: [{ authorLogin: "contributor", daysAgo: 100 }],
	timeline: [{ event: "labeled", daysAgo: 10, label: "stale-inactive" }],
}

describe("stale PR clock workflow", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("workflow wiring", () => {
		it("runs the stale-clock step even after an earlier step fails, but not after cancellation", () => {
			expect(staleStep.name).toBe("Reconcile stale PR clock")
			expect(staleStep.uses).toContain("actions/github-script")
			expect(staleStep.if).toBe("${{ !cancelled() }}")
		})

		it("wires the dry-run switch through env and defaults it to true", () => {
			const envValue = String(staleStep.env?.STALE_DRY_RUN)
			expect(envValue).toContain("stale_dry_run")
			expect(envValue).toContain("vars.STALE_DRY_RUN")
			expect(envValue).toContain("'true'")
			const dispatchInputs = workflow.on.workflow_dispatch.inputs
			expect(dispatchInputs.stale_dry_run.default).toBe("true")
			expect(dispatchInputs.stale_dry_run.type).toBe("string")
		})

		it("leaves the stale labels to the stale step instead of stripping them in review-state reconciliation", () => {
			const reviewStep = workflow.jobs.reconcile.steps.find(
				(step: { name?: string }) => step.name === "Reconcile PR review state labels",
			)
			const reviewScript = (reviewStep?.with as { script?: string } | undefined)?.script ?? ""
			expect(reviewScript).not.toContain("stale-awaiting-author")
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
	})

	describe("dry run", () => {
		it("skips every write for the default scheduled run and logs the proposal", async () => {
			const result = await runStaleStep({ ...closableFixture, dryRun: true })
			expect(result.updatePullRequest).not.toHaveBeenCalled()
			expect(result.createComment).not.toHaveBeenCalled()
			expect(result.addLabels).not.toHaveBeenCalled()
			expect(result.removeLabel).not.toHaveBeenCalled()
			expect(result.info.mock.calls.some(([message]) => String(message).includes("[dry-run]"))).toBe(true)
		})

		it("still skips every write when STALE_DRY_RUN is true", async () => {
			const result = await runStaleStep({ ...closableFixture, env: { STALE_DRY_RUN: "true" } })
			expect(result.updatePullRequest).not.toHaveBeenCalled()
			expect(result.createComment).not.toHaveBeenCalled()
			expect(result.addLabels).not.toHaveBeenCalled()
			expect(result.removeLabel).not.toHaveBeenCalled()
		})

		it("writes the proposed close when STALE_DRY_RUN is false", async () => {
			const result = await runStaleStep({ ...closableFixture, env: { STALE_DRY_RUN: "false" } })
			expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
			expect(result.updatePullRequest.mock.calls[0][0]).toMatchObject({ state: "closed" })
			expect(commentBodies(result).some((body) => body.includes("60+ days of inactivity"))).toBe(true)
			expect(result.info.mock.calls.some(([message]) => String(message).includes("[dry-run]"))).toBe(false)
		})
	})

	describe("inactivity thresholds", () => {
		const ordinaryCases = [
			{ days: 59.9, labeled: false, outcome: "none" },
			{ days: 60, labeled: false, outcome: "mark" },
			{ days: 66.9, labeled: true, outcome: "none" },
			{ days: 67, labeled: true, outcome: "close" },
		] as const

		it.each(ordinaryCases)("$outcome at $days days of ordinary inactivity", async ({ days, labeled, outcome }) => {
			const result = await runStaleStep({
				labels: labeled ? ["stale-inactive"] : [],
				commits: [{ authorLogin: "contributor", daysAgo: days }],
				timeline: labeled ? [{ event: "labeled", daysAgo: 10, label: "stale-inactive" }] : [],
			})
			expect(addedLabels(result)).toEqual(outcome === "mark" ? ["stale-inactive"] : [])
			expect(result.updatePullRequest).toHaveBeenCalledTimes(outcome === "close" ? 1 : 0)
		})

		const awaitingAuthorCases = [
			{ days: 13.9, labeled: false, outcome: "none" },
			{ days: 14, labeled: false, outcome: "mark" },
			{ days: 20.9, labeled: true, outcome: "none" },
			{ days: 21, labeled: true, outcome: "close" },
		] as const

		it.each(awaitingAuthorCases)(
			"$outcome at $days days of awaiting-author inactivity",
			async ({ days, labeled, outcome }) => {
				const result = await runStaleStep({
					labels: labeled ? ["awaiting-author", "stale-awaiting-author"] : ["awaiting-author"],
					comments: [{ login: "contributor", daysAgo: days }],
					timeline: labeled ? [{ event: "labeled", daysAgo: 10, label: "stale-awaiting-author" }] : [],
				})
				expect(addedLabels(result)).toEqual(outcome === "mark" ? ["stale-awaiting-author"] : [])
				expect(result.updatePullRequest).toHaveBeenCalledTimes(outcome === "close" ? 1 : 0)
			},
		)

		it.each([
			{ labelAgeDays: 6.9, closes: false },
			{ labelAgeDays: 7, closes: true },
		])("closes at $labelAgeDays days of label age: $closes", async ({ labelAgeDays, closes }) => {
			const result = await runStaleStep({
				labels: ["stale-inactive"],
				commits: [{ authorLogin: "contributor", daysAgo: 70 }],
				timeline: [{ event: "labeled", daysAgo: labelAgeDays, label: "stale-inactive" }],
			})
			expect(result.updatePullRequest).toHaveBeenCalledTimes(closes ? 1 : 0)
		})
	})

	describe("close gate", () => {
		it("marks an old unlabeled PR stale on the first sweep instead of closing it", async () => {
			const result = await runStaleStep({
				commits: [{ authorLogin: "contributor", daysAgo: 100 }],
			})
			expect(addedLabels(result)).toEqual(["stale-inactive"])
			expect(commentBodies(result)).toHaveLength(1)
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("never closes when the stale label is present without any labeled timeline event", async () => {
			const result = await runStaleStep({
				labels: ["stale-inactive"],
				commits: [{ authorLogin: "contributor", daysAgo: 100 }],
			})
			expect(result.updatePullRequest).not.toHaveBeenCalled()
			expect(result.createComment).not.toHaveBeenCalled()
			expect(result.addLabels).not.toHaveBeenCalled()
		})

		it("uses the latest labeled event so a re-applied label restarts the close grace", async () => {
			const result = await runStaleStep({
				labels: ["stale-inactive"],
				commits: [{ authorLogin: "contributor", daysAgo: 100 }],
				timeline: [
					{ event: "labeled", daysAgo: 30, label: "stale-inactive" },
					{ event: "unlabeled", daysAgo: 5, label: "stale-inactive" },
					{ event: "labeled", daysAgo: 3, label: "stale-inactive" },
				],
			})
			expect(result.updatePullRequest).not.toHaveBeenCalled()
			expect(result.createComment).not.toHaveBeenCalled()
			expect(result.addLabels).not.toHaveBeenCalled()
			expect(result.removeLabel).not.toHaveBeenCalled()
		})

		it("closes from the created_at floor when no other author activity exists", async () => {
			const result = await runStaleStep({
				prCreatedDaysAgo: 70,
				labels: ["stale-inactive"],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-inactive" }],
			})
			expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
		})
	})

	describe("policy label swaps", () => {
		it("swaps stale-inactive for stale-awaiting-author when the awaiting-author clock applies first", async () => {
			const result = await runStaleStep({
				labels: ["awaiting-author", "stale-inactive"],
				comments: [{ login: "contributor", daysAgo: 15 }],
			})
			expect(removedLabels(result)).toEqual(["stale-inactive"])
			expect(addedLabels(result)).toEqual(["stale-awaiting-author"])
			expect(commentBodies(result)).toHaveLength(1)
			expect(commentBodies(result)[0]).toContain("awaiting author changes for 14 days")
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("keeps the awaiting-author close policy while its stale label outlives 60 idle days", async () => {
			const result = await runStaleStep({
				labels: ["stale-awaiting-author"],
				comments: [{ login: "contributor", daysAgo: 70 }],
				timeline: [{ event: "labeled", daysAgo: 30, label: "stale-awaiting-author" }],
			})
			expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
		})

		it("closes on the preserved warning after awaiting-author flaps off past 21 days", async () => {
			const result = await runStaleStep({
				labels: ["stale-awaiting-author"],
				comments: [{ login: "contributor", daysAgo: 22 }],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-awaiting-author" }],
			})
			expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
			expect(commentBodies(result)[0]).toContain("author inactivity after requested changes")
		})

		it("never closes a preserved warning whose labeled age cannot be verified", async () => {
			const result = await runStaleStep({
				labels: ["stale-awaiting-author"],
				comments: [{ login: "contributor", daysAgo: 40 }],
			})
			expect(result.updatePullRequest).not.toHaveBeenCalled()
			expect(result.createComment).not.toHaveBeenCalled()
			expect(result.addLabels).not.toHaveBeenCalled()
			expect(result.removeLabel).not.toHaveBeenCalled()
		})

		it("clears the preserved warning as soon as the author becomes active again", async () => {
			const result = await runStaleStep({
				labels: ["stale-awaiting-author"],
				comments: [{ login: "contributor", daysAgo: 5 }],
			})
			expect(removedLabels(result)).toEqual(["stale-awaiting-author"])
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("keeps stale-awaiting-author through an awaiting-author flap while inactivity stays at or past 14 days", async () => {
			const result = await runStaleStep({
				labels: ["stale-awaiting-author"],
				comments: [{ login: "contributor", daysAgo: 15 }],
			})
			expect(result.addLabels).not.toHaveBeenCalled()
			expect(result.removeLabel).not.toHaveBeenCalled()
			expect(result.createComment).not.toHaveBeenCalled()
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})
	})

	describe("bot-authored PRs", () => {
		const botFixture = {
			authorLogin: "zoomote[bot]",
			userType: "Bot" as const,
			// Bot-applied commits use a different login, so no commit ever
			// matches the PR author login.
			commits: [{ authorLogin: "roomote", daysAgo: 1 }],
		}

		it("never marks or closes a bot-authored PR however old it gets", async () => {
			const result = await runStaleStep({ ...botFixture, prCreatedDaysAgo: 200 })
			expect(result.listComments).not.toHaveBeenCalled()
			expect(result.listCommits).not.toHaveBeenCalled()
			expect(result.addLabels).not.toHaveBeenCalled()
			expect(result.removeLabel).not.toHaveBeenCalled()
			expect(result.createComment).not.toHaveBeenCalled()
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("clears leftover stale labels from a bot-authored PR when writes are enabled", async () => {
			const result = await runStaleStep({ ...botFixture, labels: ["stale-awaiting-author"] })
			expect(removedLabels(result)).toEqual(["stale-awaiting-author"])
			expect(result.addLabels).not.toHaveBeenCalled()
			expect(result.createComment).not.toHaveBeenCalled()
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("only proposes the stale-label cleanup for a bot-authored PR in dry run", async () => {
			const result = await runStaleStep({ ...botFixture, labels: ["stale-awaiting-author"], dryRun: true })
			expect(result.removeLabel).not.toHaveBeenCalled()
			expect(result.addLabels).not.toHaveBeenCalled()
			expect(
				result.info.mock.calls.some(([message]) =>
					String(message).includes("[dry-run] would remove label stale-awaiting-author"),
				),
			).toBe(true)
		})

		it("still marks an ordinary human PR with the same old dates", async () => {
			const result = await runStaleStep({
				authorLogin: "zoomote-fan",
				commits: [{ authorLogin: "roomote", daysAgo: 100 }],
				prCreatedDaysAgo: 200,
			})
			expect(addedLabels(result)).toEqual(["stale-inactive"])
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})
	})

	describe("maintainer handoff", () => {
		const handoffFixture = {
			labels: ["awaiting-maintainer", "stale-awaiting-author"],
			comments: [{ login: "contributor", daysAgo: 22 }],
			timeline: [{ event: "labeled", daysAgo: 10, label: "stale-awaiting-author" }],
		}

		it("stops the 14-day close clock once the maintainer queue owns the PR", async () => {
			const result = await runStaleStep(handoffFixture)
			expect(result.updatePullRequest).not.toHaveBeenCalled()
			expect(result.createComment).not.toHaveBeenCalled()
			expect(removedLabels(result)).toEqual(["stale-awaiting-author"])
			expect(result.addLabels).not.toHaveBeenCalled()
		})

		it("does not close at the 21-day boundary once the maintainer queue owns the PR", async () => {
			const result = await runStaleStep({
				...handoffFixture,
				comments: [{ login: "contributor", daysAgo: 21 }],
			})
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("keeps the promised close clock across a conflict flap that never reached the maintainer queue", async () => {
			const result = await runStaleStep({
				labels: ["has-conflicts", "stale-awaiting-author"],
				comments: [{ login: "contributor", daysAgo: 22 }],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-awaiting-author" }],
			})
			expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
			expect(commentBodies(result)[0]).toContain("author inactivity after requested changes")
		})

		it("clears the retired warning when the author responds after a maintainer handoff", async () => {
			const result = await runStaleStep({
				...handoffFixture,
				comments: [{ login: "contributor", daysAgo: 5 }],
			})
			expect(removedLabels(result)).toEqual(["stale-awaiting-author"])
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("falls back to the ordinary 60-day stale clock after a maintainer handoff", async () => {
			const result = await runStaleStep({
				labels: ["awaiting-maintainer", "stale-awaiting-author"],
				comments: [{ login: "contributor", daysAgo: 61 }],
			})
			expect(removedLabels(result)).toEqual(["stale-awaiting-author"])
			expect(addedLabels(result)).toEqual(["stale-inactive"])
			expect(commentBodies(result)).toHaveLength(1)
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("closes on the ordinary 67-day clock after a maintainer handoff", async () => {
			const result = await runStaleStep({
				labels: ["awaiting-maintainer", "stale-awaiting-author", "stale-inactive"],
				comments: [{ login: "contributor", daysAgo: 70 }],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-inactive" }],
			})
			expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
			expect(commentBodies(result)[0]).toContain("60+ days of inactivity")
		})
	})

	describe("author clock attribution", () => {
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
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-inactive" }],
			})
			expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
			expect(commentBodies(result).some((body) => body.includes("60+ days of inactivity"))).toBe(true)
		})

		it("matches author logins case-insensitively across comments, reviews, and commits", async () => {
			const comment = await runStaleStep({
				labels: ["awaiting-author", "stale-awaiting-author"],
				comments: [{ login: "Contributor", daysAgo: 20 }],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-awaiting-author" }],
			})
			expect(comment.updatePullRequest).not.toHaveBeenCalled()

			const review = await runStaleStep({
				labels: ["awaiting-author", "stale-awaiting-author"],
				reviews: [{ login: "CONTRIBUTOR", daysAgo: 16 }],
				comments: [{ login: "maintainer", daysAgo: 1 }],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-awaiting-author" }],
			})
			expect(review.updatePullRequest).not.toHaveBeenCalled()

			const commit = await runStaleStep({
				labels: ["stale-inactive"],
				commits: [{ authorLogin: "ConTriButor", daysAgo: 65 }],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-inactive" }],
			})
			expect(commit.updatePullRequest).not.toHaveBeenCalled()
		})

		it("ignores a maintainer review when the author has been inactive", async () => {
			const result = await runStaleStep({
				labels: ["stale-inactive"],
				commits: [{ authorLogin: "contributor", daysAgo: 100 }],
				reviews: [{ login: "maintainer", daysAgo: 1 }],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-inactive" }],
			})
			expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
		})

		it("counts committer-login matches so an author rebase moves the clock", async () => {
			const result = await runStaleStep({
				labels: ["stale-awaiting-author"],
				commits: [
					{
						authorLogin: null,
						committerLogin: "contributor",
						authorDateDaysAgo: 100,
						committerDateDaysAgo: 5,
					},
				],
			})
			expect(removedLabels(result)).toEqual(["stale-awaiting-author"])
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("does not let a maintainer rebase reset the clock through the committer date", async () => {
			const result = await runStaleStep({
				labels: ["stale-inactive"],
				commits: [
					{
						authorLogin: "contributor",
						committerLogin: "maintainer",
						authorDateDaysAgo: 100,
						committerDateDaysAgo: 1,
					},
				],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-inactive" }],
			})
			expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
		})

		it("ignores unlinked commits with no author or committer login", async () => {
			const result = await runStaleStep({
				labels: ["awaiting-author", "stale-awaiting-author"],
				comments: [{ login: "contributor", daysAgo: 15 }],
				commits: [{ authorLogin: null, committerLogin: null, daysAgo: 2 }],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-awaiting-author" }],
			})
			expect(result.removeLabel).not.toHaveBeenCalled()
			expect(result.addLabels).not.toHaveBeenCalled()
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("reconciles a PR with a null user from the created_at floor alone", async () => {
			const result = await runStaleStep({
				authorLogin: null,
				commits: [{ authorLogin: "someone-else", daysAgo: 1 }],
			})
			expect(addedLabels(result)).toEqual(["stale-inactive"])
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("counts a ready_for_review event the author marked as author activity", async () => {
			const result = await runStaleStep({
				labels: ["stale-inactive"],
				commits: [{ authorLogin: "contributor", daysAgo: 100 }],
				timeline: [{ event: "ready_for_review", daysAgo: 10, actor: "contributor" }],
			})
			expect(result.updatePullRequest).not.toHaveBeenCalled()
			expect(removedLabels(result)).toEqual(["stale-inactive"])
		})

		it("ignores a ready_for_review event marked by someone else", async () => {
			const result = await runStaleStep({
				labels: ["stale-inactive"],
				commits: [{ authorLogin: "contributor", daysAgo: 100 }],
				timeline: [
					{ event: "ready_for_review", daysAgo: 1, actor: "maintainer" },
					{ event: "labeled", daysAgo: 10, label: "stale-inactive" },
				],
			})
			expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
		})

		it("ignores timeline events that are not ready_for_review", async () => {
			const result = await runStaleStep({
				labels: ["stale-inactive"],
				commits: [{ authorLogin: "contributor", daysAgo: 100 }],
				timeline: [
					{ event: "review_requested", daysAgo: 1, actor: "maintainer" },
					{ event: "milestoned", daysAgo: 1 },
					{ event: "labeled", daysAgo: 10, label: "stale-inactive" },
				],
			})
			expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
		})

		it("counts an author review as author activity", async () => {
			const result = await runStaleStep({
				labels: ["stale-awaiting-author"],
				reviews: [{ login: "contributor", daysAgo: 3 }],
			})
			expect(result.updatePullRequest).not.toHaveBeenCalled()
			expect(removedLabels(result)).toEqual(["stale-awaiting-author"])
		})

		it.each(["do-not-close", "pinned", "work-in-progress"])(
			"clears stale labels from a %s PR but never closes it",
			async (exemptLabel) => {
				const result = await runStaleStep({
					labels: [exemptLabel, "stale-inactive"],
					commits: [{ authorLogin: "contributor", daysAgo: 200 }],
					timeline: [{ event: "labeled", daysAgo: 30, label: "stale-inactive" }],
				})
				expect(removedLabels(result)).toEqual(["stale-inactive"])
				expect(result.updatePullRequest).not.toHaveBeenCalled()
			},
		)

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

	describe("API budget", () => {
		it("skips young PRs without stale labels before any list call", async () => {
			const result = await runStaleStep({
				prCreatedDaysAgo: 10,
				comments: [{ login: "someone", daysAgo: 1 }],
			})
			expect(result.listComments).not.toHaveBeenCalled()
			expect(result.listEventsForTimeline).not.toHaveBeenCalled()
			expect(result.listCommits).not.toHaveBeenCalled()
			expect(result.listReviews).not.toHaveBeenCalled()
			expect(result.addLabels).not.toHaveBeenCalled()
			expect(result.removeLabel).not.toHaveBeenCalled()
		})

		it("skips young awaiting-author PRs before any list call", async () => {
			const result = await runStaleStep({
				prCreatedDaysAgo: 10,
				labels: ["awaiting-author"],
			})
			expect(result.listComments).not.toHaveBeenCalled()
			expect(result.listEventsForTimeline).not.toHaveBeenCalled()
		})

		it("passes the policy window as since to listComments", async () => {
			const awaiting = await runStaleStep({
				labels: ["awaiting-author"],
				comments: [{ login: "contributor", daysAgo: 15 }],
			})
			expect(daysSince(awaiting.listComments.mock.calls[0][0].since)).toBeCloseTo(21, 5)

			const ordinary = await runStaleStep({
				commits: [{ authorLogin: "contributor", daysAgo: 61 }],
			})
			expect(daysSince(ordinary.listComments.mock.calls[0][0].since)).toBeCloseTo(67, 5)
		})

		it("skips the commit and review scans when seen author activity already precludes stale action", async () => {
			const result = await runStaleStep({
				comments: [{ login: "contributor", daysAgo: 3 }],
				commits: [{ authorLogin: "contributor", daysAgo: 100 }],
				reviews: [{ login: "contributor", daysAgo: 100 }],
			})
			expect(result.listCommits).not.toHaveBeenCalled()
			expect(result.listRepoCommits).not.toHaveBeenCalled()
			expect(result.listReviews).not.toHaveBeenCalled()
			expect(result.addLabels).not.toHaveBeenCalled()
			expect(result.removeLabel).not.toHaveBeenCalled()
		})

		it("uses the head SHA commits endpoint for PRs above the 250 commit cap", async () => {
			const result = await runStaleStep({
				prCommitCount: 300,
				labels: ["stale-inactive"],
				commits: [{ authorLogin: "contributor", daysAgo: 100 }],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-inactive" }],
			})
			expect(result.listRepoCommits).toHaveBeenCalledTimes(1)
			const args = result.listRepoCommits.mock.calls[0][0]
			expect(args.sha).toBe(SHA)
			expect(daysSince(args.since)).toBeCloseTo(67, 5)
			expect(result.listCommits).not.toHaveBeenCalled()
			expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
		})

		it("uses the pull request commits endpoint for PRs within the 250 commit cap", async () => {
			const result = await runStaleStep({
				labels: ["stale-inactive"],
				commits: [{ authorLogin: "contributor", daysAgo: 100 }],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-inactive" }],
			})
			expect(result.listCommits).toHaveBeenCalledTimes(1)
			expect(result.listRepoCommits).not.toHaveBeenCalled()
		})
	})

	describe("commit scan paging", () => {
		const junkCommits = (count: number, daysAgo: number) =>
			Array.from({ length: count }, () => ({ authorLogin: null, committerLogin: null, daysAgo }))

		it("keeps paging the oldest-first PR commit list until it has seen the newest commits", async () => {
			const result = await runStaleStep({
				prCreatedDaysAgo: 200,
				commits: [
					...junkCommits(100, 200),
					...junkCommits(49, 200),
					{ authorLogin: "contributor", daysAgo: 3 },
				],
			})
			expect(result.listCommits).toHaveBeenCalledTimes(2)
			expect(result.addLabels).not.toHaveBeenCalled()
			expect(result.removeLabel).not.toHaveBeenCalled()
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("stops the newest-first head walk once a page dips past the policy window", async () => {
			const result = await runStaleStep({
				prCommitCount: 300,
				labels: ["stale-inactive"],
				commits: [{ authorLogin: "contributor", daysAgo: 3 }, ...junkCommits(99, 70)],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-inactive" }],
			})
			expect(result.listRepoCommits).toHaveBeenCalledTimes(1)
			expect(removedLabels(result)).toEqual(["stale-inactive"])
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("keeps the newest-first head walk going while a page stays inside the policy window", async () => {
			const result = await runStaleStep({
				prCommitCount: 300,
				labels: ["stale-inactive"],
				commits: [...junkCommits(100, 30), { authorLogin: "contributor", daysAgo: 3 }],
				timeline: [{ event: "labeled", daysAgo: 10, label: "stale-inactive" }],
			})
			expect(result.listRepoCommits).toHaveBeenCalledTimes(2)
			expect(removedLabels(result)).toEqual(["stale-inactive"])
			expect(result.updatePullRequest).not.toHaveBeenCalled()
		})

		it("falls back to the PR commit endpoint when the head walk fails", async () => {
			const result = await runStaleStep({
				prCommitCount: 300,
				commits: [{ authorLogin: "contributor", daysAgo: 3 }],
				failures: { listRepoCommits: { status: 404, message: "No commit found for SHA" } },
			})
			expect(result.listRepoCommits).toHaveBeenCalledTimes(1)
			expect(result.listCommits).toHaveBeenCalledTimes(1)
			expect(result.warning).toHaveBeenCalledWith(
				expect.stringContaining("falling back to the PR commit endpoint"),
			)
			expect(result.addLabels).not.toHaveBeenCalled()
		})
	})

	describe("write ordering and failures", () => {
		it("closes before posting the close comment", async () => {
			const result = await runStaleStep(closableFixture)
			expect(result.updatePullRequest).toHaveBeenCalledTimes(1)
			expect(result.createComment).toHaveBeenCalledTimes(1)
			expect(result.updatePullRequest.mock.invocationCallOrder[0]).toBeLessThan(
				result.createComment.mock.invocationCallOrder[0],
			)
		})

		it("posts the stale warning before applying the stale label", async () => {
			const result = await runStaleStep({
				commits: [{ authorLogin: "contributor", daysAgo: 61 }],
			})
			expect(result.createComment).toHaveBeenCalledTimes(1)
			expect(result.addLabels).toHaveBeenCalledTimes(1)
			expect(result.createComment.mock.invocationCallOrder[0]).toBeLessThan(
				result.addLabels.mock.invocationCallOrder[0],
			)
		})

		it("tolerates a 404 when removing a stale label", async () => {
			const result = await runStaleStep({
				labels: ["stale-awaiting-author"],
				comments: [{ login: "contributor", daysAgo: 5 }],
				failures: { removeLabel: { status: 404, message: "Label not found" } },
			})
			expect(removedLabels(result)).toEqual(["stale-awaiting-author"])
		})

		it("fails the step when a stale label removal rejects with a server error", async () => {
			const result = await runStaleStep({
				labels: ["stale-awaiting-author"],
				comments: [{ login: "contributor", daysAgo: 5 }],
				failures: { removeLabel: { status: 500, message: "internal error" } },
				allowFailure: true,
			})
			expect(result.setFailed).toHaveBeenCalledWith("Failed to reconcile stale state for PR #28: internal error")
		})

		it("posts no close comment when the close write fails", async () => {
			const result = await runStaleStep({
				...closableFixture,
				failures: { updatePullRequest: { status: 422, message: "cannot close" } },
				allowFailure: true,
			})
			expect(result.setFailed).toHaveBeenCalledWith("Failed to reconcile stale state for PR #28: cannot close")
			expect(result.createComment).not.toHaveBeenCalled()
		})

		it("applies no stale label when the warning comment fails", async () => {
			const result = await runStaleStep({
				commits: [{ authorLogin: "contributor", daysAgo: 61 }],
				failures: { createComment: { status: 500, message: "comment rejected" } },
				allowFailure: true,
			})
			expect(result.setFailed).toHaveBeenCalledWith(
				"Failed to reconcile stale state for PR #28: comment rejected",
			)
			expect(result.addLabels).not.toHaveBeenCalled()
		})

		it("leaves the warning comment behind when the label write fails, so the next sweep reposts it", async () => {
			const result = await runStaleStep({
				commits: [{ authorLogin: "contributor", daysAgo: 61 }],
				failures: { addLabels: { status: 500, message: "label rejected" } },
				allowFailure: true,
			})
			expect(result.createComment).toHaveBeenCalledTimes(1)
			expect(result.addLabels).toHaveBeenCalledTimes(1)
			expect(result.setFailed).toHaveBeenCalledWith("Failed to reconcile stale state for PR #28: label rejected")
		})

		it.each(["listComments", "listEventsForTimeline"] as const)(
			"writes nothing when %s rejects",
			async (listCall) => {
				const failures: StaleFailures =
					listCall === "listComments"
						? { listComments: { status: 500, message: "list failed" } }
						: { listEventsForTimeline: { status: 500, message: "list failed" } }
				const result = await runStaleStep({
					...closableFixture,
					failures,
					allowFailure: true,
				})
				expect(result.setFailed).toHaveBeenCalledWith("Failed to reconcile stale state for PR #28: list failed")
				expect(result.addLabels).not.toHaveBeenCalled()
				expect(result.removeLabel).not.toHaveBeenCalled()
				expect(result.createComment).not.toHaveBeenCalled()
				expect(result.updatePullRequest).not.toHaveBeenCalled()
			},
		)
	})
})
