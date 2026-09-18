import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-mono text-xs tracking-[0.3em] text-accent">404</p>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted">It may not exist, or you may not have access to it.</p>
      <Link href="/" className="text-sm text-accent hover:underline">
        Go home
      </Link>
    </main>
  );
}
