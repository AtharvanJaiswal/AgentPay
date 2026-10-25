/**
 * Authoritative development catalog.
 * Prices, categories, and merchants are authoritative and verified by the platform,
 * never dictated by client or unverified LLM text.
 */
export interface CatalogItem {
  id: string;
  name: string;
  unitPriceMinor: number;
  currency: string;
  merchantId: string;
  merchantName: string;
  category: string;
}

export const DEV_CATALOG: CatalogItem[] = [
  {
    id: 'sku-office-notebook',
    name: 'A5 Spiral Notebook',
    unitPriceMinor: 500, // $5.00
    currency: 'USD',
    merchantId: 'merch-acme-office',
    merchantName: 'Acme Office Supplies',
    category: 'office_supplies',
  },
  {
    id: 'sku-office-chair',
    name: 'Ergonomic Office Chair',
    unitPriceMinor: 18000, // $180.00
    currency: 'USD',
    merchantId: 'merch-acme-office',
    merchantName: 'Acme Office Supplies',
    category: 'office_furniture',
  },
  {
    id: 'sku-tech-mouse',
    name: 'Wireless Optical Mouse',
    unitPriceMinor: 2500, // $25.00
    currency: 'USD',
    merchantId: 'merch-tech-direct',
    merchantName: 'TechDirect',
    category: 'electronics',
  },
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

export function resolveCatalogItem(query: string, merchantPreference?: string): CatalogItem | null {
  const q = query.toLowerCase().trim();
  const m = merchantPreference?.toLowerCase().trim();

  if (m) {
    const byMerchant = DEV_CATALOG.find(
      (item) =>
        item.merchantName.toLowerCase().includes(m) || item.merchantId.toLowerCase().includes(m),
    );
    if (byMerchant) return byMerchant;
  }

  if (q.includes('notebook') || q.includes('journal') || q.includes('notepad')) {
    return DEV_CATALOG[0]!;
  }
  if (q.includes('chair') || q.includes('desk') || q.includes('furniture')) {
    return DEV_CATALOG[1]!;
  }
  if (q.includes('mouse') || q.includes('keyboard') || q.includes('electronics')) {
    return DEV_CATALOG[2]!;
  }
  if (q.includes('domain') || q.includes('dns') || q.includes('registration')) {
    return DEV_CATALOG[4]!;
  }
  if (
    q.includes('database') ||
    q.includes('db') ||
    q.includes('cluster') ||
    q.includes('high value')
  ) {
    return DEV_CATALOG[5]!;
  }
  if (q.includes('crypto') || q.includes('token') || q.includes('gambling')) {
    return DEV_CATALOG[6]!;
  }
  if (
    q.includes('cloud') ||
    q.includes('compute') ||
    q.includes('vm') ||
    q.includes('virtual machine') ||
    q.includes('server')
  ) {
    return DEV_CATALOG[3]!;
  }

  return null;
}
