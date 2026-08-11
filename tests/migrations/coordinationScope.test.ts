import { describe, expect, it } from 'vitest'

import {
  createMigrationCoordinationScope,
  migrationLockAcquisitionOrder,
  migrationLockReleaseOrder,
} from '@/migrations/coordinationScope'

describe('portable migration coordination scope', () => {
  it('requires explicit dialect and database identities', () => {
    const scope = createMigrationCoordinationScope({
      dialect: 'postgresql',
      database: 'app_db',
    })
    expect(scope).toEqual({
      database: {
        dialect: 'postgresql',
        name: 'app_db',
        canonicalIdentity: JSON.stringify(['postgresql', 'database', 'app_db']),
      },
    })
    expect(migrationLockAcquisitionOrder(scope)).toHaveLength(1)
    expect(migrationLockReleaseOrder(scope)).toEqual(migrationLockAcquisitionOrder(scope))
  })

  it('uses only the application-scoped identity when configured', () => {
    const scope = createMigrationCoordinationScope({
      dialect: 'postgresql',
      database: 'app.db',
      applicationId: 'billing.v2',
    })
    const acquire = migrationLockAcquisitionOrder(scope)
    expect(acquire.map((identity) => identity.kind)).toEqual(['scoped'])
    expect(migrationLockReleaseOrder(scope)).toEqual([...acquire].reverse())
  })

  it('separates dialect, database, and application tuples', () => {
    const left = migrationLockAcquisitionOrder(
      createMigrationCoordinationScope({
        dialect: 'postgresql',
        database: 'a.b',
        applicationId: 'c',
      }),
    )[0]
    const right = migrationLockAcquisitionOrder(
      createMigrationCoordinationScope({
        dialect: 'postgresql',
        database: 'a',
        applicationId: 'b.c',
      }),
    )[0]
    const otherDialect = migrationLockAcquisitionOrder(
      createMigrationCoordinationScope({
        dialect: 'sqlite',
        database: 'a.b',
        applicationId: 'c',
      }),
    )[0]
    expect(left).not.toEqual(right)
    expect(left).not.toEqual(otherDialect)
  })

  it('validates each stable identity', () => {
    expect(() =>
      createMigrationCoordinationScope({ dialect: '', database: 'db' }),
    ).toThrow(/dialect identity/i)
    expect(() =>
      createMigrationCoordinationScope({ dialect: 'postgresql', database: '' }),
    ).toThrow(/database identity/i)
    expect(() =>
      createMigrationCoordinationScope({
        dialect: 'postgresql',
        database: 'db',
        applicationId: 'bad\0id',
      }),
    ).toThrow(/NUL/i)
    expect(() =>
      createMigrationCoordinationScope({
        dialect: 'postgresql',
        database: '\ud800',
      }),
    ).toThrow(/surrogate/i)
  })
})
