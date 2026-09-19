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

const parseWorkflowStep = (name) => {
	const body = workflowStep(name)
	const field = (key) => {
		const line = body.split("\n").find((line) => line.trimStart().startsWith(`${key}:`))
		assert.ok(line, `missing ${key} field in workflow step: ${name}`)
		return line.slice(line.indexOf(":") + 1).trim()
	}
	return { if: field("if"), run: field("run") }
}

describe("platform unit-test workflow", () => {
	it("keeps coverage authoritative on Ubuntu and runs equivalent uninstrumented Windows tests", () => {
		assert.match(workflow, /name: ubuntu-latest[\s\S]*?collect-coverage: true/)
		assert.match(workflow, /name: windows-latest[\s\S]*?collect-coverage: false/)
		assert.ok(!workflow.includes("matrix.upload-coverage"))

		assert.deepEqual(parseWorkflowStep("Run extension coverage lanes"), {
			if: "matrix.collect-coverage",
			run: 'pnpm turbo run test:coverage:api test:coverage:core test:coverage:services test:coverage:misc test:coverage:tree-sitter --filter="zoo-code" --concurrency=2 --log-order grouped --output-logs new-only',
		})

		assert.deepEqual(parseWorkflowStep("Run extension test lanes"), {
			if: "${{ !matrix.collect-coverage }}",
			run: 'pnpm turbo run test:api test:core test:services test:misc test:tree-sitter --filter="zoo-code" --concurrency=2 --log-order grouped --output-logs new-only',
		})

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
