import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"
import { parse } from "yaml"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const workflowsDir = path.join(repositoryRoot, ".github/workflows")
const workflowFiles = fs
	.readdirSync(workflowsDir)
	.filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
	.sort()

describe("workflow_run self-listen guard (#2086)", () => {
	// GitHub rejects a workflow whose workflow_run trigger lists the workflow's
	// own name ("Workflow '<name>' cannot listen to itself"), and actionlint
	// does not catch it, so keep a dedicated check over every workflow file.
	it.each(workflowFiles)("%s does not list its own name in workflow_run.workflows", (file) => {
		const workflow = parse(fs.readFileSync(path.join(workflowsDir, file), "utf8"))
		const listenedWorkflows = workflow.on?.workflow_run?.workflows

		if (typeof workflow.name !== "string" || !Array.isArray(listenedWorkflows)) {
			return
		}

		expect(listenedWorkflows).not.toContain(workflow.name)
	})
})
