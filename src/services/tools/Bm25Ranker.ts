import { Ranker, ToolDoc } from "./types"

type IndexedDocument = {
	item: ToolDoc
	termFrequencies: Map<string, number>
	length: number
	index: number
}

export class Bm25Ranker implements Ranker {
	private readonly k1 = 1.5
	private readonly b = 0.75
	private indexedItems: ToolDoc[] | undefined
	private documents: IndexedDocument[] = []
	private documentFrequency = new Map<string, number>()
	private averageDocumentLength = 0

	rank(query: string, items: ToolDoc[], k: number): ToolDoc[] {
		const queryTerms = tokenize(query)

		if (queryTerms.length === 0 || items.length === 0 || k <= 0) {
			return []
		}

		this.ensureIndex(items)

		const scores = this.documents
			.map((document) => ({
				document,
				score: this.score(document, new Set(queryTerms)),
			}))
			.filter(({ score }) => score > 0)

		scores.sort((left, right) => right.score - left.score || left.document.index - right.document.index)

		return scores.slice(0, k).map(({ document }) => document.item)
	}

	private ensureIndex(items: ToolDoc[]): void {
		if (this.indexedItems === items) {
			return
		}

		this.indexedItems = items
		this.documentFrequency = new Map<string, number>()
		this.documents = items.map((item, index) => {
			const termFrequencies = countTerms(item)

			for (const term of termFrequencies.keys()) {
				this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1)
			}

			return {
				item,
				termFrequencies,
				length: Array.from(termFrequencies.values()).reduce((total, count) => total + count, 0),
				index,
			}
		})
		this.averageDocumentLength =
			this.documents.reduce((total, document) => total + document.length, 0) / this.documents.length
	}

	private score(document: IndexedDocument, queryTerms: Set<string>): number {
		let score = 0
		const documentCount = this.documents.length

		for (const term of queryTerms) {
			const termFrequency = document.termFrequencies.get(term)

			if (!termFrequency) {
				continue
			}

			const documentFrequency = this.documentFrequency.get(term) ?? 0
			const inverseDocumentFrequency = Math.log(
				1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
			)
			const normalization = this.k1 * (1 - this.b + this.b * (document.length / this.averageDocumentLength))

			score += inverseDocumentFrequency * ((termFrequency * (this.k1 + 1)) / (termFrequency + normalization))
		}

		return score
	}
}

function tokenize(value: string): string[] {
	return value.toLowerCase().split(/\W+/).filter(Boolean)
}

function countTerms(item: ToolDoc): Map<string, number> {
	const frequencies = new Map<string, number>()
	const text = `${item.serverName} ${item.toolName} ${item.description}`

	for (const term of tokenize(text)) {
		frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
	}

	return frequencies
}
