# Phase 3C Algorithms and Invariants
## Human-in-the-Loop Purchase Authorization Dashboard

**Date:** 2026-10-26  
**Author:** Principal Software Architect & Application Security Engineer  
**Scope:** Algorithm complexity, financial formulas, concurrency, idempotency, and lifecycle state invariants.

---

## 1. Product Candidate Processing Algorithms

### 1.1 Query Normalization Algorithm
Defined in `normalizeSearchQuery`:
1. Unicode NFKC normalization (`rawQuery.normalize('NFKC')`).
2. Regex replacement of C0, C1, and delete control characters (`/[\u0000-\u001F\u007F-\u009F]/g`).
3. Space collapse (`/\s+/g` -> single space) and trim.
4. Input bounds check: Non-empty string, maximum length bounded to 120 characters.
- **Time Complexity:** $O(L)$ where $L$ is the character length of the raw query ($L \le 120$).
- **Space Complexity:** $O(L)$ auxiliary memory.

### 1.2 Hash-Based Deduplication Algorithm
Defined in `deduplicateCandidates`:
1. Initialize a hash set `seen` of unique candidate deduplication keys (`${providerId}:${providerProductId}`).
2. Iterate through candidate array of size $n$:
   - If `key` is not in `seen`, add `key` to `seen` and push candidate into `deduplicated` array.
- **Time Complexity:** $O(n)$ expected time with $O(1)$ hash set lookups and insertions.
- **Space Complexity:** $O(n)$ auxiliary memory for the hash set and returned array.

### 1.3 Deterministic Scoring and Ranking Algorithm
Defined in `rankCandidates`:
1. Normalize query tokens: $T = \{t_1, t_2, \dots, t_k\}$.
2. For each candidate $c_i$:
   - **SKU/Exact Model Match (+40):** If product ID or exact query matches title.
   - **Token Overlap (up to +30):** $\text{round}\left(\frac{\text{matchedTokens}}{|T|} \times 30\right)$.
   - **Merchant Match (+20):** If merchant name/ID matches user preference.
   - **In-Stock & Verified (+10, +5):** Availability and provider verification bonuses.
3. **Sorting:** Sort descending by score. Tie-breaker: Lexicographical sort on `providerProductId` (`localeCompare`).
- **Time Complexity:** Scoring takes $O(n \cdot |T| \cdot W)$ where $W$ is average word length; sorting takes $O(n \log n)$. Overall time complexity is $O(n \log n)$ bounded by $n \le 50$.
- **Disambiguation Invariant:** If multiple candidates are returned, status is `SELECTION_REQUIRED`. **The system never automatically selects or approves the first result.**

---

## 2. Currency-Safe Total Calculation Formulas

### 2.1 Integer Minor Unit Rules
- Floating-point arithmetic (`0.1 + 0.2 = 0.30000000000000004`) is strictly prohibited for monetary totals, unit prices, comparisons, and database persistence.
- All amounts are represented as safe integer minor units (e.g. cents for USD/EUR, yen for JPY, fils for KWD/BHD).
- **Line Item Total:**
  $$\text{line\_total\_minor} = \text{unit\_price\_minor} \times \text{quantity}$$
- **Proposal Total:**
  $$\text{total\_minor} = \sum_{i=1}^k (\text{unit\_price\_minor}_i \times \text{quantity}_i) + \text{tax\_minor} + \text{shipping\_minor}$$
- **Integer Overflow Protection:**
  Checked via `safeIntegerMultiply` and `safeIntegerAdd` in `packages/contracts/src/common.ts`:
  ```ts
  if (result > Number.MAX_SAFE_INTEGER || result < Number.MIN_SAFE_INTEGER) {
    throw new Error('Integer multiplication overflow: exceeds safe integer bounds');
  }
  ```

### 2.2 Currency Precision Registry
| Currency | Decimals | Minor Unit Equivalent | Formatted Example (12500 minor units) |
| :--- | :--- | :--- | :--- |
| **USD** | 2 | Cents ($1.00 = 100) | `$125.00` |
| **EUR** | 2 | Cents (€1.00 = 100) | `€125.00` |
| **GBP** | 2 | Pence (£1.00 = 100) | `£125.00` |
| **JPY** | 0 | Yen (¥1 = 1) | `¥12,500` |
| **KWD** | 3 | Fils (1 KWD = 1000) | `KWD 12.500` |
| **BHD** | 3 | Fils (1 BHD = 1000) | `BHD 12.500` |

