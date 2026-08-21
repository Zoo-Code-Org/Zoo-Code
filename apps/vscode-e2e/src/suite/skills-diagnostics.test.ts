import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"

import * as vscode from "vscode"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const GOOD_SKILL = "e2e-skill-good"
const BAD_SKILL = "e2e-skill-bad"

// Issue #859 reproduction content: unescaped double quotes in the description
// make the YAML frontmatter unparseable.
const MALFORMED_SKILL_MD = `---
name: ${BAD_SKILL}
description: Use when implementing features. Triggers on: "TDD", "test-driven development"
---

# E2E Skill Bad

Instructions here.
`

const FIXED_SKILL_MD = `---
name: ${BAD_SKILL}
description: 'Use when implementing features. Triggers on: "TDD", "test-driven development"'
---

# E2E Skill Bad

Instructions here.
`

const GOOD_SKILL_MD = `---
name: ${GOOD_SKILL}
description: A healthy skill used by the skill diagnostics e2e smoke test.
---

# E2E Skill Good

Instructions here.
`

suite("Roo Code Skill Diagnostics", function () {
	setDefaultSuiteTimeout(this)

	let skillsRoot: string

	setup(async function () {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		assert.ok(workspaceRoot, "e2e workspace folder must be open")
		skillsRoot = path.join(workspaceRoot, ".roo", "skills")
	})

	teardown(async function () {
		await fs.rm(skillsRoot, { recursive: true, force: true })
	})

	test("should surface a malformed SKILL.md as a diagnostic without hiding healthy skills", async function () {
		this.timeout(180_000)

		// Arrange: one healthy skill and one malformed skill on real disk in the
		// workspace's .roo/skills directory.
		await fs.mkdir(path.join(skillsRoot, GOOD_SKILL), { recursive: true })
		await fs.writeFile(path.join(skillsRoot, GOOD_SKILL, "SKILL.md"), GOOD_SKILL_MD, "utf8")
		await fs.mkdir(path.join(skillsRoot, BAD_SKILL), { recursive: true })
		await fs.writeFile(path.join(skillsRoot, BAD_SKILL, "SKILL.md"), MALFORMED_SKILL_MD, "utf8")

		// Act: the extension host's file watcher re-discovers skills; wait until
		// the real SkillsManager reports the healthy skill and a diagnostic for
		// the malformed one.
		await waitFor(
			async () => {
				const state = globalThis.api.getSkillsState()
				const goodVisible = state.skills.some((skill) => skill.name === GOOD_SKILL)
				const badDiagnosed = state.skillDiagnostics.some((diagnostic) => diagnostic.path.includes(BAD_SKILL))
				return goodVisible && badDiagnosed
			},
			{ timeout: 60_000, interval: 500 },
		)

		// Assert: the malformed skill is skipped with a diagnostic pointing at it,
		// while the healthy skill is unaffected.
		const state = globalThis.api.getSkillsState()
		const diagnostic = state.skillDiagnostics.find((d) => d.path.includes(BAD_SKILL))
		assert.ok(diagnostic, "malformed SKILL.md should produce a diagnostic")
		assert.strictEqual(diagnostic.source, "project")
		assert.ok(diagnostic.message.length > 0, "diagnostic should carry the parse error message")
		assert.ok(
			state.skills.some((skill) => skill.name === GOOD_SKILL),
			"healthy skill should still be discovered",
		)
		assert.ok(
			!state.skills.some((skill) => skill.name === BAD_SKILL),
			"malformed skill should be omitted from skills",
		)

		// Act: repair the frontmatter in place; the watcher re-discovers and the
		// diagnostic clears.
		await fs.writeFile(path.join(skillsRoot, BAD_SKILL, "SKILL.md"), FIXED_SKILL_MD, "utf8")

		await waitFor(
			async () => {
				const next = globalThis.api.getSkillsState()
				const cleared = !next.skillDiagnostics.some((d) => d.path.includes(BAD_SKILL))
				const loaded = next.skills.some((skill) => skill.name === BAD_SKILL)
				return cleared && loaded
			},
			{ timeout: 60_000, interval: 500 },
		)

		const fixed = globalThis.api.getSkillsState()
		assert.ok(
			fixed.skills.some((skill) => skill.name === BAD_SKILL),
			"fixed skill should load after repair",
		)
		assert.ok(fixed.skills.find((skill) => skill.name === BAD_SKILL)?.description.includes("TDD") === true)
	})
})
