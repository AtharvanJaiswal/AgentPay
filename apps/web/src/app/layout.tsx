import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AgentPay — Verifiable Payment Authorization & Audit Platform for AI Agents',
  description:
    'AI proposes. Policy enforces. PayPal executes. The audit trail proves what happened. Engineering foundation phase with mock payment provider.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
