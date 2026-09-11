import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import './globals.css';

/**
 * `template` is what gives every route its own tab identity. It was a bare
 * `'pgops'`, so three tabs of prod, staging and a replica were three
 * identical labels — during the incident that is exactly when several are
 * open at once, and the tab strip is the only thing distinguishing them.
 * Pages set the specific half; this appends the constant one.
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
