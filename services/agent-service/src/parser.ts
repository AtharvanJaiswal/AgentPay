import { v4 as uuidv4 } from 'uuid';
import {
  type PurchaseIntent,
  type PurchaseIntentParser,
  type PurchaseIntentParseResult,
  PurchaseIntentSchema,
  convertDecimalToMinorUnits,
  isSupportedCurrency,
} from '@agentpay/contracts';

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₹': 'INR',
  '¥': 'JPY',
};

export class DeterministicPurchaseIntentParser implements PurchaseIntentParser {
  async parse(
    input: string,
    options?: {
      requestId?: string;
      idempotencyKey?: string;
      principalId?: string;
      locale?: string;
    },
  ): Promise<PurchaseIntentParseResult> {
    const rawInput = input ?? '';
    const normalized = this.normalizeWhitespace(rawInput);

    if (!normalized || normalized.length === 0) {
      return {
        status: 'INVALID_INPUT',
        reason: 'Input text cannot be empty or whitespace only',
        rawInput,
      };
    }

    const lower = normalized.toLowerCase();

    // 1. Detect unsupported intents (non-purchase actions)
    if (
      lower.startsWith('transfer ') ||
      lower.startsWith('send money') ||
      lower.startsWith('check balance') ||
      lower.startsWith('refund ') ||
      lower.includes('my balance') ||
      lower.startsWith('hello') ||
      lower.startsWith('hi ')
    ) {
      return {
        status: 'UNSUPPORTED_INTENT',
        reason: 'Requested action is not a purchase. Only purchase intents are supported.',
        rawInput,
      };
    }

    // Must contain purchase intent signal or imply acquisition
    const isPurchase =
      lower.startsWith('buy') ||
      lower.startsWith('purchase') ||
      lower.startsWith('order') ||
      lower.startsWith('get ') ||
      lower.startsWith('acquire ') ||
      lower.includes('need to buy') ||
      lower.includes('want to buy') ||
      lower.includes('need to order') ||
      lower.includes('spend up to');

    if (!isPurchase) {
      return {
        status: 'UNSUPPORTED_INTENT',
        reason: 'No clear purchase action detected in the request',
        rawInput,
      };
    }

    // 2. Ambiguity: "spend up to X" without product referent
    if (
      (lower.startsWith('spend up to') || lower.startsWith('budget of')) &&
      !lower.includes('for') &&
      !lower.includes('on')
    ) {
      return {
        status: 'NEEDS_CLARIFICATION',
        reason: 'Budget constraint provided without a target product or service.',
        question: 'What product or service would you like to purchase within this budget?',
        rawInput,
      };
    }

    // 3. Ambiguity: vague pronouns with no referent ("buy it", "buy this", "buy that", "buy something", "buy stuff")
    const vaguePatterns = [
      /^buy\s+(it|this|that|something|stuff|things?)(\s+please)?$/i,
      /^purchase\s+(it|this|that|something|stuff|things?)(\s+please)?$/i,
      /^order\s+(it|this|that|something|stuff|things?)(\s+please)?$/i,
    ];
    if (vaguePatterns.some((p) => p.test(normalized))) {
      return {
        status: 'NEEDS_CLARIFICATION',
        reason: 'Target product is ambiguous or unspecified',
        question: 'Could you please specify the exact product or item you would like to purchase?',
        rawInput,
      };
    }

    // 4. Ambiguity: "the cheapest / best" without product type
    if (/^(buy|purchase|order)\s+the\s+(cheapest|best|fastest)$/i.test(normalized)) {
      return {
        status: 'NEEDS_CLARIFICATION',
        reason: 'Superlative search without product category',
        question: 'What category or item are you looking for (e.g., laptop, cloud server, domain)?',
        rawInput,
      };
    }

    // 5. Quantity extraction & zero/negative check
    if (
      /\b(?:buy|purchase|order)\s+(?:0|zero)\b/i.test(normalized) ||
      /\b(?:0|zero)\s+(?:items|units|pieces|products)\b/i.test(normalized)
    ) {
      return {
        status: 'INVALID_INPUT',
        reason: 'Quantity must be greater than zero.',
        rawInput,
      };
    }

    if (/(?:^|\s)-\d+/.test(normalized)) {
      return {
        status: 'INVALID_INPUT',
        reason: 'Quantity or amount cannot be negative.',
        rawInput,
      };
    }

    let quantity = 1;
    const quantityDigitMatch = normalized.match(
      /\b(?:buy|purchase|order)\s+(\d+)\s+(?:units?|items?|pieces?|of\s+)?/i,
    );
    if (quantityDigitMatch && quantityDigitMatch[1]) {
      const q = parseInt(quantityDigitMatch[1], 10);
      if (q <= 0) {
        return {
          status: 'INVALID_INPUT',
          reason: 'Quantity must be positive',
          rawInput,
        };
      }
      quantity = q;
    } else {
      // Check word numbers
      const wordMatch = normalized.match(
        /\b(?:buy|purchase|order)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
      );
      if (wordMatch && wordMatch[1]) {
        quantity = NUMBER_WORDS[wordMatch[1].toLowerCase()] ?? 1;
      }
    }

    // 6. Currency and budget constraint extraction
    let currency: string | undefined = undefined;
    let maxUnitPriceMinor: number | undefined = undefined;
    let maxTotalMinor: number | undefined = undefined;

    // Detect currency symbol
    for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) {
      if (normalized.includes(sym)) {
        currency = code;
        break;
      }
    }

