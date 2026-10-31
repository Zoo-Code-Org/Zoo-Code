import { PROVIDERS } from "@src/components/settings/constants"

const LABELS = new Map(PROVIDERS.map((p) => [p.value, p.label]))

/** Human label for a provider id, falling back to the id itself for unknown/retired providers. */
export const providerLabel = (id: string): string => LABELS.get(id) ?? id
