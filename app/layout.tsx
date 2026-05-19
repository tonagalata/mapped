import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BCBA & Client Map',
  description: 'HIPAA-safe roster viewer with drive-time radius filtering. Session-only.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
