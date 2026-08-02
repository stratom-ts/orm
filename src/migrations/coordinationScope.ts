import { SchemaError } from '@/utils/error'

/** Existing database-wide lock identity. Its values must remain stable. */
export const MIGRATE_ADVISORY_LOCK_CLASS = 0x7363_686d // 'schm'
export const MIGRATE_ADVISORY_LOCK_ID = 0x6f72_6d00 // 'orm\0'

export type MigrationCoordinationScope = Readonly<{
  database: Readonly<{
    dialect: 'postgresql'
    name: string
    canonicalIdentity: string
  }>
  applicationId?: string
}>

export type MigrationCoordinationLockIdentity =
  | Readonly<{
      kind: 'legacy'
      classId: number
      lockId: number
    }>
  | Readonly<{
      kind: 'scoped'
      canonicalIdentity: string
    }>

/**
 * Asserts that a value is stable enough for canonical lock identity encoding.
 *
 * @param value - Value to validate.
 * @param label - Identifier label used in validation errors.
 */
function assertStableIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new SchemaError({
      message: `${label} must be a non-empty string containing no NUL`,
    })
  }
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index)
    if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdfff &&
      !(
        codeUnit <= 0xdbff &&
        index + 1 < value.length &&
        value.charCodeAt(index + 1) >= 0xdc00 &&
        value.charCodeAt(index + 1) <= 0xdfff
      )
    ) {
      throw new SchemaError({
        message: `${label} must not contain unpaired Unicode surrogates`,
      })
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) index++
  }
}

/**
 * Validates an application identifier used for migration coordination.
 *
 * @example
 *   validateApplicationId('billing-service')
 *
 * @param applicationId - Stable application identifier.
 */
export function validateApplicationId(applicationId: string): void {
  assertStableIdentifier(applicationId, 'applicationId')
}

/**
 * Creates a canonical PostgreSQL migration coordination scope.
 *
 * @example
 *   const scope = createMigrationCoordinationScope('app', 'billing-service')
 *
 * @param databaseName - PostgreSQL database name.
 * @param applicationId - Optional stable application identifier.
 */
export function createMigrationCoordinationScope(
  databaseName: string,
  applicationId?: string,
): MigrationCoordinationScope {
  assertStableIdentifier(databaseName, 'database identity')
  if (applicationId !== undefined) validateApplicationId(applicationId)

  return Object.freeze({
    database: Object.freeze({
      dialect: 'postgresql' as const,
      name: databaseName,
      canonicalIdentity: JSON.stringify(['postgresql', 'database', databaseName]),
    }),
    ...(applicationId === undefined ? {} : { applicationId }),
  })
}

/**
 * Returns legacy-first lock acquisition order for mixed-version deployment.
 *
 * @example
 *   const locks = migrationLockAcquisitionOrder(scope)
 *
 * @param scope - Migration coordination scope.
 */
export function migrationLockAcquisitionOrder(
  scope: MigrationCoordinationScope,
): readonly MigrationCoordinationLockIdentity[] {
  const legacy: MigrationCoordinationLockIdentity = Object.freeze({
    kind: 'legacy',
    classId: MIGRATE_ADVISORY_LOCK_CLASS,
    lockId: MIGRATE_ADVISORY_LOCK_ID,
  })
  if (scope.applicationId === undefined) return Object.freeze([legacy])

  return Object.freeze([
    legacy,
    Object.freeze({
      kind: 'scoped' as const,
      canonicalIdentity: JSON.stringify([
        'stratom',
        'migration',
        scope.database.canonicalIdentity,
        scope.applicationId,
      ]),
    }),
  ])
}

/**
 * Returns the reverse lock release order for a coordination scope.
 *
 * @example
 *   const locks = migrationLockReleaseOrder(scope)
 *
 * @param scope - Migration coordination scope.
 */
export function migrationLockReleaseOrder(
  scope: MigrationCoordinationScope,
): readonly MigrationCoordinationLockIdentity[] {
  return Object.freeze([...migrationLockAcquisitionOrder(scope)].reverse())
}
