import {
  createPhysicalNameRegistry,
  generatePhysicalName,
  validatePhysicalName,
} from '@/migrations/physicalNaming'
import type {
  PhysicalNameRegistry,
  PhysicalNamingProfile,
} from '@/migrations/physicalNaming'
import { TaggedError } from '@/utils/error'

import { asciiFoldSqliteIdentifier } from './identity'

/** Expected rejection for SQLite's reserved object-name prefix. */
export class SqliteReservedObjectNameError extends TaggedError(
  'SqliteReservedObjectNameError',
)<{ message: string }> {}

/** SQLite identifier comparison and uniqueness scope. */
export const SQLITE_PHYSICAL_NAMING: PhysicalNamingProfile = {
  id: 'sqlite',
  maximumLength: Number.POSITIVE_INFINITY,
  lengthUnit: 'unicodeScalars',
  comparisonKey: asciiFoldSqliteIdentifier,
  /** Selects the uniqueness scope used to reserve one kind of physical name. */
  scope: (kind) =>
    kind === 'foreignKey' || kind === 'check'
      ? 'relationConstraints'
      : 'namespaceRelations',
}

/** SQLite physical naming semantics. */
export const sqliteNaming = {
  /** Generates a deterministic physical name under the selected dialect's limits. */
  generate: (seed: Parameters<typeof generatePhysicalName>[0]): string =>
    generatePhysicalName(seed, SQLITE_PHYSICAL_NAMING),
  /** Rejects physical identifiers that violate the selected dialect's naming rules. */
  validate: (name: string, description: string): void =>
    validatePhysicalName(name, description, SQLITE_PHYSICAL_NAMING),
  /**
   * Creates a registry that detects physical-name collisions in the selected uniqueness
   * scopes.
   */
  createRegistry: (): PhysicalNameRegistry =>
    createPhysicalNameRegistry(SQLITE_PHYSICAL_NAMING),
}

/** Rejects SQLite's reserved object prefix for authored table and index names. */
export function validateSqliteObjectName(name: string, role: 'table' | 'index'): void {
  sqliteNaming.validate(name, `SQLite ${role} name`)

  if (asciiFoldSqliteIdentifier(name).startsWith('sqlite_'))
    throw new SqliteReservedObjectNameError({
      message: `SQLite ${role} name ${JSON.stringify(name)} uses reserved prefix "sqlite_"`,
    })
}
