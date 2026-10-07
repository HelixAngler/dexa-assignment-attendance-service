import { PrismaEmployeeStatusReader } from '../src/common/auth/prisma-employee-status.reader';
import type { PrismaClient } from '../src/generated/prisma';

type FindUniqueArgs = {
  where: { id: string };
  select: { status: true; role: true };
};

const makeReader = () => {
  const prisma = {
    employee: {
      findUnique: jest.fn<
        Promise<{ status: string; role: string } | null>,
        [FindUniqueArgs]
      >(),
    },
  };
  const reader = new PrismaEmployeeStatusReader(
    prisma as unknown as PrismaClient
  );
  return { prisma, reader };
};

describe('PrismaEmployeeStatusReader', () => {
  it('queries only status and role for the given employee', async () => {
    const { prisma, reader } = makeReader();
    prisma.employee.findUnique.mockResolvedValue({
      status: 'active',
      role: 'employee',
    });

    await reader.getCurrent('emp-9');

    expect(prisma.employee.findUnique).toHaveBeenCalledWith({
      where: { id: 'emp-9' },
      select: { status: true, role: true },
    });
  });

  it('returns the live snapshot', async () => {
    const { prisma, reader } = makeReader();
    prisma.employee.findUnique.mockResolvedValue({
      status: 'deactivated',
      role: 'hrd',
    });

    await expect(reader.getCurrent('emp-9')).resolves.toEqual({
      status: 'deactivated',
      role: 'hrd',
    });
  });

  it('returns null when the employee row does not exist', async () => {
    const { prisma, reader } = makeReader();
    prisma.employee.findUnique.mockResolvedValue(null);

    await expect(reader.getCurrent('emp-404')).resolves.toBeNull();
  });
});
