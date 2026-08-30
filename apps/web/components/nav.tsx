import Link from 'next/link';

const TABS = [
  { href: '', label: 'Triage' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/locks', label: 'Locks' },
  { href: '/queries', label: 'Queries' },
] as const;

export function Nav({ name }: { name: string }) {
  return (
    <nav className="mb-4 flex gap-4 border-b pb-2 text-sm">
      {TABS.map((t) => (
        <Link key={t.label} href={`/db/${name}${t.href}`} className="underline-offset-4 hover:underline">
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
