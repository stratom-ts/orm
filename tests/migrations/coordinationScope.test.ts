import { describe, expect, it } from 'vitest'

import {
  MIGRATE_ADVISORY_LOCK_CLASS,
  MIGRATE_ADVISORY_LOCK_ID,
  createMigrationCoordinationScope,
  migrationLockAcquisitionOrder,
  migrationLockReleaseOrder,
} from '@/migrations/coordinationScope'

describe('migration coordination scope', () => {
  it('remains legacy database-wide without an application ID', () => {
    const scope = createMigrationCoordinationScope('app_db')
    expect(migrationLockAcquisitionOrder(scope)).toEqual([
      {
        kind: 'legacy',
        classId: MIGRATE_ADVISORY_LOCK_CLASS,
        lockId: MIGRATE_ADVISORY_LOCK_ID,
      },
    ])
    expect(migrationLockReleaseOrder(scope)).toEqual(migrationLockAcquisitionOrder(scope))
  })

  it('orders legacy before canonical database/application scope and releases in reverse', () => {
    const scope = createMigrationCoordinationScope('app.db', 'billing.v2')
    const acquire = migrationLockAcquisitionOrder(scope)
    expect(acquire.map((identity) => identity.kind)).toEqual(['legacy', 'scoped'])
    expect(acquire[1]).toEqual({
      kind: 'scoped',
      canonicalIdentity: JSON.stringify([
        'stratom',
        'migration',
        JSON.stringify(['postgresql', 'database', 'app.db']),
        'billing.v2',
      ]),
    })
    expect(migrationLockReleaseOrder(scope)).toEqual([...acquire].reverse())
  })

  it('separates database and application tuples without dotted-string collisions', () => {
    const left = migrationLockAcquisitionOrder(
      createMigrationCoordinationScope('a.b', 'c'),
    )[1]
    const right = migrationLockAcquisitionOrder(
      createMigrationCoordinationScope('a', 'b.c'),
    )[1]
    expect(left).not.toEqual(right)
  })

  it('validates explicit stable application IDs', () => {
    expect(() => createMigrationCoordinationScope('db', '')).toThrow(/applicationId/i)
    expect(() => createMigrationCoordinationScope('db', 'bad\0id')).toThrow(/NUL/i)
    expect(() => createMigrationCoordinationScope('db', '\ud800')).toThrow(/surrogate/i)
    expect(() => createMigrationCoordinationScope('db', 'tenant-😀')).not.toThrow()
  })

  it('validates canonical database identities', () => {
    expect(() => createMigrationCoordinationScope('')).toThrow(/database identity/i)
    expect(() => createMigrationCoordinationScope('bad\0db')).toThrow(
      /database identity/i,
    )
    expect(() => createMigrationCoordinationScope('\ud800')).toThrow(
      /database identity.*surrogate/i,
    )
    expect(() => createMigrationCoordinationScope('tenant-😀')).not.toThrow()
  })
})
