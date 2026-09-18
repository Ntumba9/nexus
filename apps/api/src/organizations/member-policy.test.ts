import { describe, expect, it } from 'vitest';
import { assertKeepsAnOwner, assertMayAssignRole, assertMayModifyMember } from './member-policy';

describe('member policy', () => {
  it('only an OWNER may grant the OWNER role', () => {
    expect(() => assertMayAssignRole('OWNER', 'OWNER')).not.toThrow();
    expect(() => assertMayAssignRole('ADMIN', 'OWNER')).toThrow(/owner/i);
    expect(() => assertMayAssignRole('ADMIN', 'ADMIN')).not.toThrow();
    expect(() => assertMayAssignRole('ADMIN', 'VIEWER')).not.toThrow();
  });

  it('only an OWNER may modify or remove an OWNER', () => {
    expect(() => assertMayModifyMember('OWNER', 'OWNER')).not.toThrow();
    expect(() => assertMayModifyMember('ADMIN', 'OWNER')).toThrow();
    expect(() => assertMayModifyMember('ADMIN', 'DEVELOPER')).not.toThrow();
  });

  it('never allows the last owner to be demoted or removed', () => {
    expect(() => assertKeepsAnOwner(1, 'OWNER', false)).toThrow(/at least one owner/);
    expect(() => assertKeepsAnOwner(2, 'OWNER', false)).not.toThrow();
    expect(() => assertKeepsAnOwner(1, 'OWNER', true)).not.toThrow();
    expect(() => assertKeepsAnOwner(1, 'ADMIN', false)).not.toThrow();
  });
});
