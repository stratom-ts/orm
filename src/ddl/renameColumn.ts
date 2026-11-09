import type { CatalogRelation, CatalogSnapshot, CatalogTable } from '@/dialects/catalog'
import type {
  CanonicalIdentifier,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import { resolveMigrationOwnership } from '@/migrations/migrationOwnership'
import type { MigrationOwnershipDeclaration } from '@/migrations/migrationOwnership'
import type { TableHandle } from '@/types'
import { MigrationError } from '@/utils/error'

import { lowerDesiredSchema } from './desiredSchema'
import type {
  MigrationPlanningContext,
  MigrationStep,
  PlannedMigration,
} from './migrationPlan'

/** Explicit physical column mapping. Neither name is an application property key. */
type MigrationColumnRename = Readonly<{ table: TableHandle; from: string; to: string }>
type RenameStep = Extract<MigrationStep, { kind: 'rename_column' }>

type RenameOptions = {
  registrationDefault?: readonly NamespaceIdentifierInput[]
  migrationOwnership?: readonly MigrationOwnershipDeclaration[]
  renames?: readonly MigrationColumnRename[]
}

/** Resolves the entire intent set before projecting any member. */
function projectColumnRenames(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
  planning: MigrationPlanningContext,
  options: RenameOptions,
): { catalog: CatalogSnapshot; steps: RenameStep[] } {
  if (!options.renames?.length) return { catalog, steps: [] }

  const projection = new RenameProjection(schemas, catalog, planning, options)
  const steps = projection.resolve()

  if (!steps.length) return { catalog, steps }

  projection.assertDependencies(steps)
  return { catalog: projectCatalog(catalog, steps, projection.identities), steps }
}

/** Holds operation-local resolution state, never authored handle metadata. */
class RenameProjection {
  readonly identities
  readonly ownership
  readonly desired

  constructor(
    readonly schemas: readonly TableHandle[],
    readonly catalog: CatalogSnapshot,
    readonly planning: MigrationPlanningContext,
    readonly options: RenameOptions,
  ) {
    this.identities = planning.identity.create({
      context: catalog.namespaceContext,
      registrationDefault: options.registrationDefault,
    })
    this.ownership = resolveMigrationOwnership(
      schemas,
      options.migrationOwnership ?? [],
      this.identities,
    )
    this.desired = lowerDesiredSchema(schemas, this.identities, planning.schema)
  }

  normalize(intent: MigrationColumnRename): RenameStep {
    if (!this.schemas.includes(intent.table)) fail('table handle must be registered')

    const relation = this.identities.resolve(intent.table.getTableMetadata().relation)

    if (!this.ownership.relationShape(relation))
      fail('target is outside migration ownership')

    this.planning.naming.validate(intent.from, 'rename source column')
    this.planning.naming.validate(intent.to, 'rename destination column')
    const from = this.identities.member('column', intent.from)
    const to = this.identities.member('column', intent.to)

    if (from.comparisonKey === to.comparisonKey)
      fail('source and destination must have distinct comparison keys')

    const table = this.desired.tables.find((table) =>
      this.identities.equals(table.identity, relation),
    )

    if (
      !table?.columns.some(
        (column) => column.identifier.comparisonKey === to.comparisonKey,
      )
    )
      fail('destination is not a desired physical column')

    if (
      table.columns.some(
        (column) => column.identifier.comparisonKey === from.comparisonKey,
      )
    )
      fail('source is still a desired physical column')

    return {
      kind: 'rename_column',
      target: { kind: 'column', relation, column: to },
      from,
    }
  }

  resolve(): RenameStep[] {
    const intents: RenameStep[] = []

    const normalized = (this.options.renames ?? []).map((intent) =>
      this.normalize(intent),
    )

    normalized.sort(
      (a, b) =>
        this.identities.compare(a.target.relation, b.target.relation) ||
        compare(a.target.column, b.target.column) ||
        compare(a.from, b.from),
    )

    for (const step of normalized) {
      const peers = intents.filter((other) =>
        this.identities.equals(other.target.relation, step.target.relation),
      )

      if (!hasMapping(peers, step)) {
        assertIndependent(peers, step)
        intents.push(step)
      }
    }

    return intents.filter((step) => this.isActive(step))
  }

  isActive(step: RenameStep): boolean {
    const relations = this.catalog.namespaces.items.flatMap(
      (namespace) => namespace.relations.items,
    )

    const relation = relations.find((entry) =>
      this.identities.equals(entry.identity, step.target.relation),
    )

    // Normal reconciliation proves absence and rejects unmanaged object collisions.
    if (!relation) return false

    if (
      relation.management !== 'managed' ||
      relation.kind !== 'table' ||
      relation.table.state !== 'present'
    )
      fail('target lacks an ordinary managed table')

    const table = relation.table.value

    if (table.columns.coverage.state !== 'complete') fail('incomplete column evidence')

    const has = (key: string) =>
      table.columns.items.some(
        (column) => this.identities.member('column', column.name).comparisonKey === key,
      )

    const source = has(step.from.comparisonKey)
    const destination = has(step.target.column.comparisonKey)

    if (source === destination)
      fail('existing table must contain exactly one of source and destination')

    return source
  }

  assertDependencies(steps: RenameStep[]): void {
    const dependencies = this.catalog.renameDependencies

    if (dependencies?.coverage.state !== 'complete')
      fail('complete dependency observation is required')

    for (const step of steps) {
      if (
        !dependencies.items.some((relation) =>
          this.identities.equals(relation.identity, step.target.relation),
        )
      )
        fail('dependency evidence omits rename target')
    }

    for (const relation of dependencies.items) {
      this.assertRelationDependencies(relation, steps)
    }
  }

  assertRelationDependencies(relation: CatalogRelation, steps: RenameStep[]): void {
    const local = steps.some((step) =>
      this.identities.equals(step.target.relation, relation.identity),
    )

    if (
      local &&
      (relation.kind !== 'table' ||
        relation.management !== 'managed' ||
        relation.persistence !== 'permanent')
    )
      fail('unsupported relation behavior')

    if (relation.table.state !== 'present') {
      if (local) fail('missing dependency table evidence')

      return
    }

    const table = relation.table.value

    if (table.foreignKeys.coverage.state !== 'complete')
      fail('incomplete inbound foreign-key coverage')

    const inbound = table.foreignKeys.items.some((key) =>
      steps.some((step) =>
        this.identities.equals(step.target.relation, key.referencedRelation),
      ),
    )

    if (!local && !inbound) return

    if (
      relation.kind !== 'table' ||
      relation.management !== 'managed' ||
      relation.persistence !== 'permanent'
    )
      fail('unsupported inbound relation behavior')

    assertTableDependencies(table)

    assertLocalDependencies(table)
  }
}

function fail(message: string): never {
  throw new MigrationError({ message: `Column rename: ${message}` })
}

function hasMapping(peers: readonly RenameStep[], step: RenameStep): boolean {
  return peers.some(
    (other) =>
      other.from.comparisonKey === step.from.comparisonKey &&
      other.target.column.comparisonKey === step.target.column.comparisonKey,
  )
}

function assertIndependent(peers: readonly RenameStep[], step: RenameStep): void {
  const overlaps = peers.some((other) =>
    [other.from.comparisonKey, other.target.column.comparisonKey].some(
      (key) =>
        key === step.from.comparisonKey || key === step.target.column.comparisonKey,
    ),
  )

  if (overlaps) fail('overlapping mappings, chains, and cycles are unsupported')
}

function assertTableDependencies(table: CatalogTable): void {
  for (const set of [table.indexes, table.uniqueConstraints, table.foreignKeys]) {
    if (set.coverage.state !== 'complete') fail('incomplete constraint/index evidence')

    set.items.forEach(assertSimpleDependency)
  }

  if (table.primaryKey.state !== 'absent') {
    if (table.primaryKey.state !== 'present') fail('unsupported primary key dependency')

    assertSimpleDependency(table.primaryKey.value)
  }

  if (
    table.opaqueObjects.coverage.state !== 'complete' ||
    table.opaqueObjects.items.length
  )
    fail('opaque or incomplete dependency evidence')
}

function assertSimpleDependency(
  member:
    | CatalogTable['indexes']['items'][number]
    | CatalogTable['foreignKeys']['items'][number]
    | CatalogTable['uniqueConstraints']['items'][number],
): void {
  if (
    member.semantics.state !== 'present' ||
    member.validity.state !== 'present' ||
    member.validity.value !== 'valid'
  )
    fail('unsupported constraint/index dependency')
}

function assertLocalDependencies(table: CatalogTable): void {
  if (
    table.options.coverage.state !== 'complete' ||
    table.options.items.some(
      (option) => !['false', 'heap', '', 'd'].includes(option.value),
    )
  )
    fail('unsupported table options')

  if (
    table.columns.items.some(
      (column) =>
        column.generation.state === 'present' &&
        column.generation.value.kind === 'computed',
    )
  )
    fail('computed column dependency')
}

/** Projects only supported structural members. SQL text and object names remain evidence. */
function projectCatalog(
  catalog: CatalogSnapshot,
  steps: readonly RenameStep[],
  identities: CanonicalRelationIdentityModule,
): CatalogSnapshot {
  const name = (relation: CanonicalRelationIdentity, column: string) =>
    steps.find(
      (step) =>
        identities.equals(step.target.relation, relation) &&
        identities.member('column', column).comparisonKey === step.from.comparisonKey,
    )?.target.column.spelling ?? column

  const project = (relation: CatalogRelation): CatalogRelation =>
    relation.table.state === 'present'
      ? {
          ...relation,
          table: {
            state: 'present',
            value: projectTable(relation.table.value, relation.identity, name),
          },
        }
      : relation

  return {
    ...catalog,
    namespaces: {
      ...catalog.namespaces,
      items: catalog.namespaces.items.map((namespace) => ({
        ...namespace,
        relations: {
          ...namespace.relations,
          items: namespace.relations.items.map(project),
        },
      })),
    },
    renameDependencies: {
      coverage: { state: 'complete' },
      items: catalog.renameDependencies!.items.map(project),
    },
  }
}

function projectTable(
  table: CatalogTable,
  relation: CanonicalRelationIdentity,
  name: (relation: CanonicalRelationIdentity, column: string) => string,
): CatalogTable {
  const names = (columns: readonly string[]) =>
    columns.map((column) => name(relation, column))

  const key = <T extends { columns: readonly string[] }>(value: T): T => ({
    ...value,
    columns: names(value.columns),
  })

  return {
    ...table,
    columns: {
      ...table.columns,
      items: table.columns.items.map((column) => ({
        ...column,
        name: name(relation, column.name),
      })),
    },
    primaryKey:
      table.primaryKey.state === 'present'
        ? { state: 'present', value: key(table.primaryKey.value) }
        : table.primaryKey,
    uniqueConstraints: {
      ...table.uniqueConstraints,
      items: table.uniqueConstraints.items.map(key),
    },
    indexes: { ...table.indexes, items: table.indexes.items.map(key) },
    foreignKeys: {
      ...table.foreignKeys,
      items: table.foreignKeys.items.map((foreign) => ({
        ...key(foreign),
        referencedColumns: foreign.referencedColumns.map((column) =>
          name(foreign.referencedRelation, column),
        ),
      })),
    },
  }
}

function compare(a: CanonicalIdentifier, b: CanonicalIdentifier): number {
  return a.comparisonKey < b.comparisonKey
    ? -1
    : a.comparisonKey > b.comparisonKey
      ? 1
      : a.spelling < b.spelling
        ? -1
        : a.spelling > b.spelling
          ? 1
          : 0
}

/** Finds the original physical address for a guard evaluated before rename actions. */
function originalColumnName(
  planned: PlannedMigration,
  relation: CanonicalRelationIdentity,
  column: string,
): string {
  return (
    planned.plan.steps.find(
      (step): step is RenameStep =>
        step.kind === 'rename_column' &&
        planned.identities.equals(step.target.relation, relation) &&
        step.target.column.comparisonKey ===
          planned.identities.member('column', column).comparisonKey,
    )?.from.spelling ?? column
  )
}

export type { MigrationColumnRename }
export { projectColumnRenames, originalColumnName }
