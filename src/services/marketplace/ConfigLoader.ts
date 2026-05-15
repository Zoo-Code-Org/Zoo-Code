import * as fs from "fs/promises"
import * as path from "path"
import * as yaml from "yaml"
import { z } from "zod"

import {
	type MarketplaceItem,
	type MarketplaceItemType,
	modeMarketplaceItemSchema,
	mcpMarketplaceItemSchema,
} from "@roo-code/types"

const modeMarketplaceResponse = z.object({
	items: z.array(modeMarketplaceItemSchema),
})

const mcpMarketplaceResponse = z.object({
	items: z.array(mcpMarketplaceItemSchema),
})

export class ConfigLoader {
	private readonly marketplacePath: string

	constructor(extensionPath: string) {
		this.marketplacePath = path.join(extensionPath, "assets", "marketplace")
	}

	async loadAllItems(): Promise<MarketplaceItem[]> {
		const [modes, mcps] = await Promise.all([this.fetchModes(), this.fetchMcps()])
		return [...modes, ...mcps]
	}

	private async fetchModes(): Promise<MarketplaceItem[]> {
		const data = await this.readMarketplaceFile("modes.yml")

		const yamlData = yaml.parse(data)
		const validated = modeMarketplaceResponse.parse(yamlData)

		const items: MarketplaceItem[] = validated.items.map((item) => ({
			type: "mode" as const,
			...item,
		}))

		return items
	}

	private async fetchMcps(): Promise<MarketplaceItem[]> {
		const data = await this.readMarketplaceFile("mcps.yml")

		const yamlData = yaml.parse(data)
		const validated = mcpMarketplaceResponse.parse(yamlData)

		const items: MarketplaceItem[] = validated.items.map((item) => ({
			type: "mcp" as const,
			...item,
		}))

		return items
	}

	private async readMarketplaceFile(fileName: string): Promise<string> {
		return fs.readFile(path.join(this.marketplacePath, fileName), "utf-8")
	}

	async getItem(id: string, type: MarketplaceItemType): Promise<MarketplaceItem | null> {
		const items = await this.loadAllItems()
		return items.find((item) => item.id === id && item.type === type) || null
	}
}
