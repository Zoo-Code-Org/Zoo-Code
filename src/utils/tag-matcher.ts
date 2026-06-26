export interface TagMatcherResult {
	matched: boolean
	data: string
}

/**
 * Streaming matcher for lightweight tag-delimited regions.
 *
 * Used to separate content inside `<tag>...</tag>` from surrounding text.
 * This is used for reasoning tags like `<think>...</think>` in provider streams.
 */
export class TagMatcher<Result = TagMatcherResult> {
	index = 0
	chunks: TagMatcherResult[] = []
	cached: string[] = []
	matched: boolean = false
	state: "TEXT" | "TAG_OPEN" | "TAG_CLOSE" = "TEXT"
	depth = 0
	pointer = 0
	private readonly tagNames: string[]
	private activeTagNames: string[] = []
	private candidates: { name: string; index: number }[] = []

	constructor(
		tagName: string | [string, ...string[]],
		readonly transform?: (chunks: TagMatcherResult) => Result,
		readonly position = 0,
	) {
		this.tagNames = Array.isArray(tagName) ? tagName : [tagName]
	}
	private collect() {
		if (!this.cached.length) {
			return
		}
		const last = this.chunks.at(-1)
		const data = this.cached.join("")
		const matched = this.matched
		if (last?.matched === matched) {
			last.data += data
		} else {
			this.chunks.push({
				data,
				matched,
			})
		}
		this.cached = []
	}
	private pop() {
		const chunks = this.chunks
		this.chunks = []
		if (!this.transform) {
			return chunks as Result[]
		}
		return chunks.map(this.transform)
	}

	private _update(chunk: string) {
		for (const char of chunk) {
			this.cached.push(char)
			this.pointer++

			if (this.state === "TEXT") {
				if (char === "<" && (this.pointer <= this.position + 1 || this.matched)) {
					this.state = "TAG_OPEN"
					if (this.depth === 0) {
						this.candidates = this.tagNames.map((name) => ({ name, index: 0 }))
					} else {
						const active = this.activeTagNames.at(-1)
						this.candidates = active ? [{ name: active, index: 0 }] : []
					}
				} else {
					this.collect()
				}
			} else if (this.state === "TAG_OPEN") {
				if (char === ">") {
					const matched = this.candidates.find((c) => c.index === c.name.length)
					if (matched) {
						this.state = "TEXT"
						this.activeTagNames.push(matched.name)
						if (!this.matched) {
							this.cached = []
						}
						this.depth++
						this.matched = true
						continue
					} else {
						this.state = "TEXT"
						this.collect()
					}
				} else if (this.candidates.every((c) => c.index === 0) && char === "/") {
					this.state = "TAG_CLOSE"
					this.index = 0
					continue
				} else if (char === " ") {
					const remaining = this.candidates.filter((c) => c.index === 0 || c.index === c.name.length)
					if (remaining.length === this.candidates.length) {
						continue
					}
					this.candidates = remaining
				} else {
					this.candidates = this.candidates.filter((c) => c.name[c.index] === char)
					for (const c of this.candidates) {
						c.index++
					}
					if (this.candidates.length === 0) {
						this.state = "TEXT"
						this.collect()
					}
				}
			} else if (this.state === "TAG_CLOSE") {
				const tagName = this.activeTagNames.at(-1) ?? this.tagNames[0]
				if (char === ">" && this.index === tagName.length) {
					this.state = "TEXT"
					this.depth--
					this.activeTagNames.pop()
					this.matched = this.depth > 0
					if (!this.matched) {
						this.cached = []
					}
				} else if (char === " " && (this.index === 0 || this.index === tagName.length)) {
					continue
				} else if (tagName[this.index] === char) {
					this.index++
				} else {
					this.state = "TEXT"
					this.collect()
				}
			}
		}
	}
	final(chunk?: string) {
		if (chunk) {
			this._update(chunk)
		}
		this.collect()
		this.candidates = []
		this.activeTagNames = []
		return this.pop()
	}
	update(chunk: string) {
		this._update(chunk)
		if (this.state === "TEXT") {
			this.collect()
		}
		return this.pop()
	}
}
