import type { StreamTransform, TransformContext } from "./transforms"

/**
 * Runs a stream of raw model output through an ordered list of transforms. Each
 * transform may pass the chunk through, modify it, or signal the stream to stop.
 *
 * The processor is deliberately stateless: it threads the accumulated output
 * through the transforms so they can detect cross-chunk patterns (stop tokens
 * straddling a boundary, suffix repetition, echoed lines).
 */
export class StreamPostProcessor {
	constructor(private readonly transforms: readonly StreamTransform[]) {}

	/**
	 * Feeds the stream through the transform pipeline, yielding the post-processed
	 * chunks. When any transform signals stop, no further chunks are emitted.
	 */
	async *process(
		stream: AsyncGenerator<string, void, undefined>,
		context: TransformContext,
	): AsyncGenerator<string, void, undefined> {
		let accumulated = ""

		for await (const chunk of stream) {
			if (chunk.length === 0) {
				continue
			}

			let next = chunk

			for (const transform of this.transforms) {
				const result = transform.onChunk(accumulated, next, context)

				if (result === null) {
					return
				}

				if (result.length === 0) {
					// A transform consumed the chunk to signal a stop boundary; emit
					// nothing more and end the stream.
					return
				}

				next = result
			}

			accumulated += next
			yield next
		}
	}
}
