import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/code-qa.yml"), "utf8")
const extensionTurbo = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "src/turbo.json"), "utf8"))

const workflowStep = (name) => {
	const match = workflow.match(new RegExp(`- name: ${name}\\n(?<body>(?:\\s{14,}.*\\n?)*)`))
	assert.ok(match?.groups?.body, `missing workflow step: ${name}`)
	return match.groups.body
}

describe("platform unit-test workflow", () => {
	it("keeps coverage authoritative on Ubuntu and runs equivalent uninstrumented Windows tests", () => {
		assert.match(workflow, /name: ubuntu-latest[\s\S]*?collect-coverage: true/)
		assert.match(workflow, /name: windows-latest[\s\S]*?collect-coverage: false/)
		assert.ok(!workflow.includes("matrix.upload-coverage"))

		const extensionCoverage = workflowStep("Run extension coverage lanes")
		assert.match(extensionCoverage, /if: matrix\.collect-coverage/)
		assert.ok(extensionCoverage.includes("test:coverage:api test:coverage:core"))

		const extensionTests = workflowStep("Run extension test lanes")
		assert.match(extensionTests, /if: \$\{\{ !matrix\.collect-coverage \}\}/)
		assert.ok(extensionTests.includes("test:api test:core test:services test:misc test:tree-sitter"))

		for (const [stepName, command] of [
			["Run non-extension package coverage", 'test:coverage --filter="!@roo-code/core" --filter="!zoo-code"'],
			["Run core unit coverage", 'test:coverage:unit --filter="@roo-code/core"'],
			["Run core integration coverage", 'test:coverage:integration --filter="@roo-code/core"'],
		]) {
			const body = workflowStep(stepName)
			assert.ok(!body.includes("if:"), `${stepName} must retain its cache-compatible task on both platforms`)
			assert.ok(body.includes(command), `missing command in step: ${stepName}`)
		}
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

	it("keeps plain extension lanes aligned with coverage cache boundaries", () => {
		for (const lane of ["api", "core", "services", "misc", "tree-sitter"]) {
			const plainTask = extensionTurbo.tasks[`test:${lane}`]
			const coverageTask = extensionTurbo.tasks[`test:coverage:${lane}`]

			assert.deepEqual(plainTask.dependsOn, coverageTask.dependsOn)
			assert.deepEqual(plainTask.inputs, coverageTask.inputs)
		}
	})
})
