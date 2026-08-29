import {
  createPhysicalNameRegistry,
  generatePhysicalName,
  validatePhysicalName,
} from '@/migrations/physicalNaming'
import type { PhysicalNamingProfile } from '@/migrations/physicalNaming'

/** PostgreSQL identifier length, comparison, and uniqueness scope. */
export const POSTGRES_PHYSICAL_NAMING: PhysicalNamingProfile = {
  id: 'postgresql',
  maximumLength: 63,
  lengthUnit: 'utf8Bytes',
  comparisonKey: (name) => name,
  scope: (kind) =>
    kind === 'foreignKey' || kind === 'check'
      ? 'relationConstraints'
      : 'namespaceRelations',
}

/** PostgreSQL physical naming semantics, bound to the selected dialect member. */
export const postgresNaming = {
  generate: (seed: Parameters<typeof generatePhysicalName>[0]) =>
    generatePhysicalName(seed, POSTGRES_PHYSICAL_NAMING),
  validate: (name: string, description: string) =>
    validatePhysicalName(name, description, POSTGRES_PHYSICAL_NAMING),
  createRegistry: () => createPhysicalNameRegistry(POSTGRES_PHYSICAL_NAMING),
}
