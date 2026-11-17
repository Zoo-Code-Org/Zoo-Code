import { useMemo } from "react"
import { Fzf } from "fzf"
import { providerIdentifiers, type ModelRecord, type ProviderName } from "@roo-code/types"

export function useModelSearch(
	models: ModelRecord | null,
	selectedId: string | undefined,
	search: string,
	provider: ProviderName | undefined,
	allowCustomArn: boolean,
) {
	const items = useMemo(
		() =>
			Object.entries(models ?? {})
				.filter(([id, info]) => !info.deprecated || id === selectedId)
				.filter(
					([id]) =>
						provider !== providerIdentifiers.bedrock ||
						(!id.startsWith("arn:") && (id !== "custom-arn" || allowCustomArn)),
				)
				.map(([id, info]) => ({ id, info }))
				.sort((a, b) => a.id.localeCompare(b.id)),
		[models, selectedId, provider, allowCustomArn],
	)
	const fzf = useMemo(
		() => new Fzf(items, { selector: ({ id, info }) => `${id} ${info.displayName ?? ""}` }),
		[items],
	)
	return useMemo(() => (search ? fzf.find(search).map(({ item }) => item) : items), [fzf, items, search])
}
