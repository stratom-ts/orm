import type { MigrationStep, PlannedMigration } from '@/ddl/migrationPlan'
import type { MigrationCapabilityIssue } from '@/ddl/migrationProgram'
import type { CompiledQuery } from '@/dialects/types'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'

export type ActionDraft = {
  step: MigrationStep
  sourceStepIndex: number
  statement: CompiledQuery
}

type OrderedActions = {
  ordered: ActionDraft[]
  issues: MigrationCapabilityIssue[]
}

/**
 * Returns the relation addressed by a relation or member step.
 *
 * @param step - Migration step whose relation is requested.
 */
function stepRelation(step: MigrationStep): CanonicalRelationIdentity | undefined {
  return step.target.kind === 'namespace' ? undefined : step.target.relation
}

/**
 * Compares canonical namespaces without relying on dotted encodings.
 *
 * @param left - First canonical namespace.
 * @param right - Second canonical namespace.
 */
function sameNamespace(
  left: CanonicalRelationIdentity['namespace'],
  right: CanonicalRelationIdentity['namespace'],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (segment, index) =>
        segment.role === right[index]?.role &&
        segment.identifier.comparisonKey === right[index]?.identifier.comparisonKey,
    )
  )
}

function followsNamespace(
  other: ActionDraft,
  relation: CanonicalRelationIdentity | undefined,
): boolean {
  return (
    other.step.kind === 'ensure_namespace' &&
    relation !== undefined &&
    sameNamespace(other.step.target.namespace, relation.namespace)
  )
}

function followsCreatedRelation(
  current: ActionDraft,
  other: ActionDraft,
  relation: CanonicalRelationIdentity | undefined,
  planned: PlannedMigration,
): boolean {
  return (
    other.step.kind === 'create_table' &&
    relation !== undefined &&
    current.step.kind !== 'create_table' &&
    current.step.kind !== 'drop_table' &&
    planned.identities.equals(other.step.target.relation, relation)
  )
}

function followsReferencedRelation(
  current: ActionDraft,
  other: ActionDraft,
  planned: PlannedMigration,
): boolean {
  return (
    current.step.kind === 'add_foreign_key' &&
    other.step.kind === 'create_table' &&
    planned.identities.equals(
      other.step.target.relation,
      current.step.references.relation,
    )
  )
}

function followsIndexedColumn(
  current: ActionDraft,
  other: ActionDraft,
  planned: PlannedMigration,
): boolean {
  if (current.step.kind !== 'create_index' || other.step.kind !== 'add_column') {
    return false
  }

  if (
    !planned.identities.equals(current.step.target.relation, other.step.target.relation)
  ) {
    return false
  }

  const addedColumn = other.step.target.column.comparisonKey
  return current.step.columns.some((column) => column.comparisonKey === addedColumn)
}

function followsForeignKeyColumn(
  current: ActionDraft,
  other: ActionDraft,
  planned: PlannedMigration,
): boolean {
  if (current.step.kind !== 'add_foreign_key' || other.step.kind !== 'add_column') {
    return false
  }

  const identities = planned.identities
  const addedColumn = other.step.target.column
  const addsSource =
    identities.equals(current.step.target.relation, other.step.target.relation) &&
    current.step.target.column.comparisonKey === addedColumn.comparisonKey
  const addsTarget =
    identities.equals(current.step.references.relation, other.step.target.relation) &&
    current.step.references.column.comparisonKey === addedColumn.comparisonKey
  return addsSource || addsTarget
}

function followsDroppedIndex(
  current: ActionDraft,
  other: ActionDraft,
  planned: PlannedMigration,
): boolean {
  if (current.step.kind !== 'drop_column' || other.step.kind !== 'drop_index') {
    return false
  }

  const identities = planned.identities

  if (!identities.equals(current.step.target.relation, other.step.target.relation)) {
    return false
  }

  const relation = current.step.target.relation
  const column = current.step.target.column.spelling
  const indexName = other.step.target.index.spelling
  const table = planned.planningCatalog.tables.find((entry) =>
    identities.equals(entry.identity, relation),
  )
  return (
    table?.indexes.some(
      (entry) => entry.name === indexName && entry.columns.includes(column),
    ) === true
  )
}

function followsReferencingTable(
  current: ActionDraft,
  other: ActionDraft,
  planned: PlannedMigration,
): boolean {
  if (current.step.kind !== 'drop_table' || other.step.kind !== 'drop_table') {
    return false
  }

  const identities = planned.identities
  const parentRelation = current.step.target.relation
  const childRelation = other.step.target.relation
  const child = planned.planningCatalog.tables.find((entry) =>
    identities.equals(entry.identity, childRelation),
  )
  return (
    child?.foreignKeys.some((foreignKey) =>
      identities.equals(foreignKey.referencedRelation, parentRelation),
    ) === true
  )
}

