import Link from 'next/link';

export default function OrgNotFound() {
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">Organization not found</h1>
      <p className="text-sm text-muted">It may not exist, or you may not be a member.</p>
      <Link href="/" className="text-sm text-accent hover:underline">
        Go to your organizations
      </Link>
    </div>
  );
}
