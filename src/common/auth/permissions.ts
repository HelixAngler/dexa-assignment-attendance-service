/**
 * Canonical role -> permission-code map.
 *
 * There are exactly two roles in the system:
 *
 * - `employee` — self-service only: read/update own profile, change own
 *   password, punch attendance and read own summary.
 * - `hrd` — the administrative superset. Its permission list is the five
 *   `employee` permissions UNION the five admin permissions
 *   (`employee:read`, `employee:create`, `employee:update`,
 *   `attendance:read_all`, `hrd:receive_popups`). HRD therefore never loses
 *   the self-service abilities an ordinary employee has: hrd = employee ∪ admin.
 *
 * Authorization is default-deny: a caller only ever holds the codes listed
 * for its role here, and a role missing from the table gets an empty list.
 */

export type Role = 'employee' | 'hrd';

export const EMPLOYEE_PERMISSIONS = [
  'profile:read_own',
  'profile:update_own',
  'password:change_own',
  'attendance:punch',
  'summary:read_own',
] as const;

export const HRD_PERMISSIONS = [
  ...EMPLOYEE_PERMISSIONS,
  'employee:read',
  'employee:create',
  'employee:update',
  'attendance:read_all',
  'hrd:receive_popups',
] as const;

export type PermissionCode = (typeof HRD_PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly PermissionCode[]> = {
  employee: EMPLOYEE_PERMISSIONS,
  hrd: HRD_PERMISSIONS,
};

export const permissionsFor = (role: Role): readonly PermissionCode[] =>
  ROLE_PERMISSIONS[role] ?? [];

export const hasPermission = (role: Role, code: PermissionCode): boolean =>
  permissionsFor(role).includes(code);
