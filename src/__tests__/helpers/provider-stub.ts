import { ClineProvider } from "../../core/webview/ClineProvider"

/**
 * Augments a plain stub object with the instance fields and bound methods that
 * ClineProvider methods read from `this` (runDelegationTransition,
 * delegationTransitionLocks, cancelledDelegationChildIds), so tests can call
 * private methods via `(ClineProvider.prototype as any).method.call(stub, …)`
 * without instantiating a real ClineProvider.
 */
export function makeProviderStub<T extends object>(stub: T): T {
	const s = stub as any
	const proto = ClineProvider.prototype as any
	s.delegationTransitionLocks ??= new Map()
	s.cancelledDelegationChildIds ??= new Set()
	s.runDelegationTransition = proto.runDelegationTransition.bind(s)
	return s
}
