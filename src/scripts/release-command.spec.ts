import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const releaseCommand = fs.readFileSync(path.join(repositoryRoot, ".roo/commands/release.md"), "utf8")
const topLevelSteps = [...releaseCommand.matchAll(/^(\d+)\. .+$/gm)]
const finalStepStart = topLevelSteps.find((step) => step[1] === "15")?.index ?? -1
const finalStep = releaseCommand.slice(finalStepStart)

describe("stable release command documentation handoff", () => {
	it("keeps the docs PR as final step 15 after publication and the release merge queue", () => {
		expect(topLevelSteps.map((step) => Number(step[1])).at(-1)).toBe(15)
		expect(finalStepStart).toBeGreaterThan(releaseCommand.indexOf("14. After a successful deployment"))
		expect(finalStep).toMatch(/only after[\s\S]*marketplace workflow[\s\S]*exact stable tag[\s\S]*succeeded/i)
		expect(finalStep).toMatch(/GitHub release exists/i)
		expect(finalStep).toMatch(/step 14[\s\S]*merge queue/i)
		expect(finalStep).toMatch(/final stable extension release step/i)
		expect(finalStep).toMatch(/does not apply to nightly, CLI, npm, or types releases/i)
	})

	it("targets a separate Zoo-Code-Docs PR with the required branch and PR conventions", () => {
		expect(finalStep).toContain("Zoo-Code-Org/Zoo-Code-Docs")
		expect(finalStep).toContain("docs/release-v[version]")
		expect(finalStep).toContain("docs(release): document v[version]")
		expect(finalStep).toContain("[Docs] Update documentation for Zoo Code v[version]")
		expect(finalStep).toMatch(/base `main`/i)
		expect(finalStep).toMatch(/separate docs PR[\s\S]*will not be auto-merged/i)
		expect(finalStep).toMatch(/Never enable auto-merge/i)
	})

	it("requires release notes, navigation registration, and evergreen documentation review", () => {
		expect(finalStep).toContain("docs/update-notes/v[version].md")
		expect(finalStep).toContain("docs/update-notes/index.md")
		expect(finalStep).toContain("sidebars.ts")
		expect(finalStep).toMatch(/newest-first/i)
		expect(finalStep).toMatch(/per-PR documentation impact matrix/i)
		expect(finalStep).toMatch(/every user-visible change/i)
		expect(finalStep).toMatch(/canonical evergreen provider, feature, tool, and getting-started pages/i)
		expect(finalStep).toMatch(/implementation-only exclusion/i)
		expect(finalStep).toMatch(/no-change rationale/i)
	})

	it("synchronizes the sole docs package version without tags or lockfile drift", () => {
		expect(finalStep).toContain('pnpm version "$VERSION" --no-git-tag-version --allow-same-version')
		expect(finalStep).toMatch(/sole package version in `package\.json`/i)
		expect(finalStep).toMatch(/no tag/i)
		expect(finalStep).toMatch(/no incidental `pnpm-lock\.yaml` change/i)
		expect(finalStep).toMatch(/never downgrade/i)
	})

	it("protects existing checkouts and establishes an exact clean origin/main base", () => {
		expect(finalStep).toContain("../Zoo-Code-Docs")
		expect(finalStep).toContain("https://github.com/Zoo-Code-Org/Zoo-Code-Docs.git")
		expect(finalStep).toMatch(/clean temporary directory/i)
		expect(finalStep).toMatch(/read `AGENTS\.md` and `\.roorules`/i)
		expect(finalStep).toMatch(/abort if the worktree is dirty/i)
		expect(finalStep).toMatch(/verify `origin`[\s\S]*default branch is `main`/i)
		expect(finalStep).toContain("git merge --ff-only origin/main")
		expect(finalStep).toMatch(/Never stash or reset[\s\S]*never change remotes/i)
	})

	it("handles merged, open, and branch-only prior attempts without unsafe pushes", () => {
		expect(finalStep).toMatch(
			/query the local branch, the remote branch, and all matching open, closed, and merged PRs/i,
		)
		expect(finalStep).toMatch(/matching merged PR[\s\S]*complete/i)
		expect(finalStep).toMatch(/Reuse and validate a matching open PR/i)
		expect(finalStep).toMatch(/branch without a PR only when[\s\S]*expected release-docs work/i)
		expect(finalStep).toMatch(/closed-unmerged PR[\s\S]*wrong repository or base[\s\S]*divergence/i)
		expect(finalStep).toMatch(/Never force-push blindly/i)
		expect(finalStep).toMatch(/stop on any remote race/i)
	})

	it("runs every docs validation and blocks on newly introduced content warnings", () => {
		const validationCommands = [
			"mise install",
			"pnpm install --frozen-lockfile",
			"pnpm run check-types",
			"pnpm run lint",
			"pnpm run lint:unused",
			"pnpm run build",
			"git diff --check",
		]

		for (const command of validationCommands) expect(finalStep).toContain(command)
		expect(finalStep).toMatch(/Inspect build warnings explicitly/i)
		expect(finalStep).toMatch(
			/Block the PR on newly introduced broken-link, document, MDX, sidebar, or content warnings/i,
		)
		expect(finalStep).toMatch(/changed and staged scope[\s\S]*no generated output/i)
	})

	it("verifies local auth and permissions without assuming cross-repository token access", () => {
		expect(finalStep).toContain("gh auth status")
		expect(finalStep).toMatch(/access and push permission/i)
		expect(finalStep).toMatch(/Do not assume or claim that `GITHUB_TOKEN` has cross-repository access/i)
	})

	it("retains source metadata and specifies partial-failure and final reporting", () => {
		expect(finalStep).toMatch(/exact Zoo Code changelog section/i)
		expect(finalStep).toMatch(/complete merged-PR inventory/i)
		expect(finalStep).toMatch(
			/release PR URL[\s\S]*GitHub release URL[\s\S]*workflow URL[\s\S]*publication timestamp/i,
		)
		expect(finalStep).toMatch(/Docs failure cannot roll back or invalidate the published extension/i)
		expect(finalStep).toContain("Zoo Code v[version] is already published and docs PR completion is pending.")
		expect(finalStep).toMatch(/failed checkpoint, checkout path, branch, PR URL\/state[\s\S]*safe recovery action/i)
		expect(finalStep).toMatch(/final release report[\s\S]*release\/tag\/workflow URLs/i)
		expect(finalStep).toMatch(/docs PR URL\/state[\s\S]*docs branch and commit SHA/i)
		expect(finalStep).toMatch(/release-note\/index\/sidebar status[\s\S]*evergreen documentation status/i)
		expect(finalStep).toMatch(/confirmation that the separate docs PR was not auto-merged/i)
	})
})
