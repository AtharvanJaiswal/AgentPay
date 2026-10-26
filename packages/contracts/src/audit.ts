import { z } from 'zod';

export const AuditEventTypeSchema = z.enum([
  'INTENT_RECEIVED',
  'INTENT_UNSUPPORTED',
  'INTENT_CLARIFICATION_REQUIRED',
  'INTENT_SELECTION_REQUIRED',
  'PRODUCT_SEARCH_REQUESTED',
  'PRODUCT_SEARCH_SUCCEEDED',
  'PRODUCT_SEARCH_FAILED',
  'PRODUCT_SELECTION_REQUESTED',
  'PRODUCT_REVALIDATED',
  'PRODUCT_REVALIDATION_FAILED',
  'PRODUCT_PRICE_CHANGED',
  'PROPOSAL_CREATED',
  'PROPOSAL_POLICY_DENIED',
  'PROPOSAL_READY_FOR_REVIEW',
  'PROPOSAL_REVIEW_REQUIRED',
  'POLICY_EVALUATION_STARTED',
  'POLICY_EVALUATED_ALLOW',
  'POLICY_EVALUATED_DENY',
  'POLICY_EVALUATED_APPROVAL_REQUIRED',
  'ORDER_CREATION_ATTEMPTED',
  'ORDER_CREATED',
  'ORDER_CAPTURE_ATTEMPTED',
  'ORDER_CAPTURED',
  'PAYMENT_BLOCKED',
  'PROPOSAL_APPROVED',
  'PROPOSAL_REJECTED',
  'SYSTEM_SECURITY_ALERT',
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditEventSchema = z.object({
  id: z.string().uuid(),
  correlationId: z.string().min(1),
  eventType: AuditEventTypeSchema,
  actor: z.string().min(1),
  resourceId: z.string().min(1),
  timestamp: z.string().datetime(),
  metadata: z.record(z.unknown()),
  outcome: z.string().optional(),
  reasonCode: z.string().optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const CreateAuditEventInputSchema = AuditEventSchema.omit({
  id: true,
  timestamp: true,
}).extend({
  id: z.string().uuid().optional(),
  timestamp: z.string().datetime().optional(),
});
export type CreateAuditEventInput = z.infer<typeof CreateAuditEventInputSchema>;

export interface AuditRepository {
  recordEvent(event: CreateAuditEventInput): Promise<AuditEvent>;
  listEvents(limit?: number, correlationId?: string, resourceId?: string): Promise<AuditEvent[]>;
}
