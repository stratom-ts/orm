import {
  POSTGRES_PHYSICAL_NAMING,
  createPhysicalNameRegistry,
  generatePhysicalName,
  validatePhysicalName,
} from '@/migrations/physicalNaming'

/** PostgreSQL physical naming semantics, bound to the selected dialect member. */
export const postgresNaming = {
  generate: (seed: Parameters<typeof generatePhysicalName>[0]) =>
    generatePhysicalName(seed, POSTGRES_PHYSICAL_NAMING),
  validate: (name: string, description: string) =>
    validatePhysicalName(name, description, POSTGRES_PHYSICAL_NAMING),
  createRegistry: () => createPhysicalNameRegistry(POSTGRES_PHYSICAL_NAMING),
}
