/**
 * Remember the last organisation the user opened, so "/" can return them there.
 * A convenience only: it is not trusted for anything (the API verifies membership on every request).
 */
export function rememberOrganization(organizationId: string): void {
  document.cookie = `nexus_last_org=${encodeURIComponent(organizationId)}; path=/; max-age=31536000; SameSite=Lax`;
}