    // Detect 3-letter currency codes
    const currencyCodeMatch = normalized.match(/\b(USD|EUR|GBP|INR|JPY|CAD|AUD)\b/i);
    if (currencyCodeMatch && currencyCodeMatch[1]) {
      currency = currencyCodeMatch[1].toUpperCase();
    }

    // Budget constraints matching: "for no more than 80000 INR", "under $100", "max 50 USD", "up to 5000 INR"
    const budgetPattern =
      /(?:no\s+more\s+than|budget\s+of|under|up\s+to|at\s+most|max(?:imum)?\s+of?)\s*([$€£₹¥]?)\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?/i;
    const budgetMatch = normalized.match(budgetPattern);

    if (budgetMatch) {
      const symbol = budgetMatch[1];
      const rawNum = budgetMatch[2]?.replace(/,/g, '');
      const code = budgetMatch[3];

      const detectedCurr =
        (code ? code.toUpperCase() : symbol ? CURRENCY_SYMBOLS[symbol] : null) || currency || 'USD';
      if (!isSupportedCurrency(detectedCurr)) {
        return {
          status: 'INVALID_INPUT',
          reason: `Currency ${detectedCurr} is not supported`,
          rawInput,
        };
      }
      currency = detectedCurr;

      if (rawNum) {
        try {
          const decimalVal = parseFloat(rawNum);
          maxTotalMinor = convertDecimalToMinorUnits(decimalVal, detectedCurr);
        } catch (err) {
          return {
            status: 'INVALID_INPUT',
            reason: `Invalid monetary amount or precision: ${err instanceof Error ? err.message : String(err)}`,
            rawInput,
          };
        }
      }
    }

    // Unit price matching: "at 999.99 INR each", "at $25 per unit"
    const unitPricePattern =
      /(?:at|for)\s*([$€£₹¥]?)\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?\s*(?:each|per\s+unit|\/unit)/i;
    const unitMatch = normalized.match(unitPricePattern);
    if (unitMatch) {
      const symbol = unitMatch[1];
      const rawNum = unitMatch[2]?.replace(/,/g, '');
      const code = unitMatch[3];
      const detectedCurr =
        (code ? code.toUpperCase() : symbol ? CURRENCY_SYMBOLS[symbol] : null) || currency || 'USD';
      if (!isSupportedCurrency(detectedCurr)) {
        return {
          status: 'INVALID_INPUT',
          reason: `Currency ${detectedCurr} is not supported`,
          rawInput,
        };
      }
      currency = detectedCurr;

      if (rawNum) {
        try {
          const decimalVal = parseFloat(rawNum);
          maxUnitPriceMinor = convertDecimalToMinorUnits(decimalVal, detectedCurr);
        } catch (err) {
          return {
            status: 'INVALID_INPUT',
            reason: `Invalid unit price or precision: ${err instanceof Error ? err.message : String(err)}`,
            rawInput,
          };
        }
      }
    }

