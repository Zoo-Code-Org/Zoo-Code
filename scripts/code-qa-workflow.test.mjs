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
})

describe("Knip quality gate", () => {
	it("runs analyzer challenge tests and both dependency graphs without allowing failure", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"))
		assert.equal(manifest.scripts.knip, "knip --treat-config-hints-as-errors")
		assert.equal(manifest.scripts["knip:production"], "knip --production --treat-config-hints-as-errors")
		assert.equal(manifest.scripts["test:knip-policy"], "node --test scripts/knip-policy.test.mjs")
		for (const [stepName, command] of [
			["Verify Knip guardrails", "pnpm test:knip-policy"],
			["Run knip checks", "pnpm knip"],
			["Run production Knip checks", "pnpm knip:production"],
		]) {
			assert.match(workflowStep(stepName), new RegExp(`run: ${command}\\s*$`))
			assert.doesNotMatch(workflowStep(stepName), /continue-on-error|if:/)
		}
		const job = workflow.match(/\n {4}knip:\n(?<body>[\s\S]*?)\n {4}compile:/)?.groups?.body
		assert.ok(job, "missing knip job")
		assert.doesNotMatch(job, /continue-on-error|if:/)
	})
})

describe("Code QA dependency install", () => {
	it("installs every job with a frozen lockfile", () => {
		const setups = workflow.match(/uses: \.\/\.github\/actions\/setup-node-pnpm\n/g) ?? []
		const frozen =
			workflow.match(
				/uses: \.\/\.github\/actions\/setup-node-pnpm\n\s+with:\n\s+install-args: "--frozen-lockfile"\n/g,
			) ?? []
		assert.ok(setups.length > 0, "missing setup-node-pnpm steps")
		assert.equal(frozen.length, setups.length)
	})
})

// ExtensionCiChecksCurrent: extension CI runs ESLint directly without its file cache.
describe("lint cache policy", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"))

	it("uses a separate content cache for staged extension files", () => {
		const commands = manifest["lint-staged"]["src/**/*.ts"]
		assert.equal(commands.length, 1)
		const command = commands[0]
		assert.match(command, /^pnpm --dir src exec eslint /)
		for (const option of ["--max-warnings=0", "--no-warn-ignored", "--cache", "--cache-strategy content"]) {
			assert.ok(command.split(" ").includes(option) || command.includes(`${option} `), `missing ${option}`)
		}
		assert.match(command, /--cache-location node_modules\/\.cache\/eslint\/\.eslintcache-staged$/)
	})

	it("runs extension CI lint directly without an ESLint cache", () => {
		const command = manifest.scripts["lint:ci"]
		assert.equal(typeof command, "string")
		const [otherPackages, extension] = command.split(" && ")
		assert.match(otherPackages, /^pnpm lint /)
		assert.ok(otherPackages.split(" ").includes("--force"))
		assert.ok(otherPackages.split(" ").includes("--filter=!zoo-code"))
		assert.equal(extension, "pnpm --dir src lint:ci")
		const extensionManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "src/package.json"), "utf8"))
		const freshCommand = extensionManifest.scripts["lint:ci"].split(" ")
		assert.equal(freshCommand[0], "eslint")
		assert.ok(freshCommand.includes("."))
		assert.ok(freshCommand.includes("--max-warnings=0"))
		assert.ok(freshCommand.includes("--no-cache"))
		assert.ok(!freshCommand.some((option) => option === "--cache" || option.startsWith("--cache-")))
		assert.match(workflowStep("Lint"), /run: pnpm lint:ci\s*$/)
		assert.doesNotMatch(workflowStep("Lint"), /continue-on-error|if:/)
	})
})

// The Code QA workflow must keep both runner tests in its command.
it("runs the runner contract and strict-environment integration tests in CI", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"))
	const command = manifest.scripts["test:code-qa-ci"].split(" ")
	for (const file of [
		"scripts/code-qa-workflow.test.mjs",
		"scripts/test-local.test.mjs",
		"scripts/test-local.integration.test.mjs",
	]) {
		assert.ok(command.includes(file), `CI must execute ${file}`)
	}
	assert.match(workflowStep("Validate Code QA workflow"), /run: pnpm test:code-qa-ci\s*$/)
	assert.doesNotMatch(workflowStep("Validate Code QA workflow"), /if:|continue-on-error/)
})
