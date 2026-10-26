import React, { useState } from 'react';
import { Button } from '../ui/Button';

export interface ProductSearchFormProps {
  onSearch: (query: string, merchantPreference?: string) => Promise<void>;
  loading: boolean;
}

export const ProductSearchForm: React.FC<ProductSearchFormProps> = ({ onSearch, loading }) => {
  const [query, setQuery] = useState('');
  const [merchantPreference, setMerchantPreference] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      setValidationError('Please enter a search query');
      return;
    }
    setValidationError(null);
    await onSearch(trimmed, merchantPreference.trim() || undefined);
  };

  return (
    <form
      onSubmit={handleSubmit}
      data-testid="product-search-form"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}
    >
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', minWidth: '240px' }}>
          <label
            htmlFor="product-search-input"
            style={{
              display: 'block',
              fontSize: '0.85rem',
              fontWeight: 600,
              color: 'var(--text-muted)',
              marginBottom: '0.4rem',
            }}
          >
            Product Query <span style={{ color: 'var(--accent-rose)' }}>*</span>
          </label>
          <input
            id="product-search-input"
            data-testid="product-search-input"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (validationError && e.target.value.trim()) {
                setValidationError(null);
              }
            }}
            placeholder="e.g. Ergonomic Office Chair, MacBook Pro M3, Cloud Compute Node..."
            disabled={loading}
            style={{
              width: '100%',
              padding: '0.75rem 1rem',
              background: 'rgba(255, 255, 255, 0.04)',
              border: validationError ? '1px solid var(--accent-rose)' : '1px solid var(--card-border)',
              borderRadius: '10px',
              color: 'var(--text-main)',
              fontSize: '0.95rem',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>

        <div style={{ flex: '0 1 200px', minWidth: '160px' }}>
          <label
            htmlFor="merchant-preference-input"
            style={{
              display: 'block',
              fontSize: '0.85rem',
              fontWeight: 600,
              color: 'var(--text-muted)',
              marginBottom: '0.4rem',
            }}
          >
            Merchant (Optional)
          </label>
          <input
            id="merchant-preference-input"
            data-testid="merchant-preference-input"
            type="text"
            value={merchantPreference}
            onChange={(e) => setMerchantPreference(e.target.value)}
            placeholder="e.g. Amazon, BestBuy..."
            disabled={loading}
            style={{
              width: '100%',
              padding: '0.75rem 1rem',
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid var(--card-border)',
              borderRadius: '10px',
              color: 'var(--text-main)',
              fontSize: '0.95rem',
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
        </div>

        <div style={{ alignSelf: 'flex-end' }}>
          <Button
            type="submit"
            variant="primary"
            loading={loading}
            testId="product-search-submit"
            style={{ minHeight: '44px', minWidth: '120px' }}
          >
            Search Catalog
          </Button>
        </div>
      </div>

      {validationError && (
        <div
          data-testid="search-validation-error"
          style={{ color: 'var(--accent-rose)', fontSize: '0.825rem', marginTop: '-0.25rem' }}
        >
          {validationError}
        </div>
      )}
    </form>
  );
};
