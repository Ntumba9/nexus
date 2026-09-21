import { beforeEach, describe, expect, it, vi } from 'vitest';

const next = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));
vi.mock('next/navigation', () => ({ redirect: next.redirect }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'nexus_session' ? { value: 'tok' } : undefined),
  }),
}));

import { getMe, getOrganization } from './server-api';

const fetchMock = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('server-side API calls when the API is down', () => {
  it('sends the visitor to the offline page when the API cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(getMe()).rejects.toThrow('NEXT_REDIRECT:/offline');
    expect(next.redirect).toHaveBeenCalledWith('/offline');
  });

  it.each([502, 503, 504])(
    'treats a gateway answering %i as the API being down',
    async (status) => {
      fetchMock.mockResolvedValue(json(status));
      await expect(getOrganization('org-1')).rejects.toThrow('NEXT_REDIRECT:/offline');
    },
  );

  it('does not treat the API answering "not signed in" or "not found" as offline', async () => {
    fetchMock.mockResolvedValueOnce(json(401));
    expect(await getMe()).toBeNull();
    fetchMock.mockResolvedValueOnce(json(404));
    expect(await getOrganization('org-2')).toBeNull();
    expect(next.redirect).not.toHaveBeenCalled();
  });

  it("still fails loudly on the API's own errors, which are not an outage", async () => {
    fetchMock.mockResolvedValue(json(500));
    await expect(getOrganization('org-3')).rejects.toThrow('Unexpected API response (500)');
    expect(next.redirect).not.toHaveBeenCalled();
  });

  it('forwards only the session cookie', async () => {
    fetchMock.mockResolvedValue(json(200, { user: { id: 'u' }, memberships: [] }));
    await getMe();
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers).toEqual({ Cookie: 'nexus_session=tok' });
  });
});
