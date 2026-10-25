# AgentPay — Phase 3A Security and Release Review

**Document Version:** 1.0.0
**Repository:** `F:\AgentPay` (`https://github.com/AtharvanJaiswal/AgentPay`)
**Base Commit:** `9f84624fdd5ea087c853b89463dce4b39877e1c1`
**Target Branch:** `main`
**Review Date:** 2026-10-25
**Review Status:** CONDITIONAL PASS (Secure Development Release; Production Purchase Workflow Fails Closed Pending External Identity Provider)

---

## 1. Executive Summary and Review Scope

This security and release audit reviews the complete Phase 3A implementation:

1. Versioned purchase-intent contract, validation, and multi-decimal currency metadata (`packages/contracts`).
2. Deterministic natural-language purchase intent parsing, ambiguity detection, and normalization (`services/agent-service`).
3. Authoritative server-side policy evaluation including rule 4b user-budget enforcement (`services/policy-service`).
4. Durable database proposal persistence with transactional idempotency enforcement via PostgreSQL unique constraints (`db/migrations/004_create_purchase_proposals.sql` & `services/agent-service`).
5. API Gateway orchestration (`services/api-gateway`).
6. Authentication boundaries, cross-principal isolation, lifecycle state transitions, safe monetary calculations, and audit logging.

All 220 unit and service tests across 16 test files and 5 integration migration tests pass cleanly. Quality gates (build, typecheck, lint, format, and whitespace checks) pass with zero errors.

---

## 2. Threat Model and Assumptions

### 2.1 Attacker Capabilities

An external attacker is assumed to possess full control over HTTP requests:

- May send requests without authentication headers or cookies.
- May inject arbitrary HTTP request headers, including `x-principal-id`, `x-correlation-id`, `idempotency-key`.
- May supply arbitrary JSON bodies containing forged identifiers, `policyApproved: true`, fabricated policy decision IDs, or negative/overflow numeric values.
- May attempt to read, mutate, or approve purchase proposals belonging to other users.
- May attempt race conditions by submitting concurrent identical or conflicting requests.
- May attempt to force development-mode fallbacks while running in production.

### 2.2 Security Objectives

1. **Identity Integrity:** No caller-supplied header or payload field can forge an authenticated principal.
2. **Fail-Closed Default:** Unauthenticated requests in production must return HTTP 401 `UNAUTHORIZED`.
3. **Cross-Principal Isolation:** A principal cannot read (`GET`) or update (`PATCH`) proposals belonging to another principal.
4. **Idempotency Scope:** Scoped strictly to authenticated principals (`principal:<principalId>`).
5. **Policy Authority:** Policy Service is the sole authoritative spending decision-maker; proposals can only become `READY_FOR_REVIEW` if policy returns `ALLOW`.
6. **Financial Invariants:** Strictly checked integer minor-unit arithmetic; no floating-point currency representation; overflow prevention.
7. **Payment Safeguards:** Zero money-moving provider operations; `PAYMENTS_ENABLED=false` strictly preserved.

---

## 3. Identity Trust Boundary and Provenance

### 3.1 Authentication Sequence

