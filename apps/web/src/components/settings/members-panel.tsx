'use client';

import { ROLES, type MemberDto, type Role } from '@nexus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Input, Select } from '@/components/ui/field';
import { apiFetch, describeError } from '@/lib/api-client';

/**
 * Member list and management. Roles a viewer may assign are limited in the UI to mirror the API's
 * rules (only owners grant the owner role), but the API is what actually enforces them.
 */
export function MembersPanel({
  orgId,
  myRole,
  myUserId,
  canManage,
}: {
  orgId: string;
  myRole: Role;
  myUserId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['members', orgId];
  const assignable = ROLES.filter((role) => role !== 'OWNER' || myRole === 'OWNER');

  const members = useQuery({
    queryKey,
    queryFn: () => apiFetch<{ data: MemberDto[] }>(`/orgs/${orgId}/members`).then((r) => r.data),
  });

  const changeRole = useMutation({
    mutationFn: (input: { memberId: string; role: Role }) =>
      apiFetch(`/orgs/${orgId}/members/${input.memberId}`, {
        method: 'PATCH',
        body: { role: input.role },
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const remove = useMutation({
    mutationFn: (memberId: string) =>
      apiFetch(`/orgs/${orgId}/members/${memberId}`, { method: 'DELETE' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const add = useMutation({
    mutationFn: (input: { email: string; role: Role }) =>
      apiFetch(`/orgs/${orgId}/members`, { method: 'POST', body: input }),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<Role>('VIEWER');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  function onAdd(event: FormEvent) {
    event.preventDefault();
    add.mutate({ email, role: newRole }, { onSuccess: () => setEmail('') });
  }

  const mutationError = changeRole.error ?? remove.error;

  return (
    <div className="space-y-6">
      {mutationError && <Alert>{describeError(mutationError)}</Alert>}

      {members.isPending && (
        <div aria-busy="true" aria-label="Loading members" className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      )}

      {members.isError && (
        <div className="space-y-3">
          <Alert>{describeError(members.error)}</Alert>
          <Button variant="secondary" size="sm" onClick={() => members.refetch()}>
            Retry
          </Button>
        </div>
      )}

      {members.data && members.data.length === 0 && (
        <EmptyState title="No members" description="Add someone to get started." />
      )}

      {members.data && members.data.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Organization members</caption>
            <thead className="text-xs uppercase tracking-wider text-muted">
              <tr>
                <th scope="col" className="pb-2 pr-4 font-medium">
                  Member
                </th>
                <th scope="col" className="pb-2 pr-4 font-medium">
                  Role
                </th>
                {canManage && (
                  <th scope="col" className="pb-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {members.data.map((member) => {
                const locked = member.role === 'OWNER' && myRole !== 'OWNER';
                return (
                  <tr key={member.id}>
                    <td className="py-3 pr-4">
                      <p className="font-medium">
                        {member.name}
                        {member.userId === myUserId && (
                          <span className="ml-2 text-xs text-muted">(you)</span>
                        )}
                      </p>
                      <p className="text-xs text-muted">{member.email}</p>
                    </td>
                    <td className="py-3 pr-4">
                      {canManage && !locked ? (
                        <Select
                          aria-label={`Role for ${member.name}`}
                          value={member.role}
                          disabled={changeRole.isPending}
                          onChange={(e) =>
                            changeRole.mutate({ memberId: member.id, role: e.target.value as Role })
                          }
                          className="h-8 w-36 text-xs"
                        >
                          {assignable.map((role) => (
                            <option key={role} value={role}>
                              {role}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="font-mono text-xs">{member.role}</span>
                      )}
                    </td>
                    {canManage && (
                      <td className="py-3 text-right">
                        {locked ? null : confirmRemove === member.id ? (
                          <span className="inline-flex gap-2">
                            <Button
                              variant="danger"
                              size="sm"
                              loading={remove.isPending}
                              onClick={() =>
                                remove.mutate(member.id, {
                                  onSettled: () => setConfirmRemove(null),
                                })
                              }
                            >
                              Confirm
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmRemove(null)}
                            >
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Remove ${member.name}`}
                            onClick={() => setConfirmRemove(member.id)}
                          >
                            Remove
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canManage ? (
        <form onSubmit={onAdd} className="space-y-3 border-t border-border pt-5">
          <h3 className="text-sm font-medium">Add a member</h3>
          <p className="text-xs text-muted">The person must already have a NEXUS account.</p>
          {add.isError && <Alert>{describeError(add.error)}</Alert>}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
              aria-label="Email address"
              className="sm:flex-1"
            />
            <Select
              aria-label="Role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as Role)}
              className="sm:w-40"
            >
              {assignable.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </Select>
            <Button type="submit" loading={add.isPending}>
              Add
            </Button>
          </div>
        </form>
      ) : (
        <p className="border-t border-border pt-4 text-sm text-muted">
          Only owners and admins can manage members.
        </p>
      )}
    </div>
  );
}
