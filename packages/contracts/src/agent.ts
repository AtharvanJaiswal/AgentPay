import type { PurchaseProposal } from './proposal.js';

export interface AIProvider {
  readonly providerName: string;
  generateProposal(
    rawIntent: string,
    agentId: string,
    correlationId: string,
  ): Promise<PurchaseProposal>;
}