Display formatting uses `Intl.NumberFormat` only at the presentation boundary, converting minor units by dividing by $10^{\text{decimals}}$ only for display.

---

## 3. Server-Authoritative Policy Engine Invariants

The Policy Service (`DeterministicPolicyEvaluator`) evaluates 5 rules deterministically:
1. **Currency Check:** Currency must equal `DEFAULT_ALLOWED_CURRENCY` (default `USD`).
2. **Amount Consistency:** $\sum (\text{unitPriceMinor}_i \times \text{quantity}_i) \equiv \text{totalAmountMinor}$.
3. **Category Blacklist:** Merchant category must not be in `RESTRICTED_CATEGORIES` (`gambling,cryptocurrency,weapons,adult_entertainment`).
4. **Platform Hard Ceiling:** $\text{totalAmountMinor} \le \text{MAX\_TRANSACTION\_LIMIT\_MINOR}$ ($200,000 minor units = $2,000.00). Strict inequality `>` triggers immediate policy `DENY`.
5. **User Budget Constraint:** If `userBudgetMinor` specified, $\text{totalAmountMinor} \le \text{userBudgetMinor}$. Strict inequality `>` triggers policy `DENY`.
6. **Human Approval Threshold:**
   - If $\text{totalAmountMinor} > \text{APPROVAL\_THRESHOLD\_MINOR}$ ($50,000 minor units = $500.00), outcome is `REQUIRE_APPROVAL` with code `REQUIRE_APPROVAL_HIGH_VALUE`. Proposal status becomes `POLICY_REVIEW_REQUIRED`.
   - If $\text{totalAmountMinor} \le \text{APPROVAL\_THRESHOLD\_MINOR}$, outcome is `ALLOW`. Proposal status becomes `READY_FOR_REVIEW`.

**Client Invariant:** The client browser never computes policy outcomes. Any policy outcome or budget comparison displayed in the UI is sourced directly from the validated server `PolicyDecision`.

---

## 4. State-Transition and Concurrency Algorithm

### 4.1 Allowed Lifecycle Transitions
```
READY_FOR_REVIEW ─────────► APPROVED (Human Authorization)
READY_FOR_REVIEW ─────────► CANCELLED (Human Rejection)
POLICY_REVIEW_REQUIRED ────► APPROVED (Human Authorization)
POLICY_REVIEW_REQUIRED ────► CANCELLED (Human Rejection)
```
Any attempt to transition an already `APPROVED`, `CANCELLED`, `EXPIRED`, or `POLICY_DENIED` proposal to `APPROVED` or `READY_FOR_REVIEW` returns HTTP 400 `INVALID_STATE_TRANSITION`.

### 4.2 Database Concurrency and Row Locking
In `PostgresProposalRepository`:
1. Start database transaction: `BEGIN`.
2. Acquire exclusive row-level lock:
   ```sql
   SELECT * FROM purchase_proposals WHERE id = $1 FOR UPDATE;
   ```
3. Verify principal ownership: `existing.principal_id === expectedPrincipalId`.
4. Validate transition: `isValidProposalStatusTransition(existing.status, newStatus)`.
5. Update state atomically:
   ```sql
   UPDATE purchase_proposals SET status = $2, metadata = $3, updated_at = NOW() WHERE id = $1;
   ```
6. Commit transaction: `COMMIT`.
- **Target Complexity:** $O(1)$ logical execution time with indexed B-tree primary key lookup ($O(\log N)$).
- **Concurrency Guarantee:** Concurrent decision requests on the same proposal serialize on the row lock; at most one valid state transition succeeds.

---

## 5. Idempotency Guarantees
- Proposals are scoped by `idempotency_scope` (`principal:${principalId}`) and `idempotency_key`.
- An identical retry returns the cached durable proposal without re-evaluating or re-creating records.
- A conflicting payload with the same key returns HTTP 409 `IDEMPOTENCY_CONFLICT`.
- Approval and rejection transitions are idempotent: an approval request submitted on an already approved proposal by the same principal does not produce duplicate transitions or duplicate decision audit events.
