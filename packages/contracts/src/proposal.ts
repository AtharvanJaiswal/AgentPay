import { z } from 'zod';
import { CurrencySchema, MinorUnitsSchema, PositiveMinorUnitsSchema } from './common.js';

export const ProposalItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceMinor: MinorUnitsSchema,
  currency: CurrencySchema,
});
export type ProposalItem = z.infer<typeof ProposalItemSchema>;

export const MerchantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
});
export type Merchant = z.infer<typeof MerchantSchema>;

export const PurchaseProposalSchema = z.object({
  id: z.string().uuid(),
  intentId: z.string().uuid(),
  agentId: z.string().min(1),
  merchant: MerchantSchema,
  items: z.array(ProposalItemSchema).min(1, 'Proposal must contain at least one item'),
  totalAmountMinor: PositiveMinorUnitsSchema,
  currency: CurrencySchema,
  purpose: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type PurchaseProposal = z.infer<typeof PurchaseProposalSchema>;

export const CreateProposalInputSchema = z.object({
  rawIntent: z.string().min(1, 'Raw intent text cannot be empty'),
  agentId: z.string().default('agent-assistant-01'),
});
export type CreateProposalInput = z.infer<typeof CreateProposalInputSchema>;