    // 7. Merchant preference extraction: "from Amazon", "from CloudInfra"
    let merchantPreference: string | undefined = undefined;
    const merchantMatch = normalized.match(
      /\bfrom\s+([A-Za-z0-9\s.-]+?)(?:\s+(?:for|under|at|with)|\s*$)/i,
    );
    if (merchantMatch && merchantMatch[1]) {
      const m = merchantMatch[1].trim();
      if (m.length > 0 && !m.toLowerCase().startsWith('no more than')) {
        merchantPreference = m;
      }
    }

    // 8. Extract clean product query
    let productQuery = normalized;
    // Strip leading verb
    productQuery = productQuery.replace(
      /^(?:i\s+need\s+to\s+|i\s+want\s+to\s+|please\s+)?(?:buy|purchase|order|get|acquire)\s+/i,
      '',
    );
    productQuery = productQuery.replace(
      /^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:units?|items?|pieces?)\s+of\s+/i,
      '',
    );
    productQuery = productQuery.replace(
      /^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+/i,
      '',
    );
    productQuery = productQuery.replace(/^(?:a|an|the)\s+/i, '');
    // Strip merchant preference suffix if present
    if (merchantPreference) {
      productQuery = productQuery.replace(
        new RegExp(`\\bfrom\\s+${merchantPreference}\\b`, 'i'),
        '',
      );
    }
    // Strip budget clauses
    productQuery = productQuery.replace(
      /(?:no\s+more\s+than|budget\s+of|under|up\s+to|at\s+most|max(?:imum)?\s+of?)\s*[$€£₹¥]?\s*[\d,]+(?:\.\d+)?\s*[A-Za-z]{0,3}/gi,
      '',
    );
    // Strip unit price clauses
    productQuery = productQuery.replace(
      /(?:at|for)\s*[$€£₹¥]?\s*[\d,]+(?:\.\d+)?\s*[A-Za-z]{0,3}\s*(?:each|per\s+unit|\/unit)/gi,
      '',
    );
    productQuery = productQuery.replace(/\b(for|with|in)\s*$/i, '');
    productQuery = this.normalizeWhitespace(productQuery);

    if (!productQuery || productQuery.length === 0) {
      return {
        status: 'NEEDS_CLARIFICATION',
        reason: 'Could not extract a specific product query from the request',
        question: 'Which specific product or service would you like to buy?',
        rawInput,
      };
    }

    // Build canonical PurchaseIntent object
    const requestId = options?.requestId || uuidv4();
    const idempotencyKey = options?.idempotencyKey || `intent-${uuidv4()}`;

    const constraints =
      maxUnitPriceMinor !== undefined || maxTotalMinor !== undefined || currency !== undefined
        ? {
            maxUnitPriceMinor,
            maxTotalMinor,
            currency,
          }
        : undefined;

    const intentPayload: PurchaseIntent = {
      schemaVersion: 1,
      requestId,
      idempotencyKey,
      intent: {
        action: 'purchase',
        productQuery,
        merchantPreference,
        quantity,
        constraints,
      },
      context: {
        source: 'user',
        locale: options?.locale,
        principalId: options?.principalId,
      },
    };

    const validated = PurchaseIntentSchema.safeParse(intentPayload);
    if (!validated.success) {
      return {
        status: 'INVALID_INPUT',
        reason: 'Extracted intent failed schema validation',
        validationErrors: validated.error.issues,
        rawInput,
      };
    }

    return {
      status: 'PARSED',
      intent: validated.data,
      confidence: 0.95,
      rawInput,
    };
  }

  private normalizeWhitespace(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
  }
}
