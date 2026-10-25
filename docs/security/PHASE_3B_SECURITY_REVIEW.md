# AgentPay — Phase 3B Security Review

**Date:** 2026-10-25  
**Auditor:** Principal Application Security Engineer & Software Architect  
**Scope:** Phase 3B External Product Discovery, Catalog Normalization, and Candidate Selection Revalidation  
**Repository:** `F:\AgentPay`  
**Classification:** STRICT AUDIT  

---

## 1. Executive Summary

Phase 3B introduces an external product discovery and catalog provider integration layer behind the gateway and catalog resolver boundary. This review examines the attack surface, input validation, external data sanitization, price integrity, SSRF resilience, authentication and ownership boundaries, policy enforcement, and audit trail fidelity.

- **Security Verdict:** **APPROVED**
- **Vulnerabilities Identified:** 0 Critical, 0 High, 0 Medium, 0 Low.
- **Safety Invariants Maintained:**
  - `PAYMENTS_ENABLED=false` strictly preserved.
  - `PAYPAL_ENVIRONMENT=sandbox` strictly preserved.
  - Production identity remains fail-closed (HTTP 401).
  - Client cannot forge or dictate authoritative catalog prices.
  - Integer minor units strictly enforced without floating-point math.

---

## 2. Threat Analysis & Security Invariants

### 2.1 Provider Trust Boundary
External product discovery providers (APIs, search aggregators, and mock services) are treated as **untrusted external data sources**.
- External payloads are validated with strict Zod runtime schemas (`ProductCandidateSchema`) before reaching internal application logic.
- Malformed, missing, or non-integer price payloads are rejected at the external boundary and never permitted to instantiate internal proposals.
- External responses are normalized into standard immutable data structures (`ProductCandidate`).

### 2.2 External Response Validation & Price Integrity
- **Minor Units Integer Arithmetic:** Prices are enforced as non-negative safe integers (`unitPriceMinor`). Binary floating-point values are rejected by schema refinement.
- **Precision by Currency:** Supported currencies strictly declare integer minor-unit decimal scaling:
  - `JPY`: 0 decimals
  - `USD`, `EUR`, `GBP`, `CAD`, `AUD`, `INR`: 2 decimals
  - `BHD`, `KWD`: 3 decimals
- **Server-Side Revalidation (`revalidateProduct`):** When a user or agent selects a candidate, the server re-queries the provider's product-detail endpoint directly. If the provider reports a price shift between search and selection, the server refuses to proceed with stale data and issues a `409 Conflict` (`PRICE_CHANGED_RECONFIRMATION_REQUIRED`) with both previous and current prices.

### 2.3 SSRF (Server-Side Request Forgery) Protection
- **Base URL Trust:** Discovery provider base URLs are statically configured via environment variables (`PRODUCT_DISCOVERY_API_URL`) and cannot be manipulated by user input.
- **Local / Internal IP Rejection:** `HttpProductDiscoveryProvider` rejects loopback (`127.0.0.1`, `localhost`, `0.0.0.0`), cloud metadata (`169.254.169.254`), and RFC 1918 private IP ranges (`10.0.0.0/8`, `192.168.0.0/16`) in production environments.
- **Scheme Validation:** Product URLs and image URLs must use `http:` or `https:`. Unsafe schemes (`javascript:`, `file:`, `data:`, `ftp:`) are rejected.
- **Inert Data Guarantee:** External URLs provided in candidates are treated solely as display metadata; the backend never fetches or downloads contents from candidate `productUrl` or `imageUrl`.

### 2.4 Secrets Handling & Privacy
- External provider API keys (`PRODUCT_DISCOVERY_API_KEY`) are managed strictly on the backend.
- Provider secrets are never serialized into client responses or stored in proposals.
- Sensitive headers and credentials are excluded from child loggers and error responses.

### 2.5 Authentication & Ownership Enforcements
- Both `POST /api/products/search` and `POST /api/purchase-intents` enforce caller authentication.
- In production, missing credentials result in HTTP 401 (`ProductionPendingAuthenticationProvider`). `x-principal-id` header is completely ignored in production mode.
- Proposals and search contexts are strictly bound to the authenticated principal (`principal:${principalId}`).
- Cross-principal isolation: `GET /api/purchase-intents/:id` rejects unauthorized callers with HTTP 403 (`ForbiddenProposalAccessError`).

### 2.6 Server-Side Policy Evaluator Authority
- Policy evaluation remains strictly on the server (`PolicyService`).
- Clients cannot supply authoritative decisions, overrides, or status transitions.
- High-value or restricted category proposals are evaluated deterministically (`DENY` triggers HTTP 403; `REQUIRE_APPROVAL` triggers proposal status `POLICY_REVIEW_REQUIRED`).

### 2.7 Database Idempotency Scope
- Idempotency is enforced in PostgreSQL via `UNIQUE (idempotency_scope, idempotency_key)` with `SELECT FOR UPDATE` and `ON CONFLICT DO NOTHING`.
- Canonical fingerprinting includes action, product query, quantity, merchant preference, and the selected candidate identifier (`selectedProductId`). Replaying with a different candidate triggers HTTP 409 (`IDEMPOTENCY_CONFLICT`).

### 2.8 Timeouts & Rate Limiting
- External provider operations enforce bounded timeouts (`timeoutMs: 4000` default).
- `AbortController` cancellation propagates socket termination to prevent resource exhaustion.
- Rate limiting is enforced at the gateway (`RATE_LIMIT_MAX: 100`, `RATE_LIMIT_WINDOW_MS: 60000`).

### 2.9 Audit Trail Completeness
Phase 3B adds high-fidelity audit events for the complete discovery lifecycle:
- `PRODUCT_SEARCH_REQUESTED`
- `PRODUCT_SEARCH_SUCCEEDED`
- `PRODUCT_SEARCH_FAILED`
- `PRODUCT_SELECTION_REQUESTED`
- `PRODUCT_REVALIDATED`
- `PRODUCT_REVALIDATION_FAILED`
- `PRODUCT_PRICE_CHANGED`

---

## 3. Security Findings Matrix

| Finding ID | Title | Severity | Status | Remediation |
| :--- | :--- | :--- | :--- | :--- |
| `SEC-3B-01` | External Price Manipulation | Critical | RESOLVED | Enforced server-side candidate revalidation and rejected client-supplied price fields |
| `SEC-3B-02` | SSRF via External URLs | High | RESOLVED | Provider URLs restricted to server env; internal IP ranges blocked in production; URLs inert |
| `SEC-3B-03` | Silent Candidate Mis-selection | High | RESOLVED | Enforced `SELECTION_REQUIRED` on ambiguous queries; no automatic selection on heuristics |
| `SEC-3B-04` | Floating-point rounding errors | Medium | RESOLVED | Enforced integer minor units via `safeIntegerMultiply` and `safeIntegerAdd` |
| `SEC-3B-05` | Unauthenticated Search Exposure | Medium | RESOLVED | Production search route fails closed with 401; ignores spoofed `x-principal-id` |
| `SEC-3B-06` | External Provider Timeout Hangs | Low | RESOLVED | Bounded `AbortController` timeouts returning controlled 504 `TIMEOUT` |

---

## 4. Remaining Limitations
1. **Production Identity Provider:** As established in Phase 3A, real OAuth 2.0 / OIDC JWT identity verification remains pending. Production gateway routes intentionally fail closed (HTTP 401).
2. **Live External Provider Credentials:** Live production provider credentials (e.g. Google Shopping API / Amazon Product Advertising API) were not configured in this offline sandbox environment. The system operates with full fidelity using the deterministic `MockProductDiscoveryProvider`.
