# Phase 3C — Security Audit & Threat Assessment
## Human-in-the-Loop Purchase Authorization Dashboard

### 1. Security Invariants & Policy Boundaries

| Security Domain | Phase 3C Policy | Enforcement Mechanism | Verification Status |
| :--- | :--- | :--- | :--- |
| **Payment Safety** | Zero payment operations allowed during authorization | `PAYMENTS_ENABLED=false` flag; Gateway blocks order creation; Payment spy asserts 0 calls on approve/reject | VERIFIED |
| **Authentication** | Fail-closed in production; dev mode strictly gated | `ProductionPendingAuthenticationProvider` returns 401; `ALLOW_DEV_IDENTITY=true` allowed only when configured | VERIFIED |
| **Ownership Isolation** | Strict tenancy per principal | Server-side principal verification on all read/write proposal endpoints & audit logs (returns 403) | VERIFIED |
| **Financial Integrity** | Minor-unit integer arithmetic only | Zero floating point in backend; safe integer bounds checked; strict currency precision rules | VERIFIED |
| **State Machine** | Non-reviewable proposals cannot transition | Explicit state checks on `approve` and `reject` reject invalid transitions with 400/409 | VERIFIED |
| **Audit Immutability** | Append-only verifiable audit trail | Synchronous write to `audit_events` on all lifecycle events and decisions | VERIFIED |

---

### 2. Threat Analysis & Mitigations (STRIDE Matrix)

#### 2.1 Spoofing & Identity Impersonation
- **Threat**: Attacker sends forged `x-principal-id` in production to authorize a transaction.
- **Mitigation**: `ProductionPendingAuthenticationProvider` fails closed, rejecting all requests unless legitimate production tokens are validated. Development identity is enabled only when explicitly permitted in dev environments.
- **Test Evidence**: `phase3c-authorization.test.ts` (test: "production mode fails closed with 401 UNAUTHORIZED").

#### 2.2 Tampering & Price Manipulation
- **Threat**: Attacker modifies the unit price in browser memory before submitting proposal creation.
- **Mitigation**: Client prices are never authoritative. API Gateway re-validates candidate against the product catalog provider. If provider price differs from `expectedUnitPriceMinor`, server rejects request with `409 PRICE_CHANGED_RECONFIRMATION_REQUIRED`.
- **Test Evidence**: `phase3c-dashboard.spec.ts` (E2E 3: "Price change conflict (409) requires explicit human reconfirmation").

#### 2.3 Repudiation & Missing Accountability
- **Threat**: Operator denies having approved or rejected a purchase proposal.
- **Mitigation**: Every decision records a permanent `AuditEvent` (`PROPOSAL_APPROVED` or `PROPOSAL_REJECTED`) containing the authenticated actor principal ID, timestamp, proposal ID, monetary total, policy decision ID, and optional operator note.
- **Test Evidence**: `phase3c-dashboard.spec.ts` (E2E 4 & E2E 5: Verifiable audit event rendering in UI and persistence in audit database).

#### 2.4 Information Disclosure & Cross-Tenant Data Leaks
- **Threat**: Principal A attempts to view, approve, or read audit history of Principal B's proposal by guessing proposal UUID.
- **Mitigation**: Every endpoint (`GET /api/purchase-intents/:id`, `POST /approve`, `POST /reject`, `GET /audit-events`) verifies `proposal.principalId === principal.id`. Mismatches return `403 FORBIDDEN` without revealing proposal metadata.
- **Test Evidence**: `phase3c-dashboard.spec.ts` (E2E 7: "Ownership isolation between principals prevents unauthorized access").

#### 2.5 Denial of Service & Replay Attacks
- **Threat**: Operator clicks "Approve" repeatedly or attacker replays proposal creation requests.
- **Mitigation**: UI disables action buttons during submission. Backend enforces idempotency via `idempotencyKey` and returns identical proposal without re-evaluating or creating duplicates. Conflicting transitions on already approved/rejected proposals return idempotent success or transition conflicts without duplicate audit logs.
- **Test Evidence**: `phase3c-dashboard.spec.ts` (E2E 8: "Duplicate submissions are guarded in UI and idempotent on backend").

#### 2.6 Elevation of Privilege & Autonomous Checkout Bypass
- **Threat**: Approving a proposal accidentally triggers PayPal order creation or capture.
- **Mitigation**: Authorization and payment execution are completely separated. The approve endpoint only modifies proposal status to `APPROVED` and logs the audit event. No payment service endpoints are called. Additionally, `PAYMENTS_ENABLED=false` blocks any payment API attempts.
- **Test Evidence**: `phase3c-dashboard.spec.ts` (E2E 10: "Payment safety invariant: proposal decision records authorization only, zero payment calls").

---

### 3. Remaining Limitations

1. **Production Identity System**: Real OIDC / OAuth2 JWT bearer token validation is pending (planned for future phases). Production authentication currently fails closed as intended.
2. **Provider Failures**: External catalog provider timeouts trigger `504 GATEWAY_TIMEOUT` and are displayed gracefully to the operator with retry options.
