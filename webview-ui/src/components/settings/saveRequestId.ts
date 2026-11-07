// Different on every load of the webview. A reload starts the counter again, and an answer to a save that was sent
// before the reload can still arrive, so a counter alone could give a new save the id of an old, unanswered one.
const loadId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

// Module scope, not per mount: an answer to a save from an earlier mount can still arrive, and it must not match a
// later mount's request id.
let counter = 0

/** An id for a settings save that no other save has used: not in this mount, an earlier one, or before a reload. */
export const nextSaveRequestId = () => `settings-save-${loadId}-${++counter}`
