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
  const dependencies = drafts.map(() => new Set<number>())
  const identities = planned.identities

  /**
   * Records that one action must follow another.
   *
   * @param action - Index of the dependent action.
   * @param dependency - Index of the prerequisite action.
   */
  function dependsOn(action: number, dependency: number): void {
    if (action !== dependency) dependencies[action]!.add(dependency)
  }

  for (let action = 0; action < drafts.length; action++) {
    const current = drafts[action]!
    const relation = stepRelation(current.step)

    for (let candidate = 0; candidate < drafts.length; candidate++) {
      const other = drafts[candidate]!

      if (
        other.step.kind === 'ensure_namespace' &&
        relation &&
        sameNamespace(other.step.target.namespace, relation.namespace)
      ) {
        dependsOn(action, candidate)
      }

      if (
        other.step.kind === 'create_table' &&
        relation &&
        current.step.kind !== 'create_table' &&
        current.step.kind !== 'drop_table' &&
        identities.equals(other.step.target.relation, relation)
      ) {
        dependsOn(action, candidate)
      }

      if (
        current.step.kind === 'add_foreign_key' &&
        other.step.kind === 'create_table' &&
        identities.equals(other.step.target.relation, current.step.references.relation)
      ) {
        dependsOn(action, candidate)
      }

      if (
        current.step.kind === 'create_index' &&
        other.step.kind === 'add_column' &&
        identities.equals(current.step.target.relation, other.step.target.relation)
      ) {
        const addedColumn = other.step.target.column

        if (
          current.step.columns.some(
            (column) => column.comparisonKey === addedColumn.comparisonKey,
          )
        ) {
          dependsOn(action, candidate)
        }
      }

      if (
        current.step.kind === 'add_foreign_key' &&
        other.step.kind === 'add_column' &&
        ((identities.equals(current.step.target.relation, other.step.target.relation) &&
          current.step.target.column.comparisonKey ===
            other.step.target.column.comparisonKey) ||
          (identities.equals(
            current.step.references.relation,
            other.step.target.relation,
          ) &&
            current.step.references.column.comparisonKey ===
              other.step.target.column.comparisonKey))
      ) {
        dependsOn(action, candidate)
      }

      if (
        current.step.kind === 'drop_column' &&
        other.step.kind === 'drop_index' &&
        identities.equals(current.step.target.relation, other.step.target.relation)
      ) {
        const relation = current.step.target.relation
        const column = current.step.target.column.spelling
        const indexName = other.step.target.index.spelling
        const table = planned.planningCatalog.tables.find((entry) =>
          identities.equals(entry.identity, relation),
        )
        const index = table?.indexes.find(
          (entry) => entry.name === indexName && entry.columns.includes(column),
        )
        if (index) dependsOn(action, candidate)
      }

      if (current.step.kind === 'drop_table' && other.step.kind === 'drop_table') {
        const parentRelation = current.step.target.relation
        const childRelation = other.step.target.relation
        const child = planned.planningCatalog.tables.find((entry) =>
          identities.equals(entry.identity, childRelation),
        )

        if (
          child?.foreignKeys.some((foreignKey) =>
            identities.equals(foreignKey.referencedRelation, parentRelation),
          )
        ) {
          dependsOn(action, candidate)
        }
      }
    }
  }

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

  if (ordered.length === drafts.length) return { ordered, issues: [] }
  let nextIndex = 0
  const indexes = new Array<number | undefined>(drafts.length)
  const lowLinks = new Array<number>(drafts.length)
  const stack: number[] = []
  const onStack = new Set<number>()
  const cycles: number[][] = []

  /**
   * Visits one dependency node while collecting strongly connected components.
   *
   * @param node - Action index to visit.
   */
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

  for (let node = 0; node < drafts.length; node++) {
    if (indexes[node] === undefined) visit(node)
  }

  const issues = cycles.map((cycle) => {
    const sourceStepIndexes = cycle
      .map((index) => drafts[index]!.sourceStepIndex)
      .sort((left, right) => left - right)
    return {
      code: 'unsupported_dependency_cycle' as const,
      message: `PostgreSQL cannot safely order migration steps ${sourceStepIndexes.join(', ')} without CASCADE`,
      sourceStepIndexes,
    }
  })
  return {
    ordered: [],
    issues,
  }
}
