import { Composio } from "@composio/core";
import type {
  EndpointDefinition,
  EndpointReport,
  EndpointStatus,
  TestReport,
} from "./types";

// ─────────────────────────────────────────────────────────────
// Shared dependency cache – list-endpoint workers populate this
// so detail-endpoint workers can resolve path parameters.
// ─────────────────────────────────────────────────────────────

type CacheEntry = {
  values: unknown[];
  resolve: (v: unknown[]) => void;
  promise: Promise<unknown[]>;
};

class DependencyCache {
  private store = new Map<string, CacheEntry>();

  /** Get or create a cache slot for a given key (e.g. "messageId"). */
  private slot(key: string): CacheEntry {
    if (!this.store.has(key)) {
      let resolve!: (v: unknown[]) => void;
      const promise = new Promise<unknown[]>((r) => (resolve = r));
      this.store.set(key, { values: [], resolve, promise });
    }
    return this.store.get(key)!;
  }

  /** Store resolved IDs for a given resource key. */
  populate(key: string, values: unknown[]) {
    const s = this.slot(key);
    s.values = values;
    s.resolve(values);
  }

  /** Wait for a key to be populated (with timeout). */
  async get(key: string, timeoutMs = 30_000): Promise<unknown[]> {
    const s = this.slot(key);
    if (s.values.length > 0) return s.values;
    const timeout = new Promise<unknown[]>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout waiting for dep: ${key}`)), timeoutMs)
    );
    return Promise.race([s.promise, timeout]);
  }
}

// ─────────────────────────────────────────────────────────────
// Response classification
// ─────────────────────────────────────────────────────────────

function classifyResponse(
  status: number | null | undefined,
  data: unknown
): EndpointStatus {
  if (status == null) return "error";

  // 2xx → valid
  if (status >= 200 && status < 300) return "valid";

  // Check body text for more signals
  const bodyText =
    typeof data === "string" ? data.toLowerCase() : JSON.stringify(data ?? "").toLowerCase();

  // 404 or "not found" → invalid_endpoint
  if (status === 404 || status === 405) return "invalid_endpoint";
  if (bodyText.includes("not found") && status >= 400 && status < 500)
    return "invalid_endpoint";
  if (bodyText.includes("method not allowed")) return "invalid_endpoint";

  // 403 or permission/scope errors → insufficient_scopes
  if (status === 403) return "insufficient_scopes";
  if (
    bodyText.includes("insufficient") ||
    bodyText.includes("forbidden") ||
    bodyText.includes("insufficientpermissions") ||
    bodyText.includes("access denied") ||
    bodyText.includes("scope")
  )
    return "insufficient_scopes";

  // Everything else
  return "error";
}

/** Build a human-friendly summary explaining the classification. */
function buildSummary(
  status: EndpointStatus,
  httpStatus: number | null,
  data: unknown,
  endpoint: EndpointDefinition
): string {
  switch (status) {
    case "valid":
      return `Endpoint ${endpoint.method} ${endpoint.path} returned HTTP ${httpStatus} — successfully executed and verified as a valid, working endpoint.`;
    case "invalid_endpoint":
      return `Endpoint ${endpoint.method} ${endpoint.path} returned HTTP ${httpStatus} — this endpoint does not exist in the actual API. The server returned a 'not found' or 'method not allowed' response, indicating a fake or incorrect endpoint definition.`;
    case "insufficient_scopes":
      return `Endpoint ${endpoint.method} ${endpoint.path} returned HTTP ${httpStatus} — the connected account lacks the required permissions/scopes (${endpoint.required_scopes.join(", ")}). The server returned a forbidden/insufficient permissions response.`;
    case "error":
      return `Endpoint ${endpoint.method} ${endpoint.path} returned HTTP ${httpStatus} — the request failed with an unexpected error. This may indicate a malformed request or server-side issue.`;
  }
}

// ─────────────────────────────────────────────────────────────
// Request body builder – generates minimal valid payloads
// ─────────────────────────────────────────────────────────────

function buildRequestBody(
  endpoint: EndpointDefinition,
  resolvedEmail?: string
): Record<string, unknown> | undefined {
  if (!endpoint.parameters.body) return undefined;

  const body: Record<string, unknown> = {};

  for (const field of endpoint.parameters.body.fields) {
    if (field.name === "raw" && field.type === "string") {
      // RFC 2822 encoded email for Gmail send/draft
      const email = resolvedEmail || "test@example.com";
      const rawEmail = [
        `From: ${email}`,
        `To: ${email}`,
        `Subject: Endpoint Tester Validation`,
        `Content-Type: text/plain; charset="UTF-8"`,
        "",
        "This is an automated test email from the endpoint validation agent.",
      ].join("\r\n");
      body[field.name] = btoa(rawEmail)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    } else if (field.name === "message" && field.type === "object") {
      // Gmail draft message object
      const email = resolvedEmail || "test@example.com";
      const rawEmail = [
        `From: ${email}`,
        `To: ${email}`,
        `Subject: Draft Test from Endpoint Validator`,
        `Content-Type: text/plain; charset="UTF-8"`,
        "",
        "This is an automated test draft from the endpoint validation agent.",
      ].join("\r\n");
      body[field.name] = {
        raw: btoa(rawEmail)
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, ""),
      };
    } else if (field.name === "start" && field.type === "object") {
      const dt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      body[field.name] = {
        dateTime: dt.toISOString(),
        timeZone: "UTC",
      };
    } else if (field.name === "end" && field.type === "object") {
      const dt = new Date(Date.now() + 25 * 60 * 60 * 1000);
      body[field.name] = {
        dateTime: dt.toISOString(),
        timeZone: "UTC",
      };
    } else if (field.name === "summary" && field.type === "string") {
      body[field.name] = "Endpoint Validator Test Event";
    } else if (field.name === "description" && field.type === "string") {
      if (!field.required) continue; // skip optional description
      body[field.name] = "Automated test";
    } else {
      // Generic fallback by type
      switch (field.type) {
        case "string":
          body[field.name] = "test";
          break;
        case "integer":
        case "number":
          body[field.name] = 1;
          break;
        case "boolean":
          body[field.name] = true;
          break;
        case "object":
          body[field.name] = {};
          break;
        case "array":
          body[field.name] = [];
          break;
        default:
          body[field.name] = "test";
      }
    }
  }

  return body;
}

// ─────────────────────────────────────────────────────────────
// Path parameter extraction helpers
// ─────────────────────────────────────────────────────────────

/** Extract path param names like ["messageId", "eventId"] from a path template. */
function extractPathParams(path: string): string[] {
  const matches = path.match(/\{(\w+)\}/g);
  return matches ? matches.map((m) => m.slice(1, -1)) : [];
}

/**
 * Given a param name and a list of all endpoints, find the best "list"
 * endpoint that can provide IDs for that param.
 * Strategy: find GET endpoints with no path params that share a path prefix.
 */
function findProviderEndpoint(
  paramName: string,
  targetPath: string,
  allEndpoints: EndpointDefinition[]
): EndpointDefinition | null {
  // Extract the resource path (everything before the {param})
  const paramIndex = targetPath.indexOf(`{${paramName}}`);
  if (paramIndex === -1) return null;
  const prefix = targetPath.substring(0, paramIndex).replace(/\/$/, "");

  // Find GET endpoints with matching prefix and no path params
  const candidates = allEndpoints.filter(
    (ep) =>
      ep.method === "GET" &&
      ep.parameters.path.length === 0 &&
      ep.path === prefix
  );

  if (candidates.length > 0) return candidates[0];

  // Broader search: find any GET endpoint whose path starts with a similar base
  const baseParts = prefix.split("/").filter(Boolean);
  const broader = allEndpoints.filter(
    (ep) =>
      ep.method === "GET" &&
      ep.parameters.path.length === 0 &&
      baseParts.some((part) => ep.path.includes(part))
  );

  // Prefer the one with the most path segment overlap
  if (broader.length > 0) {
    broader.sort((a, b) => {
      const overlapA = a.path.split("/").filter((p) => baseParts.includes(p)).length;
      const overlapB = b.path.split("/").filter((p) => baseParts.includes(p)).length;
      return overlapB - overlapA;
    });
    return broader[0];
  }

  return null;
}

/**
 * Extract IDs from a list response body. Works generically by looking for:
 * - Arrays with objects containing "id" fields
 * - Common patterns like { messages: [...] }, { items: [...] }, { events: [...] }
 */
function extractIdsFromResponse(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];

  const obj = data as Record<string, unknown>;

  // Direct array of items with id
  if (Array.isArray(obj)) {
    return obj
      .filter((item) => item && typeof item === "object" && "id" in item)
      .map((item) => String((item as Record<string, unknown>).id))
      .slice(0, 5);
  }

  // Look through top-level keys for arrays
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0) {
      const ids = val
        .filter((item) => item && typeof item === "object" && "id" in item)
        .map((item) => String((item as Record<string, unknown>).id))
        .slice(0, 5);
      if (ids.length > 0) return ids;
    }
  }

  return [];
}

// ─────────────────────────────────────────────────────────────
// Redact sensitive data from response bodies
// ─────────────────────────────────────────────────────────────

function redactSensitive(data: unknown): unknown {
  if (data == null) return data;
  if (typeof data === "string") {
    // Redact email addresses
    return data.replace(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      "[REDACTED_EMAIL]"
    );
  }
  if (Array.isArray(data)) {
    return data.slice(0, 3).map(redactSensitive);
  }
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (
        ["email", "emailAddress", "senderEmail", "creator", "organizer"].includes(key) &&
        typeof val === "string"
      ) {
        result[key] = "[REDACTED]";
      } else if (key === "snippet" && typeof val === "string") {
        result[key] = val.slice(0, 100) + (val.length > 100 ? "..." : "");
      } else {
        result[key] = redactSensitive(val);
      }
    }
    return result;
  }
  return data;
}

function truncateBody(data: unknown): unknown {
  try {
    const str = JSON.stringify(data);
    if (str && str.length > 5000) {
      // Return a truncated version as a string — don't try to re-parse truncated JSON
      return str.slice(0, 5000) + "...[truncated]";
    }
    return data;
  } catch {
    return String(data).slice(0, 5000);
  }
}

// ─────────────────────────────────────────────────────────────
// Core execution logic per endpoint
// ─────────────────────────────────────────────────────────────

async function executeEndpoint(
  composio: Composio,
  getAccountId: (path: string) => string,
  endpoint: EndpointDefinition,
  allEndpoints: EndpointDefinition[],
  cache: DependencyCache,
  userEmail: string | null
): Promise<EndpointReport> {
  const connectedAccountId = getAccountId(endpoint.path);
  
  // Normalize path: some proxies (like googlecalendar) already have a base path
  // (e.g. /calendar/v3). If the endpoint path starts with it, strip it to avoid duplication.
  let targetPath = endpoint.path;
  if (endpoint.path.startsWith("/calendar/v3/") && connectedAccountId.includes("ca_")) {
    // We only strip if we resolved to a specific account, as the proxy handles the base path
    targetPath = endpoint.path.replace("/calendar/v3/", "/");
  }
  
  let httpStatusCode: number | null = null;
  let responseData: unknown = null;
  let status: EndpointStatus = "error";

  try {
    // Step 1: Resolve path parameters
    let resolvedPath = targetPath;
    const pathParams = extractPathParams(endpoint.path);

    for (const param of pathParams) {
      // Try to get from cache first (another worker may have populated it)
      let ids: unknown[];
      try {
        ids = await cache.get(param, 20_000);
      } catch {
        // Cache miss — try to resolve by calling a provider endpoint
        const provider = findProviderEndpoint(param, endpoint.path, allEndpoints);
        if (provider) {
          try {
            const providerPath = provider.path.startsWith("/calendar/v3/") 
              ? provider.path.replace("/calendar/v3/", "/") 
              : provider.path;
              
            const listResult = await composio.tools.proxyExecute({
              endpoint: providerPath,
              method: provider.method as any,
              connectedAccountId: getAccountId(provider.path),
              parameters: [{ in: "query", name: "maxResults", value: 5 }],
            });
            const extractedIds = extractIdsFromResponse(listResult?.data);
            if (extractedIds.length > 0) {
              cache.populate(param, extractedIds);
              ids = extractedIds;
            } else {
              ids = [];
            }
          } catch {
            ids = [];
          }
        } else {
          ids = [];
        }
      }

      if (ids.length > 0) {
        resolvedPath = resolvedPath.replace(`{${param}}`, String(ids[0]));
      } else {
        // Can't resolve dependency — try with a placeholder to see if endpoint exists
        resolvedPath = resolvedPath.replace(`{${param}}`, "test-placeholder-id");
      }
    }

    // Step 2: Build query parameters
    const queryParams = endpoint.parameters.query
      .filter((p) => p.required || p.name === "maxResults")
      .map((p) => ({
        in: "query" as const,
        name: p.name,
        value: p.name === "maxResults" ? 5 : p.type === "integer" ? 1 : "test",
      }));

    // Step 3: Build body
    const body = buildRequestBody(endpoint, userEmail ?? undefined);

    // Step 4: Execute
    const execParams: any = {
      endpoint: resolvedPath,
      method: endpoint.method as any,
      connectedAccountId,
    };
    if (queryParams.length > 0) execParams.parameters = queryParams;
    if (body) execParams.body = body;

    const result = await composio.tools.proxyExecute(execParams);

    httpStatusCode = result?.status ?? null;
    responseData = result?.data ?? null;

    status = classifyResponse(httpStatusCode, responseData);

    // Step 5: If initial call fails and endpoint has no path params, retry with minimal params
    if (status === "error" && pathParams.length === 0) {
      // Retry with absolutely minimal request
      const retryParams: any = {
        endpoint: endpoint.path,
        method: endpoint.method as any,
        connectedAccountId,
      };
      if (body) retryParams.body = body;

      try {
        const retryResult = await composio.tools.proxyExecute(retryParams);
        const retryStatus = classifyResponse(retryResult?.status, retryResult?.data);
        // Only accept the retry if it gives a better result
        if (retryStatus === "valid" || retryStatus === "invalid_endpoint" || retryStatus === "insufficient_scopes") {
          httpStatusCode = retryResult?.status ?? null;
          responseData = retryResult?.data ?? null;
          status = retryStatus;
        }
      } catch {
        // Keep original classification
      }
    }

    // Step 6: If we got a 400 "error" on an endpoint with a body, retry varies
    if (status === "error" && endpoint.parameters.body && httpStatusCode === 400) {
      // Possibly bad body — but the endpoint might still be valid
      // 400 means the server recognized the endpoint but rejected our payload
      // This is evidence the endpoint EXISTS, just that our payload was wrong
      // We'll still classify as error, but this is an informed decision
    }

    // Step 7: Populate dependency cache if this is a list-type endpoint
    if (status === "valid" && endpoint.method === "GET" && pathParams.length === 0) {
      const ids = extractIdsFromResponse(responseData);
      if (ids.length > 0) {
        // Determine what param key this feeds into
        // Look at other endpoints that reference a path under this one
        for (const other of allEndpoints) {
          const otherParams = extractPathParams(other.path);
          for (const p of otherParams) {
            if (other.path.includes(endpoint.path)) {
              cache.populate(p, ids);
            }
          }
        }
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    responseData = { error: errMsg };

    // Try to parse any JSON in the Composio SDK error message
    let parsedError: any = null;
    try {
      const jsonMatch = errMsg.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedError = JSON.parse(jsonMatch[0]);
        responseData = { error: errMsg, parsed_error: parsedError };
      }
    } catch {
      // JSON parsing failed
    }

    // CRITICAL: Distinguish Composio infrastructure errors from actual API errors.
    // Composio SDK returns errors like "ConnectedAccount_ResourceNotFound" or
    // "HTTP_Unauthorized" with 404/401 status — but these are NOT from the target API.
    const composioErrorSlugs = [
      "ConnectedAccount_ResourceNotFound",
      "HTTP_Unauthorized",
      "AuthConfig_ResourceNotFound",
      "InvalidApiKey",
    ];
    const isComposioInfraError =
      parsedError?.error?.slug &&
      composioErrorSlugs.some((slug) =>
        String(parsedError.error.slug).includes(slug)
      );

    if (isComposioInfraError) {
      // This is a Composio platform error, not an API endpoint error
      status = "error";
      httpStatusCode = parsedError?.error?.status ?? null;
    } else {
      // This might be an actual API error — extract status code
      const statusMatch = errMsg.match(/^(\d{3})\s/);
      if (statusMatch) {
        httpStatusCode = parseInt(statusMatch[1], 10);
        status = classifyResponse(httpStatusCode, errMsg);
      } else if (parsedError?.error?.status) {
        httpStatusCode = parsedError.error.status;
        status = classifyResponse(httpStatusCode, parsedError);
      } else {
        // Check if the error message itself hints at the issue
        const lowerErr = errMsg.toLowerCase();
        if (lowerErr.includes("not found") || lowerErr.includes("404")) {
          status = "invalid_endpoint";
          httpStatusCode = 404;
        } else if (lowerErr.includes("forbidden") || lowerErr.includes("403")) {
          status = "insufficient_scopes";
          httpStatusCode = 403;
        } else if (lowerErr.includes("method not allowed") || lowerErr.includes("405")) {
          status = "invalid_endpoint";
          httpStatusCode = 405;
        }
      }
    }
  }

  const redacted = redactSensitive(responseData);
  const truncated = truncateBody(redacted);

  return {
    tool_slug: endpoint.tool_slug,
    method: endpoint.method,
    path: endpoint.path,
    status,
    http_status_code: httpStatusCode,
    response_summary: buildSummary(status, httpStatusCode, responseData, endpoint),
    response_body: truncated,
    required_scopes: endpoint.required_scopes,
    available_scopes: [], // Not determinable via proxyExecute
  };
}

// ─────────────────────────────────────────────────────────────
// Orchestrator – entry point
// ─────────────────────────────────────────────────────────────

export async function runAgent(params: {
  composio: Composio;
  connectedAccountId: string;
  endpoints: EndpointDefinition[];
}): Promise<TestReport> {
  const { composio, connectedAccountId, endpoints } = params;
  const cache = new DependencyCache();

  console.log(`🚀 Starting endpoint validation for ${endpoints.length} endpoints...\n`);

  // Phase 0a: Resolve actual connected account IDs
  // The runner passes a user ID (e.g., "candidate"), but proxyExecute needs
  // the actual connected account ID (e.g., "ca_xxx"). List all accounts for
  // this user and find the right one for each app.
  let resolvedAccountIds: Map<string, string> = new Map();
  let fallbackAccountId = connectedAccountId;

  try {
    const accounts = await composio.connectedAccounts.list({ userIds: [connectedAccountId] });
    if (accounts?.items && accounts.items.length > 0) {
      console.log(`🔑 Found ${accounts.items.length} connected account(s):`);
      for (const account of accounts.items) {
        // The app identifier is in toolkit.slug (e.g., "gmail", "googlecalendar")
        const toolkitSlug = (account as any).toolkit?.slug?.toLowerCase() ?? "";
        const accountId = account.id;
        const status = (account as any).status ?? "unknown";
        console.log(`   - ${accountId} (app: ${toolkitSlug || "unknown"}, status: ${status})`);

        // Map app slugs to account IDs
        if (toolkitSlug) {
          resolvedAccountIds.set(toolkitSlug, accountId);
        }

        // Use the first active account as fallback
        if (status === "ACTIVE" && !fallbackAccountId.startsWith("ca_")) {
          fallbackAccountId = accountId;
        }
      }

      // If no app names resolved, just use all account IDs
      if (resolvedAccountIds.size === 0 && accounts.items.length > 0) {
        // Store all account IDs — we'll try each one
        for (const account of accounts.items) {
          if ((account as any).status === "ACTIVE") {
            fallbackAccountId = account.id;
            break;
          }
        }
      }
    }
  } catch (e) {
    console.log(`⚠️ Could not list connected accounts: ${(e as Error).message}`);
  }

  /**
   * Get the best connected account ID for a given endpoint path.
   * Maps endpoint paths to the correct app's connected account ID.
   */
  function getAccountIdForEndpoint(path: string): string {
    // Try to match by path prefix to known app names
    if (path.startsWith("/gmail/")) {
      return resolvedAccountIds.get("gmail") ?? fallbackAccountId;
    }
    if (path.startsWith("/calendar/")) {
      return resolvedAccountIds.get("googlecalendar") ?? fallbackAccountId;
    }
    // Generic: try all known IDs, fall back to the user-provided one
    return fallbackAccountId;
  }

  // Phase 0b: Try to get the user's email for constructing test emails
  let userEmail: string | null = null;
  try {
    const gmailAccountId = getAccountIdForEndpoint("/gmail/");
    const profileResult = await composio.tools.proxyExecute({
      endpoint: "/gmail/v1/users/me/profile",
      method: "GET",
      connectedAccountId: gmailAccountId,
    });
    if (profileResult?.data && typeof profileResult.data === "object") {
      userEmail = (profileResult.data as any).emailAddress ?? null;
    }
  } catch {
    // Not critical — fallback to test@example.com
  }
  if (userEmail) {
    console.log(`📧 Resolved user email for test payloads\n`);
  }

  // Phase 1: Execute list/simple endpoints first to populate cache
  const simpleEndpoints = endpoints.filter(
    (ep) =>
      ep.method === "GET" &&
      ep.parameters.path.length === 0
  );
  const dependentEndpoints = endpoints.filter(
    (ep) =>
      ep.parameters.path.length > 0 ||
      (ep.method !== "GET" && !simpleEndpoints.includes(ep))
  );
  // Some endpoints may be in neither — add them to dependent
  const allCovered = new Set([
    ...simpleEndpoints.map((e) => e.tool_slug),
    ...dependentEndpoints.map((e) => e.tool_slug),
  ]);
  const remaining = endpoints.filter((ep) => !allCovered.has(ep.tool_slug));
  dependentEndpoints.push(...remaining);

  console.log(`📋 Phase 1: Testing ${simpleEndpoints.length} simple endpoints (no path params)...`);

  // Execute simple endpoints concurrently
  const simpleResults = await Promise.allSettled(
    simpleEndpoints.map((ep) =>
      executeEndpoint(composio, getAccountIdForEndpoint, ep, endpoints, cache, userEmail)
    )
  );

  // Collect results from simple endpoints
  const results: EndpointReport[] = [];
  for (const result of simpleResults) {
    if (result.status === "fulfilled") {
      results.push(result.value);
      const icon = result.value.status === "valid" ? "✅" : result.value.status === "invalid_endpoint" ? "❌" : result.value.status === "insufficient_scopes" ? "🔒" : "⚠️";
      console.log(`  ${icon} ${result.value.tool_slug}: ${result.value.status} (HTTP ${result.value.http_status_code})`);
    } else {
      console.log(`  ⚠️ Failed: ${result.reason}`);
    }
  }

  console.log(`\n📋 Phase 2: Testing ${dependentEndpoints.length} dependent/mutation endpoints...`);

  // Execute dependent endpoints concurrently (cache should be populated by now)
  const depResults = await Promise.allSettled(
    dependentEndpoints.map((ep) =>
      executeEndpoint(composio, getAccountIdForEndpoint, ep, endpoints, cache, userEmail)
    )
  );

  for (const result of depResults) {
    if (result.status === "fulfilled") {
      results.push(result.value);
      const icon = result.value.status === "valid" ? "✅" : result.value.status === "invalid_endpoint" ? "❌" : result.value.status === "insufficient_scopes" ? "🔒" : "⚠️";
      console.log(`  ${icon} ${result.value.tool_slug}: ${result.value.status} (HTTP ${result.value.http_status_code})`);
    } else {
      console.log(`  ⚠️ Failed: ${result.reason}`);
    }
  }

  // Build summary
  const summary = {
    valid: results.filter((r) => r.status === "valid").length,
    invalid_endpoint: results.filter((r) => r.status === "invalid_endpoint").length,
    insufficient_scopes: results.filter((r) => r.status === "insufficient_scopes").length,
    error: results.filter((r) => r.status === "error").length,
  };

  console.log(`\n📊 Summary: ${summary.valid} valid, ${summary.invalid_endpoint} invalid, ${summary.insufficient_scopes} insufficient scopes, ${summary.error} errors`);

  return {
    timestamp: new Date().toISOString(),
    total_endpoints: endpoints.length,
    results,
    summary,
  };
}
