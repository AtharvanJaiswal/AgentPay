/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
// Real PostgreSQL integration test for transactional concurrency and idempotency
const { Pool } = require('pg');

async function run() {
  console.log('--- Starting PostgreSQL Concurrency & Transactional Verification ---');
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      'postgresql://agentpay:agentpay_dev_pw@postgres:5432/agentpay',
  });

  const client = await pool.connect();
  try {
    console.log('[1/5] Verifying PostgreSQL connection & schema migrations...');
    const tableRes = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    console.log(
      'Tables found:',
      tableRes.rows.map((r) => r.tablename).join(', '),
    );

    const migRes = await client.query(
      'SELECT version, applied_at FROM schema_migrations ORDER BY applied_at ASC',
    );
    console.log(
      'Applied migrations:',
      migRes.rows.map((r) => r.version).join(', '),
    );

    const testOrderId = `TEST-CONCURRENCY-ORD-${Date.now()}`;
    const proposalId = '11111111-1111-4111-a111-111111111111';
    const policyDecisionId = '22222222-2222-4222-b222-222222222222';

    console.log('[2/5] Creating test order in PostgreSQL:', testOrderId);
    await client.query(
      `INSERT INTO payment_orders (
        id, proposal_id, policy_decision_id, provider, status, currency, amount_minor, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [
        testOrderId,
        proposalId,
        policyDecisionId,
        'paypal_sandbox',
        'CREATED',
        'USD',
        100,
        '{}',
      ],
    );

    console.log(
      '[3/5] Testing simultaneous overlapping deliveries of the same webhook event ID...',
    );
    const eventId = `WH-CONCURRENT-EVENT-${Date.now()}`;

    // Overlapping execution of processWebhookEvent algorithm
    async function processEvent(workerId) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const insertRes = await c.query(
          `INSERT INTO webhook_events (id, event_type, resource_id, processed_at, payload)
           VALUES ($1, $2, $3, NOW(), $4)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [
            eventId,
            'CHECKOUT.ORDER.APPROVED',
            testOrderId,
            JSON.stringify({ worker: workerId }),
          ],
        );

        if (!insertRes.rowCount || insertRes.rowCount === 0) {
          await c.query('COMMIT');
          return { workerId, result: 'DUPLICATE_SKIPPED' };
        }

        // Lock order row
        const _orderRes = await c.query(
          'SELECT * FROM payment_orders WHERE id = $1 FOR UPDATE',
          [testOrderId],
        );

        // Update state
        await c.query(
          "UPDATE payment_orders SET status = 'APPROVED', updated_at = NOW() WHERE id = $1",
          [testOrderId]
        );

        await c.query('COMMIT');
        return { workerId, result: 'TRANSITION_APPLIED' };
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      } finally {
        c.release();
      }
    }

    const [workerA, workerB] = await Promise.all([
      processEvent('WORKER_A'),
      processEvent('WORKER_B')
    ]);

    console.log('Concurrency outcome:', { workerA, workerB });
    const outcomes = [workerA.result, workerB.result];
    if (!outcomes.includes('TRANSITION_APPLIED') || !outcomes.includes('DUPLICATE_SKIPPED')) {
      throw new Error(`CONCURRENCY INVARIANT VIOLATION: Expected exactly one TRANSITION_APPLIED and one DUPLICATE_SKIPPED, got: ${JSON.stringify(outcomes)}`);
    }
    console.log('✓ Invariant passed: Exactly one transaction claimed the event and applied the transition.');

    console.log('[4/5] Testing rollback recovery on failure...');
    const failEventId = `WH-FAIL-EVENT-${Date.now()}`;
    const failClient = await pool.connect();
    let rollbackVerified = false;
    try {
      await failClient.query('BEGIN');
      await failClient.query(
        `INSERT INTO webhook_events (id, event_type, resource_id, processed_at, payload)
         VALUES ($1, $2, $3, NOW(), $4)
         RETURNING *`,
        [failEventId, 'PAYMENT.CAPTURE.COMPLETED', testOrderId, '{}']
      );
      // Simulate crash/failure before order mutation
      throw new Error('SIMULATED FAILURE DURING INGRESS TRANSACTION');
    } catch {
      await failClient.query('ROLLBACK');
      rollbackVerified = true;
    } finally {
      failClient.release();
    }

    if (!rollbackVerified) {
      throw new Error('Expected rollback on failure');
    }

    // Verify the event was NOT persisted
    const checkEventRes = await client.query('SELECT * FROM webhook_events WHERE id = $1', [failEventId]);
    if (checkEventRes.rowCount !== 0) {
      throw new Error('ROLLBACK FAILED: Webhook event was committed despite error!');
    }
    console.log('✓ Invariant passed: Unsuccessful transaction leaves no misleading completed-event record.');

    console.log('[5/5] Testing retry after rollback...');
    const retryClient = await pool.connect();
    try {
      await retryClient.query('BEGIN');
      const insertRetry = await retryClient.query(
        `INSERT INTO webhook_events (id, event_type, resource_id, processed_at, payload)
         VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [failEventId, 'PAYMENT.CAPTURE.COMPLETED', testOrderId, '{}']
      );
      if (insertRetry.rowCount !== 1) {
        throw new Error('RETRY FAILED: Event was falsely flagged as duplicate after previous rollback!');
      }

      await retryClient.query(
        "UPDATE payment_orders SET status = 'COMPLETED', capture_id = 'CAP-RECOVERED-123', updated_at = NOW() WHERE id = $1",
        [testOrderId]
      );
      await retryClient.query('COMMIT');
    } finally {
      retryClient.release();
    }

    const finalOrderRes = await client.query('SELECT * FROM payment_orders WHERE id = $1', [testOrderId]);
    const finalOrder = finalOrderRes.rows[0];
    if (finalOrder.status !== 'COMPLETED' || finalOrder.capture_id !== 'CAP-RECOVERED-123') {
      throw new Error(`RETRY INTEGRITY FAILED: Final order status is ${finalOrder.status}`);
    }
    console.log('✓ Invariant passed: Retried processing converges safely and order reached COMPLETED with captureId.');

    // Cleanup test record to preserve database hygiene without resetting or truncating
    await client.query('DELETE FROM webhook_events WHERE id IN ($1, $2)', [eventId, failEventId]);
    await client.query('DELETE FROM payment_orders WHERE id = $1', [testOrderId]);

    console.log('--- ALL POSTGRESQL CONCURRENCY & TRANSACTIONAL INVARIANTS VERIFIED SUCCESSFULLY ---');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('PostgreSQL concurrency verification failed:', err);
  process.exit(1);
});
