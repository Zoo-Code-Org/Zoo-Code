import { Bm25Ranker } from "./Bm25Ranker"
import type { Ranker } from "./types"

// The embeddings implementation (#576) can select its provider here.
export function createRanker(): Ranker {
	return new Bm25Ranker()
}
