---
"zoo-code": patch
---

Detect when the "Google Cloud Credentials" Vertex field has been given a filesystem path instead of the raw JSON contents of a service-account key file. The runtime now skips JSON.parse for path-shaped input, logs a single specific console warning naming the sibling "Google Cloud Key File Path" field and `GOOGLE_APPLICATION_CREDENTIALS` env var, and the settings UI shows an inline warning under the field while the input still looks like a path. Auth behavior is unchanged for correctly-configured users.
