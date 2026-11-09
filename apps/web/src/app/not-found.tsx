import Link from 'next/link';

export default function NotFound() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
        textAlign: 'center',
        color: '#fff',
        padding: '2rem',
      }}
    >
      <h1 style={{ fontSize: '3rem', fontWeight: 700, marginBottom: '1rem' }}>404</h1>
      <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem', color: 'var(--text-muted, #94a3b8)' }}>
        Page Not Found
      </h2>
      <p style={{ marginBottom: '2rem', maxWidth: '400px', color: 'var(--text-muted, #94a3b8)' }}>
        The requested page could not be located on the AgentPay platform.
      </p>
      <Link
        href="/"
        style={{
          padding: '0.75rem 1.5rem',
          borderRadius: '8px',
          backgroundColor: '#3b82f6',
          color: '#ffffff',
          textDecoration: 'none',
          fontWeight: 600,
        }}
      >
        ← Return to Dashboard
      </Link>
    </div>
  );
}