/** Reports whether one physical action must follow another. */
function actionDependsOn(
  current: ActionDraft,
  other: ActionDraft,
  planned: PlannedMigration,
): boolean {
  const relation = stepRelation(current.step)
  return (
    followsNamespace(other, relation) ||
    followsCreatedRelation(current, other, relation, planned) ||
    followsReferencedRelation(current, other, planned) ||
    followsIndexedColumn(current, other, planned) ||
    followsForeignKeyColumn(current, other, planned) ||
    followsDroppedIndex(current, other, planned) ||
    followsReferencingTable(current, other, planned)
  )
}

/** Builds deterministic prerequisite indexes for every action draft. */
function actionDependencies(
  drafts: readonly ActionDraft[],
  planned: PlannedMigration,
): Set<number>[] {
  const dependencies = drafts.map(() => new Set<number>())

  for (let action = 0; action < drafts.length; action++) {
    for (let candidate = 0; candidate < drafts.length; candidate++) {
      if (
        action !== candidate &&
        actionDependsOn(drafts[action]!, drafts[candidate]!, planned)
      ) {
        dependencies[action]!.add(candidate)
      }
    }
  }

  return dependencies
}

/** Returns the source-ordered topological prefix of an action graph. */
function topologicalOrder(
  drafts: readonly ActionDraft[],
  dependencies: readonly Set<number>[],
): ActionDraft[] {
  const remaining = dependencies.map((edges) => new Set(edges))
  const available = drafts
    .map((_, index) => index)
    .filter((index) => remaining[index]!.size === 0)
  const ordered: ActionDraft[] = []

  while (available.length > 0) {
    available.sort(
      (left, right) => drafts[left]!.sourceStepIndex - drafts[right]!.sourceStepIndex,
    )
    const next = available.shift()!
    ordered.push(drafts[next]!)

    for (let index = 0; index < remaining.length; index++) {
      if (!remaining[index]!.delete(next) || remaining[index]!.size !== 0) continue
      if (!ordered.includes(drafts[index]!)) available.push(index)
    }
  }

  return ordered
}

/** Finds strongly connected components in an action dependency graph. */
function dependencyCycles(dependencies: readonly Set<number>[]): number[][] {
  let nextIndex = 0
  const indexes = new Array<number | undefined>(dependencies.length)
  const lowLinks = new Array<number>(dependencies.length)
  const stack: number[] = []
  const onStack = new Set<number>()
  const cycles: number[][] = []

  function visit(node: number): void {
    indexes[node] = nextIndex
    lowLinks[node] = nextIndex++
    stack.push(node)
    onStack.add(node)

    for (const dependency of dependencies[node]!) {
      if (indexes[dependency] === undefined) {
        visit(dependency)
        lowLinks[node] = Math.min(lowLinks[node]!, lowLinks[dependency]!)
      } else if (onStack.has(dependency)) {
        lowLinks[node] = Math.min(lowLinks[node]!, indexes[dependency]!)
      }
    }

    if (lowLinks[node] !== indexes[node]) return

    const component: number[] = []
    let member: number

    do {
      member = stack.pop()!
      onStack.delete(member)
      component.push(member)
    } while (member !== node)

    if (
      component.length > 1 ||
      (component.length === 1 && dependencies[node]!.has(node))
    ) {
      cycles.push(component)
    }
  }

  for (let node = 0; node < dependencies.length; node++) {
    if (indexes[node] === undefined) visit(node)
  }

  return cycles
}

/** Formats dependency cycles as deterministic lowering issues. */
function cycleIssues(
  drafts: readonly ActionDraft[],
  dependencies: readonly Set<number>[],
): MigrationCapabilityIssue[] {
  return dependencyCycles(dependencies).map((cycle) => {
    const sourceStepIndexes = cycle
      .map((index) => drafts[index]!.sourceStepIndex)
      .sort((left, right) => left - right)
    return {
      code: 'unsupported_dependency_cycle' as const,
      message: `PostgreSQL cannot safely order migration steps ${sourceStepIndexes.join(', ')} without CASCADE`,
      sourceStepIndexes,
    }
  })
}

/**
 * Adds deterministic dependency edges and topologically orders action drafts.
 *
 * @example
 *   const { ordered, issues } = orderActions(drafts, planned)
 *
 * @param drafts - Physical action drafts in source-step order.
 * @param planned - Planned migration supplying identities and catalog dependencies.
 */
export function orderActions(
  drafts: readonly ActionDraft[],
  planned: PlannedMigration,
): OrderedActions {
  const dependencies = actionDependencies(drafts, planned)
  const ordered = topologicalOrder(drafts, dependencies)
  if (ordered.length === drafts.length) return { ordered, issues: [] }

  return { ordered: [], issues: cycleIssues(drafts, dependencies) }
}
