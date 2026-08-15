import type { ApiHandlerCreateMessageMetadata } from "../../index"
import { mergeAbortSignalAndTimeout, mergeAbortSignals } from "../utils/abort-signal"

/**
 * A generic, SDK-agnostic request configuration builder.
 *
 * Provides a fluent API for building request configurations with:
 * - Chainable method calls
 * - Generic type support (TOptions)
 * - Abort signal handling
 * - Header merging
 * - Static factory methods
 */
type RequestConfigOptionsBase = object & {
	headers?: Record<string, string>
	signal?: AbortSignal
}

type RequestConfigOptions = RequestConfigOptionsBase & Record<string, unknown>

export class RequestConfigBuilder<TOptions extends RequestConfigOptionsBase = RequestConfigOptions> {
	protected options: Partial<TOptions>
	private cleanupFn: () => void = () => {}

	constructor(defaultOptions?: Partial<TOptions>) {
		this.options = defaultOptions
			? (Object.fromEntries(
					Object.entries(defaultOptions).filter(([, value]) => value !== undefined),
				) as Partial<TOptions>)
			: {}
	}

	/**
	 * Set the abort signal from metadata, replacing any previously configured
	 * signal (including one created by addMergedSignal). Use addMergedSignal to
	 * combine signals instead of overwriting them.
	 *
	 * @param metadata - Optional metadata containing an abortSignal
	 * @returns this for chainable calls
	 */
	setAbortSignal(metadata?: ApiHandlerCreateMessageMetadata): this {
		if (!metadata?.abortSignal) {
			return this
		}

		this.options = { ...this.options, signal: metadata.abortSignal }
		return this
	}

	/**
	 * Add or merge custom headers.
	 *
	 * @param headers - Key-value pairs of header names and values
	 * @returns this for chainable calls
	 */
	addHeaders(headers?: Record<string, string>): this {
		if (!headers || Object.keys(headers).length === 0) {
			return this
		}

		const existingHeaders = this.options.headers ?? {}
		this.options = { ...this.options, headers: { ...existingHeaders, ...headers } }
		return this
	}

	/**
	 * Merge an internal controller signal with an external metadata signal and optional timeout.
	 *
	 * Use this for providers that already maintain their own AbortController but also need
	 * to honor the request-level abort signal from metadata and/or a timeout.
	 *
	 * @param internalController - Provider-owned AbortController for the current request
	 * @param metadata - Optional metadata containing an external abortSignal
	 * @param timeoutMs - Optional positive timeout in milliseconds; <= 0 disables timeout
	 * @returns this for chainable calls
	 */
	addMergedSignal(
		internalController: AbortController,
		metadata?: ApiHandlerCreateMessageMetadata,
		timeoutMs?: number,
	): this {
		const merged = mergeAbortSignalAndTimeout(metadata?.abortSignal, timeoutMs)
		const signal = mergeAbortSignals(internalController.signal, merged.signal)

		this.options = { ...this.options, signal }
		const previousCleanup = this.cleanupFn
		this.cleanupFn = () => {
			previousCleanup()
			merged.cleanup()
		}
		return this
	}

	/**
	 * Get the cleanup function for resources created by addMergedSignal.
	 *
	 * @returns Cleanup function, or a no-op when no merged signal was added
	 */
	getCleanup(): () => void {
		return this.cleanupFn
	}

	/**
	 * Set a single option by key (type-safe).
	 *
	 * @param key - Option key
	 * @param value - Option value
	 * @returns this for chainable calls
	 */
	setOption<K extends keyof TOptions>(key: K, value: TOptions[K]): this {
		if (value === undefined) {
			return this
		}

		this.options = { ...this.options, [key]: value }
		return this
	}

	/**
	 * Get an option by key.
	 *
	 * @param key - Option key
	 * @returns The option value or undefined if not set
	 */
	getOption<K extends keyof TOptions>(key: K): TOptions[K] | undefined {
		return this.options[key]
	}

	/**
	 * Build the final configuration object.
	 *
	 * Returns a shallow copy of the internal options to ensure immutability.
	 * Returns undefined if no options have been set.
	 *
	 * @returns A partial built configuration (only the options that were set) or
	 * undefined if empty
	 */
	build(): Partial<TOptions> | undefined {
		const keys = Object.keys(this.options as object)
		if (keys.length === 0) {
			return undefined
		}

		return { ...this.options }
	}

	/**
	 * Factory method to quickly create and configure a builder from metadata.
	 *
	 * @param metadata - Optional metadata containing an abortSignal
	 * @param extraOptions - Additional options to merge
	 * @returns The built configuration or undefined if empty
	 */
	static fromMetadata<TOptions extends RequestConfigOptionsBase = RequestConfigOptions>(
		metadata?: ApiHandlerCreateMessageMetadata,
		extraOptions?: Partial<TOptions>,
	): Partial<TOptions> | undefined {
		const builder = new RequestConfigBuilder<TOptions>(extraOptions)
		builder.setAbortSignal(metadata)
		return builder.build()
	}
}
