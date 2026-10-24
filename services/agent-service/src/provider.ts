import { v4 as uuidv4 } from 'uuid';
import type { AIProvider, PurchaseProposal, ProposalItem } from '@agentpay/contracts';

interface CatalogItem {
  id: string;
  name: string;
  unitPriceMinor: number;
  currency: string;
  merchantId: string;
  merchantName: string;
  category: string;
}

// Authoritative development catalog. Prices and merchants are verified by the platform,
// never dictated by client or unverified LLM text.
const DEV_CATALOG: CatalogItem[] = [
  {
    id: 'sku-cloud-compute-micro',
    name: 'Cloud Virtual Machine - Micro Tier (1 Month)',
    unitPriceMinor: 1500, // $15.00
    currency: 'USD',
    merchantId: 'm-cloud-infra-01',
    merchantName: 'CloudInfra Global',
    category: 'cloud_services',
  },
  {
    id: 'sku-domain-registration',
    name: 'Domain Name Registration (1 Year)',
    unitPriceMinor: 2000, // $20.00
    currency: 'USD',
    merchantId: 'm-domain-registrar-01',
    merchantName: 'SecureName Registrars',
    category: 'domain_services',
  },
  {
    id: 'sku-enterprise-db-cluster',
    name: 'Managed Dedicated Database Cluster (1 Month)',
    unitPriceMinor: 80000, // $800.00 (triggers approval in policy service)
    currency: 'USD',
    merchantId: 'm-cloud-infra-01',
    merchantName: 'CloudInfra Global',
    category: 'cloud_services',
  },
  {
    id: 'sku-luxury-crypto-token',
    name: 'Restricted Token Asset Pack',
    unitPriceMinor: 500000, // $5,000.00 (triggers denial due to category and limit)
    currency: 'USD',
    merchantId: 'm-crypto-assets-99',
    merchantName: 'CryptoVenture Ltd',
    category: 'cryptocurrency',
  },
];

export class FixtureAIProvider implements AIProvider {
  readonly providerName = 'FixtureAIProvider (Deterministic Dev/Test)';

  async generateProposal(
    rawIntent: string,
    agentId: string,
    _correlationId: string,
  ): Promise<PurchaseProposal> {
    const intentLower = rawIntent.toLowerCase();

    // Match intent to authoritative catalog
    let matchedItem: CatalogItem = DEV_CATALOG[0]!;

    if (intentLower.includes('domain') || intentLower.includes('dns')) {
      matchedItem = DEV_CATALOG[1]!;
    } else if (
      intentLower.includes('database') ||
      intentLower.includes('cluster') ||
      intentLower.includes('high value')
    ) {
      matchedItem = DEV_CATALOG[2]!;
    } else if (
      intentLower.includes('crypto') ||
      intentLower.includes('token') ||
      intentLower.includes('gambling')
    ) {
      matchedItem = DEV_CATALOG[3]!;
    }

    const item: ProposalItem = {
      id: matchedItem.id,
      name: matchedItem.name,
      quantity: 1,
      unitPriceMinor: matchedItem.unitPriceMinor,
      currency: matchedItem.currency,
    };

    const totalAmountMinor = item.quantity * item.unitPriceMinor;

    return {
      id: uuidv4(),
      intentId: uuidv4(),
      agentId,
      merchant: {
        id: matchedItem.merchantId,
        name: matchedItem.merchantName,
        category: matchedItem.category,
      },
      items: [item],
      totalAmountMinor,
      currency: matchedItem.currency,
      purpose: `Autonomous fulfillment of intent: "${rawIntent.slice(0, 100)}"`,
      createdAt: new Date().toISOString(),
    };
  }
}
