// EvalPublication.tla defines the ordering contract. Callers hold the output
// lock. The commit callback writes the completion marker.
export interface GenerationPublication {
	steps: Iterable<() => Promise<void>>
	commit: () => Promise<void>
	isInterrupted: () => boolean
	rollback: () => Promise<void>
}

class PublicationInterrupted extends Error {
	constructor() {
		super("generation publication interrupted")
	}
}

// Check both sides of each await, including the completion-marker write.
// A failed rollback must throw; it cannot report a clean interruption.
export async function publishGeneration(publication: GenerationPublication): Promise<boolean> {
	const check = () => {
		if (publication.isInterrupted()) throw new PublicationInterrupted()
	}
	try {
		check()
		for (const step of publication.steps) {
			check()
			await step()
			check()
		}
		check()
		await publication.commit()
		check()
		return true
	} catch (error) {
		try {
			await publication.rollback()
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "publication failed and cleanup failed")
		}
		if (error instanceof PublicationInterrupted) return false
		throw error
	}
}
