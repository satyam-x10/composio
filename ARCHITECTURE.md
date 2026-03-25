# ARCHITECTURE.md

## Design Overview
The agent is built using an **Orchestrator Pattern** that manages the concurrent validation of multiple API endpoints. It follows a two-phase execution flow:
1.  **Phase 1 (Simple Endpoints):** Executes endpoints with no path parameters (e.g., list endpoints). This serves to populate a shared **Dependency Cache** with real IDs (like `messageId` or `eventId`).
2.  **Phase 2 (Dependent/Mutation Endpoints):** Executes endpoints that require specific IDs or have side effects. These workers wait for the cache to be populated by Phase 1.

## Dependency Resolution
Dependencies are resolved dynamically using a **generic lookup strategy**:
-   The agent extracts parameter names from path templates (e.g., `{messageId}`).
-   It searches for "provider" endpoints (GET requests with no path params) that share a similar path prefix.
-   IDs extracted from the provider's response are stored in a `DependencyCache`.
-   Dependent workers utilize these IDs to construct valid URLs. If no IDs are found, the agent falls back to a placeholder to at least verify the endpoint's existence/route.

## Avoiding False Negatives
To minimize misclassifications, the agent:
-   **Constructs valid payloads:** Specifically handles Gmail (RFC 2822 base64url encoded emails) and Google Calendar (ISO datetimes for events).
-   **Retries with minimal parameters:** If a complex request fails, it attempts a second call with only mandatory parameters to distinguish between a "bad request" and an "invalid endpoint".
-   **Normalizes paths:** Automatically detects and strips redundant base paths (e.g., `/calendar/v3`) that the Composio proxy might already prepend, preventing 404 errors caused by path doubling.

## Classification Logic
The agent classifies endpoints into four states:
-   **`valid`**: 2xx HTTP response.
-   **`invalid_endpoint`**: 404/405 response OR the body contains explicit "not found" or "method not allowed" messages (checked via case-insensitive substring matching).
-   **`insufficient_scopes`**: 403 response OR error messages containing "scope", "forbidden", "insufficient permissions", or "access denied".
-   **`error`**: Any other infrastructure error, 400 Bad Requests (after retries), or 500 Server Errors.

## Tradeoffs
-   **Concurrency vs. Rate Limiting:** The agent runs many endpoints in parallel for speed, which might hit rate limits on some APIs. A throttling mechanism could be added for larger datasets.
-   **Deep Payload Generation:** While it handles Gmail and Calendar specifically, it uses generic defaults for other objects. More complex schema-based generation could improve accuracy for unknown apps.

## Architecture Pattern
The **Orchestrator + Shared Cache** pattern was chosen because:
-   **Pros:** It allows for highly parallel execution while still handling inter-endpoint dependencies cleanly. It is more robust than a simple sequential loop.
-   **Cons:** It requires careful handling of race conditions and timeouts in the cache, which the implementation addresses with localized locking/promises.
