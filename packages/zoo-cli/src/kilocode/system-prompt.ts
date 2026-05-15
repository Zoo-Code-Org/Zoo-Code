// kilocode_change - new file

import { ConfigPaths } from "@/config/paths"
import { staticEnvLines, type EditorContext } from "@/kilocode/editor-context"
import type { Provider } from "@/provider/provider"
import type { InstanceContext } from "@/project/instance"

export namespace KilocodeSystemPrompt {
	export function environment(input: { ctx: InstanceContext; model: Provider.Model; editor?: EditorContext }) {
		return [
			[
				`You are powered by the model named ${input.model.api.id}. The exact model ID is ${input.model.providerID}/${input.model.api.id}`,
				`Here is some useful information about the environment you are running in:`,
				`<env>`,
				`  Is directory a git repo: ${input.ctx.project.vcs === "git" ? "yes" : "no"}`,
				`  Platform: ${process.platform}`,
				`  Today's date: ${new Date().toDateString()}`,
				`  Project config: zoo.jsonc, .zoo/command/*.md, .zoo/agent/*.md, .zoo/rules/*.md, .zoo/modes/*.json, .zooignore, AGENTS.md. Put new commands and agents in .zoo/.`,
				`  Global config: ${ConfigPaths.zooGlobalConfigDir()}/zoo.jsonc`,
				...staticEnvLines(input.editor),
				`</env>`,
			].join("\n"),
		]
	}
}
