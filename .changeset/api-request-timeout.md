---
"zoo-code": patch
---

Updated `apiRequestTimeout` validation. Values must be integers between 1 and 3600 seconds; invalid or out-of-range values, including `0`, now fall back to 600 seconds. This aligns with the SDK's default timeout value.
