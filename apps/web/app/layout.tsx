import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import './globals.css';

/**
 * `template` gives every route its own tab title, so tabs of different
 * databases can be told apart. Pages set the specific half.
 */
export const metadata: Metadata = {
  title: { default: 'pgops', template: '%s · pgops' },
  description: 'On-call console for Postgres — lock chains, slow queries and replication, live.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
