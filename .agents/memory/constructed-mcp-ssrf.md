---
name: Constructed MCP web-tool SSRF hardening
description: How constructed web/browser tools fetch safely; why initial-URL validation alone is insufficient.
---

# Constructed MCP web-tool SSRF hardening

Constructed MCP tools execute arbitrary outbound web requests (HTTP recipes and a Playwright/rendered-fetch browser path). Any outbound fetch on behalf of a constructed tool MUST go through `safeFetch` in `webTools.ts`, never raw `fetch`.

**Rule:** Validate the URL at *every* step, not just the initial one.
- `resolveSafeTarget(url, allowPrivate)` validates protocol + resolves DNS and returns the concrete addresses.
- `safeFetch` follows redirects **manually** (`redirect: "manual"`) and re-validates every hop's `Location`, capped at a max hop count.
- Connections are **pinned** to the validated IPs via an undici `Agent` with a custom `connect.lookup`, so a hostname cannot resolve to a public IP at validation time and a private IP at connect time (DNS-rebinding / TOCTOU).
- Browser (Playwright) mode installs a `page.route("**/*")` guard that runs `resolveSafeTarget` on *every* page-initiated request (subresources, XHR, fetch), not just explicit `goto`s, and aborts blocked ones.
- Credential headers (`authorization`, `proxy-authorization`, `cookie`, plus any caller-supplied `sensitiveHeaders` such as a custom api-key header name) are **stripped once a redirect leaves the original origin**, so an upstream open redirect cannot exfiltrate adapter secrets. Same-origin redirects keep auth.

**Why:** The first review found that validating only the initial URL was bypassable three ways: a public host 30x-redirecting to `169.254.169.254`/RFC1918/loopback, DNS rebinding between check and connect, and page-initiated subresource requests in browser mode. Each was independently exploitable for SSRF against cloud metadata / internal services, and this feature is reachable by external AIs over `/mcp`.

**How to apply:** When adding any new outbound-request surface to constructed tools, route it through `safeFetch`/`resolveSafeTarget` with the owning adapter's `allowPrivateNetwork` flag. The opt-in `allowPrivateNetwork` toggle is the only thing that relaxes these checks (skips pinning and private-IP blocking).

**Related dispatch correctness:** Executable capabilities are keyed by tool name, which is not unique per tenant. `executeNamedCapability` and `listExecutableCapabilities` both order by `(createdAt, id)` and `listToolsForTenant` dedupes dynamic names (first wins) so a duplicated tool name always dispatches to the same capability that `tools/list` advertised.
