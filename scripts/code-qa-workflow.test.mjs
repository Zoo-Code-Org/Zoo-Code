import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const workflow = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/code-qa.yml"), "utf8")
const extensionTurbo = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "src/turbo.json"), "utf8"))
const coreTurbo = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "packages/core/turbo.json"), "utf8"))

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

		for (const [coverageStepName, plainStepName, coverageCommand, plainCommand] of [
			[
				"Run non-extension package coverage",
				"Run non-extension package tests",
				'test:coverage --filter="!@roo-code/core" --filter="!zoo-code"',
				'test --filter="!@roo-code/core" --filter="!zoo-code"',
			],
			[
				"Run core unit coverage",
				"Run core unit tests",
				'test:coverage:unit --filter="@roo-code/core"',
				'test:unit --filter="@roo-code/core"',
			],
			[
				"Run core integration coverage",
				"Run core integration tests",
				'test:coverage:integration --filter="@roo-code/core"',
				'test:integration --filter="@roo-code/core"',
			],
		]) {
			const coverageStep = parseWorkflowStep(coverageStepName)
			assert.equal(coverageStep.if, "matrix.collect-coverage")
			assert.ok(coverageStep.run.includes(coverageCommand), `missing command in step: ${coverageStepName}`)

			const plainStep = parseWorkflowStep(plainStepName)
			assert.equal(plainStep.if, "${{ !matrix.collect-coverage }}")
			assert.ok(plainStep.run.includes(plainCommand), `missing command in step: ${plainStepName}`)
			assert.ok(!plainStep.run.includes("--coverage"), `${plainStepName} must not collect coverage on Windows`)
		}

		assert.ok(!workflowStep("Run extension dist smoke test").includes("if:"))
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

	it("keeps plain core tasks aligned with coverage cache boundaries", () => {
		for (const lane of ["unit", "integration"]) {
			const plainTask = coreTurbo.tasks[`test:${lane}`]
			const coverageTask = coreTurbo.tasks[`test:coverage:${lane}`]

			assert.deepEqual(plainTask.dependsOn, coverageTask.dependsOn)
			assert.deepEqual(plainTask.inputs, coverageTask.inputs)
		}
	})

	it("caps Windows CI extension lanes at two workers per lane to fill the runner vCPUs", () => {
		const config = fs.readFileSync(path.join(repositoryRoot, "src/vitest.config.ts"), "utf8")

		assert.match(config, /maxWorkers: isWindowsCI \? 2 : undefined/)
	})
})
