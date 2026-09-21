import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import './globals.css';

// A per-request CSP nonce needs the page to be rendered per request (see src/proxy.ts).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { default: 'NEXUS', template: '%s · NEXUS' },
  description: 'Developer operations and incident intelligence platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
