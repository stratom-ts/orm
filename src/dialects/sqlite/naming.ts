import {
  createPhysicalNameRegistry,
  generatePhysicalName,
  validatePhysicalName,
} from '@/migrations/physicalNaming'
import type { PhysicalNamingProfile } from '@/migrations/physicalNaming'

import { asciiFoldSqliteIdentifier } from './identity'

/** SQLite identifier comparison and uniqueness scope. */
export const SQLITE_PHYSICAL_NAMING: PhysicalNamingProfile = {
  id: 'sqlite',
  maximumLength: Number.POSITIVE_INFINITY,
  lengthUnit: 'unicodeScalars',
  comparisonKey: asciiFoldSqliteIdentifier,
  scope: (kind) =>
    kind === 'foreignKey' || kind === 'check'
      ? 'relationConstraints'
      : 'namespaceRelations',
}

/** SQLite physical naming semantics. */
export const sqliteNaming = {
  generate: (seed: Parameters<typeof generatePhysicalName>[0]) =>
    generatePhysicalName(seed, SQLITE_PHYSICAL_NAMING),
  validate: (name: string, description: string) =>
    validatePhysicalName(name, description, SQLITE_PHYSICAL_NAMING),
  createRegistry: () => createPhysicalNameRegistry(SQLITE_PHYSICAL_NAMING),
}
