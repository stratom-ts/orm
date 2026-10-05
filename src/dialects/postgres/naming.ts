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
  /** Converts an identifier spelling into the selected policy's comparison key. */
  comparisonKey: (name) => name,
  /** Selects the uniqueness scope used to reserve one kind of physical name. */
  scope: (kind) =>
    kind === 'foreignKey' || kind === 'check'
      ? 'relationConstraints'
      : 'namespaceRelations',
}

/** PostgreSQL physical naming semantics, bound to the selected dialect member. */
export const postgresNaming = {
  /** Generates a deterministic physical name under the selected dialect's limits. */
  generate: (seed: Parameters<typeof generatePhysicalName>[0]) =>
    generatePhysicalName(seed, POSTGRES_PHYSICAL_NAMING),
  /** Rejects physical identifiers that violate the selected dialect's naming rules. */
  validate: (name: string, description: string) =>
    validatePhysicalName(name, description, POSTGRES_PHYSICAL_NAMING),
  /**
   * Creates a registry that detects physical-name collisions in the selected uniqueness
   * scopes.
   */
  createRegistry: () => createPhysicalNameRegistry(POSTGRES_PHYSICAL_NAMING),
}
