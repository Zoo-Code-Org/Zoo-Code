import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/code-qa.yml"), "utf8")

const workflowStep = (name) => {
	const match = workflow.match(new RegExp(`- name: ${name}\\n(?<body>(?:\\s{14,}.*\\n?)*)`))
	assert.ok(match?.groups?.body, `missing workflow step: ${name}`)
	return match.groups.body
}

describe("platform unit-test workflow", () => {
	it("keeps coverage authoritative on Ubuntu and runs equivalent uninstrumented Windows tests", () => {
		assert.match(workflow, /name: ubuntu-latest[\s\S]*?collect-coverage: true/)
		assert.match(workflow, /name: windows-latest[\s\S]*?collect-coverage: false/)

		for (const lane of ["api", "core", "services", "misc", "tree-sitter"]) {
			assert.ok(workflow.includes(`test:coverage:${lane}`), `missing ${lane} coverage lane`)
		}

		assert.ok(workflow.includes('test:coverage --filter="!@roo-code/core" --filter="!zoo-code"'))
		assert.ok(workflow.includes('test --filter="!@roo-code/core" --filter="!zoo-code"'))
		assert.ok(workflow.includes('test:unit --filter="zoo-code"'))
		assert.ok(workflow.includes('test:coverage:unit --filter="@roo-code/core"'))
		assert.ok(workflow.includes('test:unit --filter="@roo-code/core"'))
		assert.ok(workflow.includes('test:coverage:integration --filter="@roo-code/core"'))
		assert.ok(workflow.includes('test:integration --filter="@roo-code/core"'))
	})

	it("does not run coverage verification or uploads on Windows", () => {
		for (const stepName of [
			"Verify extension coverage contract",
			"Verify extension coverage reports",
			"Merge extension coverage reports",
			"Verify coverage cache inputs",
			"Upload non-core coverage to Codecov",
			"Upload webview JSDOM coverage to Codecov",
			"Upload core unit coverage to Codecov",
			"Upload core integration coverage to Codecov",
			"Upload coverage reports to GitHub",
		]) {
			assert.match(workflowStep(stepName), /if: matrix\.collect-coverage/)
		}
	})
})
