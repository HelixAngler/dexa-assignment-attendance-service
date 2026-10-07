import type { Role } from './permissions';

/** Lifecycle states of an employee row. Only `active` employees may act. */
export type EmployeeStatusValue = 'active' | 'deactivated';

/**
 * The two fields a request needs from the employees table: whether the person
 * is still active, and which role applies right now.
 */
export type EmployeeStatusSnapshot = {
  status: EmployeeStatusValue;
  role: Role;
};

/**
 * Port for resolving an employee's CURRENT status and role.
 *
 * Guards call this on every authenticated request so that a role change or a
 * deactivation takes effect on the very next request instead of waiting for
 * the session itself to expire. Implementations must read live data (the
 * employees table), never a cache that outlives a deactivation.
 */
export interface EmployeeStatusReader {
  getCurrent(employeeId: string): Promise<EmployeeStatusSnapshot | null>;
}

export const EMPLOYEE_STATUS_READER = 'EMPLOYEE_STATUS_READER';
