import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'outline';
  loading?: boolean;
  testId?: string;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  loading = false,
  disabled,
  testId,
  style,
  ...props
}) => {
  const baseStyles: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    padding: '0.65rem 1.25rem',
    borderRadius: '10px',
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    opacity: disabled || loading ? 0.6 : 1,
    transition: 'all 0.2s ease',
    border: 'none',
    outline: 'none',
    ...style,
  };

  const variantStyles: Record<string, React.CSSProperties> = {
    primary: {
      background: 'linear-gradient(135deg, var(--accent-blue), #0051b3)',
      color: '#fff',
      boxShadow: '0 2px 10px rgba(0, 112, 243, 0.25)',
    },
    success: {
      background: 'linear-gradient(135deg, var(--accent-emerald), #059669)',
      color: '#fff',
      boxShadow: '0 2px 10px rgba(16, 185, 129, 0.25)',
    },
    danger: {
      background: 'linear-gradient(135deg, var(--accent-rose), #dc2626)',
      color: '#fff',
      boxShadow: '0 2px 10px rgba(244, 63, 94, 0.25)',
    },
    secondary: {
      background: 'rgba(255, 255, 255, 0.08)',
      color: 'var(--text-main)',
      border: '1px solid var(--card-border)',
    },
    outline: {
      background: 'transparent',
      color: 'var(--text-main)',
      border: '1px solid var(--card-border)',
    },
  };

  return (
    <button
      {...props}
      data-testid={testId}
      disabled={disabled || loading}
      aria-busy={loading}
      style={{ ...baseStyles, ...variantStyles[variant] }}
    >
      {loading && (
        <span
          style={{
            display: 'inline-block',
            width: '14px',
            height: '14px',
            border: '2px solid rgba(255,255,255,0.3)',
            borderTopColor: '#fff',
            borderRadius: '50%',
            animation: 'spin 0.6s linear infinite',
          }}
        />
      )}
      {children}
    </button>
  );
};
