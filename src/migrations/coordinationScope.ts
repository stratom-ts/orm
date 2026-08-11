import { SchemaError } from '@/utils/error'

export type MigrationCoordinationScopeInput = Readonly<{
  /** Stable dialect identity supplied by the owning runtime. */
  dialect: string
  /** Stable database identity supplied by the owning runtime. */
  database: string
  /** Optional stable application identity for scoped coordination. */
  applicationId?: string
}>

export type MigrationCoordinationScope = Readonly<{
  database: Readonly<{
    dialect: string
    name: string
    canonicalIdentity: string
  }>
  applicationId?: string
}>

/** Portable coordination identities; physical lock fields belong to a dialect. */
export type MigrationCoordinationLockIdentity =
  | Readonly<{ kind: 'legacy'; canonicalIdentity: string }>
  | Readonly<{ kind: 'scoped'; canonicalIdentity: string }>

/**
 * Asserts that an identity component has a stable canonical encoding.
 *
 * @param value - Identity component to validate.
 * @param label - Human-readable field name used in validation errors.
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
 * Validates an application-level migration coordination identity when configured.
 *
 * @example
 *   validateApplicationId('billing-service')
 *
 * @param applicationId - Stable application identity to validate.
 */
export function validateApplicationId(applicationId: string): void {
  assertStableIdentifier(applicationId, 'applicationId')
}

/**
 * Creates one stable, dialect-neutral migration coordination scope.
 *
 * @example
 *   const scope = createMigrationCoordinationScope({
 *     dialect: 'postgresql',
 *     database: 'application',
 *     applicationId: 'billing-service',
 *   })
 *
 * @param input - Stable dialect, database, and optional application identities.
 */
export function createMigrationCoordinationScope(
  input: MigrationCoordinationScopeInput,
): MigrationCoordinationScope {
  assertStableIdentifier(input.dialect, 'dialect identity')
  assertStableIdentifier(input.database, 'database identity')
  if (input.applicationId !== undefined) validateApplicationId(input.applicationId)

  return Object.freeze({
    database: Object.freeze({
      dialect: input.dialect,
      name: input.database,
      canonicalIdentity: JSON.stringify([input.dialect, 'database', input.database]),
    }),
    ...(input.applicationId === undefined ? {} : { applicationId: input.applicationId }),
  })
}

/**
 * Returns the canonical legacy-first acquisition order for a coordination scope.
 *
 * @example
 *   const identities = migrationLockAcquisitionOrder(scope)
 *
 * @param scope - Canonical migration coordination scope.
 */
export function migrationLockAcquisitionOrder(
  scope: MigrationCoordinationScope,
): readonly MigrationCoordinationLockIdentity[] {
  const legacy: MigrationCoordinationLockIdentity = Object.freeze({
    kind: 'legacy',
    canonicalIdentity: JSON.stringify([
      'stratom',
      'migration',
      'legacy',
      scope.database.canonicalIdentity,
    ]),
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
 * Returns the canonical release order, reversing every required acquisition.
 *
 * @example
 *   const identities = migrationLockReleaseOrder(scope)
 *
 * @param scope - Canonical migration coordination scope.
 */
export function migrationLockReleaseOrder(
  scope: MigrationCoordinationScope,
): readonly MigrationCoordinationLockIdentity[] {
  return Object.freeze([...migrationLockAcquisitionOrder(scope)].reverse())
}
