import { useCallback, useEffect, useRef, useState } from "react"
import deepEqual from "fast-deep-equal"

/**
 * A form buffer over host state. A field the user edited ("touched") keeps the user's value until it is saved or
 * reset. An untouched field follows the host: when the host value of that field changes, the form takes it.
 *
 * The hook compares each host value with the previous host value, not with the form value. A field that was just
 * saved therefore keeps the saved value until the host reports a change, and does not flicker back to the old host
 * value when the host object is recreated with the same values. Values are compared by content, because each host push
 * carries new copies of unchanged arrays and objects.
 *
 * Each write is computed immediately from `formRef`, not in a React state updater. React can run a queued updater after
 * a later `reset`, and its side effects would then mark a discarded edit as touched.
 */
export function useHostSyncedForm<T extends object>(host: T) {
	const [form, setForm] = useState(host)
	const formRef = useRef(form)
	const touched = useRef(new Set<keyof T>())
	// The touched fields whose host value changed since the last send. The form takes these host values when the save
	// succeeds: they are newer than what was sent.
	const changedSinceSend = useRef(new Set<keyof T>())
	const prevHost = useRef(host)
	const latestHost = useRef(host)
	latestHost.current = host

	const writeForm = useCallback((next: T) => {
		formRef.current = next
		setForm(next)
	}, [])

	useEffect(() => {
		const before = prevHost.current
		prevHost.current = host
		if (before === host) return

		const prev = formRef.current
		const next = { ...prev }
		let changed = false
		for (const key of Object.keys(host) as (keyof T)[]) {
			if (deepEqual(before[key], host[key])) continue
			if (touched.current.has(key)) {
				changedSinceSend.current.add(key)
				continue
			}
			if (deepEqual(prev[key], host[key])) continue
			next[key] = host[key]
			changed = true
		}
		if (changed) writeForm(next)
	}, [host, writeForm])

	/** Computes the new value from the current one. A change marks the field touched; an unchanged value does not. */
	const updateField = useCallback(
		<K extends keyof T>(key: K, update: (prev: T[K]) => T[K]) => {
			const prev = formRef.current
			const value = update(prev[key])
			if (Object.is(prev[key], value)) return
			touched.current.add(key)
			writeForm({ ...prev, [key]: value })
		},
		[writeForm],
	)

	const setField = useCallback(
		<K extends keyof T>(key: K, value: T[K]) => updateField(key, () => value),
		[updateField],
	)

	/** Call when the form is sent. The sent values replace the host changes that came before the send. */
	const markSent = useCallback(() => changedSinceSend.current.clear(), [])

	/**
	 * Untouches each touched field whose current form value is still the value that was sent. A field edited again
	 * after the send stays touched. Returns true when no field is touched after the call.
	 *
	 * An untouched field takes the host value if the host changed it after the send. Otherwise it keeps the sent value,
	 * because the host has not reported the save yet.
	 */
	const markSaved = useCallback(
		(sent: T, current: T) => {
			const next = { ...formRef.current }
			let changed = false
			for (const key of touched.current) {
				if (!Object.is(sent[key], current[key])) continue
				touched.current.delete(key)
				if (!changedSinceSend.current.delete(key) || deepEqual(next[key], latestHost.current[key])) continue
				next[key] = latestHost.current[key]
				changed = true
			}
			if (changed) writeForm(next)
			return touched.current.size === 0
		},
		[writeForm],
	)

	/** Drops all edits and reloads the form from the latest host state. */
	const reset = useCallback(() => {
		touched.current.clear()
		changedSinceSend.current.clear()
		writeForm(latestHost.current)
	}, [writeForm])

	const isTouched = useCallback((key: keyof T) => touched.current.has(key), [])

	return { form, setField, updateField, markSent, markSaved, reset, isTouched }
}