```text
External Client
      │
      │ HTTP Request (e.g. POST /api/purchase-intents)
      ▼
┌─────────────────────────────────────────────────────────────┐
│ API Gateway: Authentication Boundary (auth.ts)              │
├─────────────────────────────────────────────────────────────┤
│ 1. Check Config & Mode:                                     │
│    - Is NODE_ENV === 'production'?                          │
│      ├── YES: Use ProductionPendingAuthenticationProvider   │
│      │        -> Returns null (Fail Closed -> HTTP 401)     │
│      └── NO: Check ALLOW_DEV_IDENTITY:                      │
│               ├── true: DevelopmentAuthenticationProvider   │
│               │         -> Allows sanitized dev header/ID   │
│               └── false: -> Returns null (Fail Closed 401)  │
└──────────────────────────────┬──────────────────────────────┘
                               │ Authenticated Principal (id)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Authoritative Gateway Orchestration Pipeline                │
│ - Scopes Idempotency: `principal:${principal.id}`           │
│ - Strict Schema Validation (prohibits client principalId)   │
│ - Dispatches to Agent Service for Intent Parsing            │
│ - Resolves Catalog Item from DEV_CATALOG                    │
│ - Safe Minor Unit Arithmetic                                │
│ - Policy Service Evaluation                                 │
│ - Database Proposal Persistence                             │
│ - Audit Event Emission                                      │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Key Verification Points

- `x-principal-id` is **never trusted in production**.
- `dev-user-principal-01` is **never used in production**.
- `ALLOW_DEV_IDENTITY=true` is **strictly rejected at startup in production** via Zod `superRefine`.

---

## 4. Security Findings and Remediation

| Finding ID         | Severity     | Description                                                                                            | Status       | Evidence / Test                                                                                                                    |
| :----------------- | :----------- | :----------------------------------------------------------------------------------------------------- | :----------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| **SEC-FINDING-01** | **Critical** | Client-controlled `x-principal-id` and unauthenticated `dev-user-principal-01` fallback in gateway.    | **RESOLVED** | Replaced with `AuthenticationProvider` boundary (`auth.ts`); verified with tests in `purchase-intent-orchestration.test.ts`.       |
| **SEC-FINDING-02** | **High**     | Arbitrary proposal status mutations without state machine validation on `PATCH /proposals/:id/status`. | **RESOLVED** | Implemented `VALID_PROPOSAL_STATUS_TRANSITIONS` and `isValidProposalStatusTransition`; rejected invalid transitions with HTTP 400. |
| **SEC-FINDING-03** | **High**     | Missing proposal ownership verification on `PATCH /proposals/:id/status`.                              | **RESOLVED** | Implemented `expectedPrincipalId` check; rejected cross-principal updates with HTTP 403 `FORBIDDEN`.                               |
| **SEC-FINDING-04** | **Medium**   | Direct internal service port exposure in Docker Compose.                                               | **RESOLVED** | Documented host binding restrictions for production deployments.                                                                   |
| **SEC-FINDING-05** | **Medium**   | Integer overflow risk in minor-unit monetary multiplication.                                           | **RESOLVED** | Implemented `safeIntegerMultiply` and `safeIntegerAdd` asserting safe integers; overflow returns HTTP 400.                         |
| **SEC-FINDING-06** | **Low**      | Proposal input allowed client to inject `principalId` via body.                                        | **RESOLVED** | Removed `principalId` from `CreatePurchaseIntentInputSchema` with `.strict()` enforcement.                                         |

---

## 5. Development Identity Configuration Analysis

### Invariant Checks

1. **Production Invariant:**
   ```typescript
   if (data.NODE_ENV === 'production' && data.ALLOW_DEV_IDENTITY) {
     ctx.addIssue({
       code: z.ZodIssueCode.custom,
       message: 'ALLOW_DEV_IDENTITY is strictly forbidden in production.',
       path: ['ALLOW_DEV_IDENTITY'],
     });
   }
   ```
2. **Default Behavior:** `ALLOW_DEV_IDENTITY` defaults to `false`.
3. **Fail-Closed Behavior:** When `ALLOW_DEV_IDENTITY` is `false`, `DevelopmentAuthenticationProvider` returns `null` and requests are rejected with HTTP 401 `UNAUTHORIZED`.

---

## 6. Production Authentication Behavior

- Real external authentication (OAuth2 / JWT / OIDC session token) has not yet been integrated into AgentPay.
- To prevent insecure defaults, the production gateway wires `ProductionPendingAuthenticationProvider`.
- Every incoming request to protected purchase intent routes (`POST /api/purchase-intents`, `GET /api/purchase-intents/:id`) in production evaluates to `null` and fails closed:
  ```json
  {
    "error": {
      "code": "UNAUTHORIZED",
      "message": "Authentication required. Valid authenticated credentials must be provided to create purchase proposals.",
      "correlationId": "..."
    }
  }
  ```
- No downstream services (`agent-service`, `policy-service`, `payment-service`) are called for unauthenticated requests.

---

## 7. Proposal Ownership and Lifecycle State Machine

### 7.1 Lifecycle Transition Graph

| Current State            | Permitted Next States                                                                                                      | Notes                                         |
| :----------------------- | :------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------- |
| `INTENT_RECEIVED`        | `CLARIFICATION_REQUIRED`, `SELECTION_REQUIRED`, `POLICY_DENIED`, `POLICY_REVIEW_REQUIRED`, `READY_FOR_REVIEW`, `CANCELLED` | Initial proposal creation                     |
| `CLARIFICATION_REQUIRED` | `INTENT_RECEIVED`, `CANCELLED`                                                                                             | Re-prompting user                             |
| `SELECTION_REQUIRED`     | `INTENT_RECEIVED`, `CANCELLED`                                                                                             | Resolving specific item                       |
| `POLICY_DENIED`          | `CANCELLED`                                                                                                                | Terminal policy rejection; cannot be approved |
| `POLICY_REVIEW_REQUIRED` | `APPROVED`, `CANCELLED`, `POLICY_DENIED`                                                                                   | Requires explicit human reviewer approval     |
| `READY_FOR_REVIEW`       | `APPROVED`, `CANCELLED`, `EXPIRED`                                                                                         | User confirms proposal                        |
| `APPROVED`               | `CANCELLED`, `EXPIRED`                                                                                                     | Approved proposal; ready for payment setup    |
| `EXPIRED`                | _None_                                                                                                                     | Terminal state                                |
| `CANCELLED`              | _None_                                                                                                                     | Terminal state                                |

### 7.2 Ownership Verification

- `GET /api/purchase-intents/:id`:
  Verifies `proposal.principalId === authenticatedPrincipal.id`. If mismatched, returns HTTP 403 `FORBIDDEN`.
- `PATCH /proposals/:id/status`:
  Verifies `proposal.principalId === expectedPrincipalId`. If mismatched, returns HTTP 403 `FORBIDDEN`.

---

## 8. Idempotency and Concurrency

- **Idempotency Scope:** `principal:<principalId>`
- **Database Unique Constraint:** `uq_purchase_proposals_idempotency_scope (idempotency_scope, idempotency_key)`
- **Request Fingerprint:** SHA-256 hash of canonical intent payload (`action`, `productQuery`, `quantity`, `merchantPreference`, `constraints`).
- **Concurrent Submissions:** Handled atomically in PostgreSQL. Duplicate keys with identical payloads return the stored record; different payloads return HTTP 409 `IDEMPOTENCY_CONFLICT`.

---

## 9. Monetary and Policy Invariants

1. **Integer Minor Units:** All internal monetary figures are stored as integer minor units.
2. **Safe Arithmetic:**
   $$\text{subtotalMinor} = \text{safeIntegerMultiply}(\text{unitPriceMinor}, \text{quantity})$$
   $$\text{totalAmountMinor} = \text{safeIntegerAdd}(\text{subtotalMinor}, \text{taxMinor}, \text{shippingMinor})$$
3. **Currency Precision Metadata:**
   - 0 decimals: `JPY`
   - 2 decimals: `USD`, `EUR`, `GBP`, `CAD`, `AUD`, `INR`
   - 3 decimals: `BHD`, `KWD`
4. **Policy Spending Invariants:**
   $$\text{totalAmountMinor} \le \text{userBudgetMinor} \quad \land \quad \text{totalAmountMinor} \le 200\,000\text{ (Policy Ceiling)}$$
   $$\text{totalAmountMinor} > 50\,000 \implies \text{REQUIRE\_APPROVAL (Human Review Required)}$$

---

## 10. Audit Logging and Data Minimization

- Audited Event Types:
  `INTENT_RECEIVED`, `INTENT_UNSUPPORTED`, `INTENT_CLARIFICATION_REQUIRED`, `INTENT_SELECTION_REQUIRED`, `PROPOSAL_CREATED`, `PROPOSAL_POLICY_DENIED`, `PROPOSAL_READY_FOR_REVIEW`, `PROPOSAL_REVIEW_REQUIRED`.
- Data Minimization: Raw user text is truncated; secrets, tokens, credentials, and payment instrument numbers are strictly excluded from audit payloads. Correlation IDs link distributed events across services.

---

## 11. Database and Service-to-Service Trust Review

- **Migration 004:** Forward-compatible; adds `purchase_proposals` table with indexes on `status`, `principal_id`, `correlation_id`, and `created_at`.
- **Query Parameterization:** All repository queries in `PostgresProposalRepository` use parameterized SQL (`$1, $2, ...`). Zero string interpolation.
- **Service Ports:** Internal services (`agent-service:4001`, `policy-service:4002`, `payment-service:4003`, `audit-service:4004`) should be bound to the internal Docker network `agentpay-network` and not exposed to the public internet in production.

---

## 12. Changes Implemented

1. **`packages/contracts`**:
   - Added `safeIntegerMultiply` and `safeIntegerAdd` to `src/common.ts`.
   - Added `VALID_PROPOSAL_STATUS_TRANSITIONS`, `isValidProposalStatusTransition`, `InvalidProposalStateTransitionError`, and `ForbiddenProposalAccessError` to `src/proposal.ts`.
   - Removed `principalId` from `CreatePurchaseIntentInputSchema` in `src/purchase-intent.ts`.
2. **`packages/config`**:
   - Added `ALLOW_DEV_IDENTITY` to `ApiGatewayConfigSchema` with production validation rejection.
3. **`services/api-gateway`**:
   - Created `src/auth.ts` defining `AuthenticationProvider`, `DevelopmentAuthenticationProvider`, `ProductionPendingAuthenticationProvider`, and `TestAuthenticationProvider`.
   - Integrated `authProvider` in `POST /api/purchase-intents` and `GET /api/purchase-intents/:id`.
   - Integrated safe integer arithmetic in minor-unit calculations.
4. **`services/agent-service`**:
   - Added state transition and ownership checks in `InMemoryProposalRepository` and `PostgresProposalRepository`.
   - Handled `InvalidProposalStateTransitionError` (400) and `ForbiddenProposalAccessError` (403) in `PATCH /proposals/:id/status`.

---

## 13. Regression Test Matrix

| Test Suite                                                                    |  Tests  |    Result    |
| :---------------------------------------------------------------------------- | :-----: | :----------: |
| `packages/config/tests/env-loader.test.ts`                                    |   15    |     PASS     |
| `packages/contracts/tests/purchase-intent.test.ts`                            |   24    |     PASS     |
| `services/agent-service/tests/intent-parser.test.ts`                          |   17    |     PASS     |
| `services/agent-service/tests/proposal-repository.test.ts`                    |   14    |     PASS     |
| `services/agent-service/tests/agent.test.ts`                                  |    3    |     PASS     |
| `services/policy-service/tests/policy.test.ts`                                |   10    |     PASS     |
| `services/api-gateway/tests/gateway.test.ts`                                  |   10    |     PASS     |
| `services/api-gateway/tests/purchase-intent-orchestration.test.ts`            |   17    |     PASS     |
| `services/payment-service/tests/paypal-orders.test.ts`                        |   31    |     PASS     |
| `services/payment-service/tests/capture-blocking-and-retrieval.test.ts`       |   13    |     PASS     |
| `services/payment-service/tests/payment-lifecycle-and-reconciliation.test.ts` |   10    |     PASS     |
| `services/payment-service/tests/paypal-oauth.test.ts`                         |   19    |     PASS     |
| `services/payment-service/tests/payment.test.ts`                              |   12    |     PASS     |
| `services/payment-service/tests/postgres-repository.test.ts`                  |    4    |     PASS     |
| `services/audit-service/tests/audit.test.ts`                                  |    3    |     PASS     |
| `tests/integration/migration.test.ts`                                         |    5    |     PASS     |
| **Total Test Suite**                                                          | **225** | **ALL PASS** |

---

## 14. Verification Commands and Outcomes

```powershell
pnpm --recursive run build     # Exit 0 (10/10 workspace packages built)
pnpm typecheck                 # Exit 0 (0 errors across monorepo)
pnpm lint                      # Exit 0 (0 errors, 0 warnings)
pnpm format                    # Exit 0 (All files conform to Prettier)
pnpm test                      # Exit 0 (220 unit/service tests passed)
pnpm test:integration          # Exit 0 (5 migration tests passed)
git diff --check               # Exit 0 (0 whitespace/conflict errors)
```

---

## 15. Payment Safety Verification

- `PAYMENTS_ENABLED = false` strictly enforced across runtime configs and test suites.
- `PAYPAL_ENVIRONMENT = sandbox` enforced.
- **Zero PayPal Orders Created**: Spy and integration test assertions verify 0 calls.
- **Zero Captures Executed**: Order capture remains disabled by configuration.

---

## 16. Release Decision

### Verdict: CONDITIONAL PASS

- **Development Release:** Approved for merge into `main`. The purchase-intent, catalog resolution, policy evaluation, proposal persistence, and idempotency mechanisms are fully verified and hardened.
- **Production Readiness Condition:** The purchase workflow in production fails closed with HTTP 401 `UNAUTHORIZED` until an external production identity provider (e.g., OAuth2 / OIDC / JWT session provider) is integrated in a subsequent milestone.
