import { Provider } from '@nestjs/common';

import type { PrismaClient } from '../../generated/prisma';
import { PRISMA_CLIENT, ManagedPrismaClient } from '../prisma.client';
import {
  EMPLOYEE_STATUS_READER,
  EmployeeStatusReader,
  EmployeeStatusSnapshot,
} from './employee-status.reader';

/**
 * Reads an employee's status/role straight from the employees table through
 * the generated Prisma client, so every request sees the values that are true
 * at this moment (fresh role, fresh lifecycle status).
 */
export class PrismaEmployeeStatusReader implements EmployeeStatusReader {
  constructor(private readonly prisma: PrismaClient) {}

  async getCurrent(employeeId: string): Promise<EmployeeStatusSnapshot | null> {
    const row = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { status: true, role: true },
    });
    if (row === null) {
      return null;
    }
    return { status: row.status, role: row.role };
  }
}

/**
 * Provider for the `EMPLOYEE_STATUS_READER` token. It reuses the shared
 * database client, so every module that serves guarded routes resolves status
 * and role through the same connection pool instead of opening a second one.
 */
export const employeeStatusReaderProvider: Provider = {
  provide: EMPLOYEE_STATUS_READER,
  useFactory: (managed: ManagedPrismaClient): EmployeeStatusReader =>
    new PrismaEmployeeStatusReader(managed.client),
  inject: [PRISMA_CLIENT],
};
