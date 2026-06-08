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

**IPv6 literal-host gotchas (resolveSafeTarget):**
- `new URL("http://[::1]/").hostname` keeps the brackets (`"[::1]"`), and `net.isIP("[::1]")` is 0. Strip the brackets before `isIP`/`ipIsPrivate`, or every IPv6-literal private-range check is dead and only fails-closed via a "could not resolve" DNS error.
- URL/DNS normalization renders IPv4-mapped IPv6 in **compressed hex** form: `::ffff:10.0.0.1` → `::ffff:a00:1`. `ipIsPrivate` must match `::ffff:hhhh:hhhh` (decode the two hex groups to 4 octets) in addition to the dotted `::ffff:a.b.c.d` form, otherwise `[::ffff:a00:1]` reaches 10.0.0.1.

**Path-arg injection (constructed HTTP recipes):** Substituted `{param}` path values are percent-encoded (`encodeURIComponent`) so `/`, `?`, `#` can't change host/query/segments. The one unfixable case is a value that is exactly `.` or `..`: the WHATWG URL parser decodes & collapses *every* encoding (`%2e`, `%2E`, `.%2e`, …) during path normalization, so `%2E%2E` still traverses. Such values are **rejected** (throw `UnsafePathArgumentError`, executeHttpTool returns ok:false, no request) rather than encoded. Args are also validated against the stored JSON input schema in `executeCapabilityRow` (the single chokepoint) before any request.

**Related dispatch correctness:** Executable capabilities are keyed by tool name, which is not unique per tenant. `executeNamedCapability` and `listExecutableCapabilities` both order by `(createdAt, id)` and `listToolsForTenant` dedupes dynamic names (first wins) so a duplicated tool name always dispatches to the same capability that `tools/list` advertised.
