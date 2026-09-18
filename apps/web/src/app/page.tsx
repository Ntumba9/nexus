import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LAST_ORG_COOKIE, getMe } from '@/lib/server-api';

/** Entry point: send visitors wherever they belong. Never renders anything itself. */
export default async function RootPage() {
  const me = await getMe();
  if (!me) redirect('/login');

  const lastOrg = (await cookies()).get(LAST_ORG_COOKIE)?.value;
  const target = me.memberships.find((m) => m.organizationId === lastOrg) ?? me.memberships[0];
  redirect(target ? `/orgs/${target.organizationId}` : '/onboarding');
}
