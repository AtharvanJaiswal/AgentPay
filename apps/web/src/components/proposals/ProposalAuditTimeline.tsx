import React, { useEffect, useState, useCallback } from 'react';
import type { AuditEvent } from '@agentpay/contracts';
import { defaultApiClient } from '../../lib/api/client';
import { Badge } from '../ui/Badge';

export interface ProposalAuditTimelineProps {
  proposalId: string;
}

export const ProposalAuditTimeline: React.FC<ProposalAuditTimelineProps> = ({ proposalId }) => {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAuditEvents = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await defaultApiClient.getProposalAuditEvents(proposalId);
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit history');
    } finally {
      setLoading(false);
    }
  }, [proposalId]);

  useEffect(() => {
    fetchAuditEvents();
  }, [fetchAuditEvents]);

  if (loading) {
    return (
      <div data-testid="audit-loading-state" style={{ color: 'var(--text-muted)', fontSize: '0.85rem', padding: '1rem' }}>
        Loading verifiable audit trail...
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="audit-error-state" style={{ color: 'var(--accent-rose)', fontSize: '0.85rem', padding: '1rem' }}>
        {error}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div data-testid="audit-empty-state" style={{ color: 'var(--text-dim)', fontSize: '0.85rem', padding: '1rem' }}>
        No audit records logged for this proposal yet.
      </div>
    );
  }

  return (
    <div data-testid="audit-timeline" style={{ marginTop: '1rem' }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.85rem',
          position: 'relative',
        }}
      >
        {events.map((evt) => (
          <div
            key={evt.id}
            data-testid={`audit-event-item-${evt.eventType}`}
            style={{
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--card-border)',
              borderRadius: '10px',
              padding: '0.75rem 1rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.35rem',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '0.5rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 700,
                    fontSize: '0.8rem',
                    color: 'var(--text-main)',
                  }}
                >
                  {evt.eventType}
                </span>
                {evt.outcome && <Badge status={evt.outcome} />}
              </div>

              <span
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-dim)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {new Date(evt.timestamp).toLocaleString()}
              </span>
            </div>

            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Actor: <strong style={{ color: 'var(--text-main)' }}>{evt.actor}</strong>
              {evt.reasonCode && (
                <span style={{ marginLeft: '0.75rem' }}>
                  Code: <code style={{ color: 'var(--accent-amber)' }}>{evt.reasonCode}</code>
                </span>
              )}
            </div>

            {evt.metadata && Object.keys(evt.metadata).length > 0 && (
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-dim)',
                  fontFamily: 'var(--font-mono)',
                  background: 'rgba(0,0,0,0.2)',
                  padding: '0.35rem 0.5rem',
                  borderRadius: '6px',
                  marginTop: '0.2rem',
                  overflowX: 'auto',
                }}
              >
                {JSON.stringify(evt.metadata)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
