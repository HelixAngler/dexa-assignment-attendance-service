import {
  EMPLOYEE_PERMISSIONS,
  HRD_PERMISSIONS,
  ROLE_PERMISSIONS,
  Role,
  hasPermission,
  permissionsFor,
} from '../src/common/auth/permissions';

describe('permissions', () => {
  it('lists exactly the five self-service codes for employees', () => {
    expect(EMPLOYEE_PERMISSIONS).toEqual([
      'profile:read_own',
      'profile:update_own',
      'password:change_own',
      'attendance:punch',
      'summary:read_own',
    ]);
  });

  it('extends hrd with the five admin codes on top of the employee set', () => {
    expect(HRD_PERMISSIONS).toEqual([
      'profile:read_own',
      'profile:update_own',
      'password:change_own',
      'attendance:punch',
      'summary:read_own',
      'employee:read',
      'employee:create',
      'employee:update',
      'attendance:read_all',
      'hrd:receive_popups',
    ]);
  });

  it('gives hrd every employee permission (hrd = employee union admin)', () => {
    for (const code of EMPLOYEE_PERMISSIONS) {
      expect(HRD_PERMISSIONS).toContain(code);
    }
    expect(HRD_PERMISSIONS.length).toBe(EMPLOYEE_PERMISSIONS.length + 5);
  });

  it('covers both roles in the role table', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(['employee', 'hrd']);
  });

  it('resolves the codes per role', () => {
    expect(permissionsFor('employee')).toEqual([...EMPLOYEE_PERMISSIONS]);
    expect(permissionsFor('hrd')).toEqual([...HRD_PERMISSIONS]);
  });

  it('grants and denies codes by role', () => {
    expect(hasPermission('employee', 'attendance:punch')).toBe(true);
    expect(hasPermission('employee', 'employee:read')).toBe(false);
    expect(hasPermission('hrd', 'employee:read')).toBe(true);
    expect(hasPermission('hrd', 'attendance:punch')).toBe(true);
  });

  it('fails closed for an unrecognized role', () => {
    expect(permissionsFor('root' as Role)).toEqual([]);
    expect(hasPermission('root' as Role, 'attendance:punch')).toBe(false);
  });
});
