import React from 'react';

export interface AlertProps {
  type?: 'error' | 'warning' | 'info' | 'success';
  title?: string;
  children: React.ReactNode;
  testId?: string;
  onRetry?: () => void;
}

export const Alert: React.FC<AlertProps> = ({
  type = 'info',
  title,
  children,
  testId,
  onRetry,
}) => {
  const borderColors = {
    error: 'rgba(244, 63, 94, 0.4)',
    warning: 'rgba(245, 166, 35, 0.4)',
    info: 'rgba(0, 229, 255, 0.4)',
    success: 'rgba(16, 185, 129, 0.4)',
  };

  const bgColors = {
    error: 'rgba(244, 63, 94, 0.08)',
    warning: 'rgba(245, 166, 35, 0.08)',
    info: 'rgba(0, 229, 255, 0.08)',
    success: 'rgba(16, 185, 129, 0.08)',
  };

  const textColors = {
    error: '#fb7185',
    warning: '#fbbf24',
    info: 'var(--accent-cyan)',
    success: '#34d399',
  };

  return (
    <div
      role="alert"
      data-testid={testId}
      style={{
        border: `1px solid ${borderColors[type]}`,
        background: bgColors[type],
        borderRadius: '12px',
        padding: '1rem 1.25rem',
        margin: '1rem 0',
        color: 'var(--text-main)',
      }}
    >
      {title && (
        <div
          style={{
            fontWeight: 700,
            fontSize: '0.95rem',
            color: textColors[type],
            marginBottom: '0.35rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>{title}</span>
          {onRetry && (
            <button
              onClick={onRetry}
              style={{
                background: 'transparent',
                border: `1px solid ${borderColors[type]}`,
                color: textColors[type],
                borderRadius: '6px',
                padding: '0.2rem 0.6rem',
                fontSize: '0.75rem',
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
          )}
        </div>
      )}
      <div style={{ fontSize: '0.875rem', lineHeight: 1.5, color: 'var(--text-muted)' }}>
        {children}
      </div>
    </div>
  );
};
