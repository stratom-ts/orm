import type {
  MigrationSemanticProfile,
  MigrationStep,
  PlannedMigration,
} from '@/ddl/migrationPlan'
import type {
  MigrationAction,
  MigrationCapabilityIssue,
  MigrationLoweringResult,
  MigrationPrecondition,
} from '@/ddl/migrationProgram'
import { attemptSync } from '@/utils/error'

import { asciiFoldSqliteIdentifier, sqliteIdentity } from '../identity'
import { assertSafeSqliteDataType } from '../validate'

import {
  desiredDefinition,
  literalDefault,
  observedDefinition,
  observedTable,
  quote,
  sameName,
} from './definition'
import { SqliteMigrationCapabilityError, capabilityCheck } from './error'
import { finalDefinition, rebuild } from './rebuild'
import type { TableGroup } from './rebuild'
import {
  address,
  assertIdentifier,
  assertMain,
  columnSql,
  createSql,
  indexSql,
  statement,
} from './sql'

/** Tests a writable or configured namespace under the plan's identity adapter. */
function namespaceKey(
  planned: PlannedMigration,
  input: MigrationSemanticProfile['registrationDefault'],
): string {
  if (!input?.length) return ''

  return JSON.stringify(
    planned.identities
      .resolveNamespace(input)
      .map((segment) => [segment.role, segment.identifier.comparisonKey]),
  )
}

/** Rejects mismatched executing semantics before examining any physical actions. */
function checkProfile(
  planned: PlannedMigration,
  expected: MigrationSemanticProfile,
): void {
  if (
    expected.identityAdapter !== sqliteIdentity.id ||
    planned.profile.identityAdapter !== expected.identityAdapter
  )
    throw new SqliteMigrationCapabilityError(
      'profile_mismatch',
      'SQLite identity adapter does not match the executing Semantic Profile',
    )

  if (
    namespaceKey(planned, planned.profile.namespaceContext.writableDefault) !==
    namespaceKey(planned, expected.namespaceContext.writableDefault)
  )
    throw new SqliteMigrationCapabilityError(
      'profile_mismatch',
      'SQLite writable namespace context does not match the executing session',
    )

  if (
    namespaceKey(planned, planned.profile.registrationDefault) !==
    namespaceKey(planned, expected.registrationDefault)
  )
    throw new SqliteMigrationCapabilityError(
      'profile_mismatch',
      'SQLite registration default does not match the executing configuration',
    )

  try {
    assertMain(planned.identities.resolve({ relation: 'profile_probe' }))
  } catch (cause) {
    if (!(cause instanceof SqliteMigrationCapabilityError)) throw cause

    throw new SqliteMigrationCapabilityError('profile_mismatch', cause.message)
  }

  const [major, minor] = planned.catalogSnapshot.source.version.split('.').map(Number)

  if (
    planned.catalogSnapshot.source.dialect !== 'sqlite' ||
    !(major! > 3 || (major === 3 && minor! >= 37))
  )
    throw new SqliteMigrationCapabilityError(
      'profile_mismatch',
      'SQLite migrations require authoritative SQLite >=3.37 catalog evidence',
    )
}

/** Validates every structured target and payload identifier before grouping table actions. */
function checkStep(step: MigrationStep): void {
  const kind =
    step.kind === 'ensure_namespace'
      ? 'namespace'
      : ['create_table', 'drop_table'].includes(step.kind)
        ? 'relation'
        : ['create_index', 'drop_index'].includes(step.kind)
          ? 'index'
          : 'column'

  if (step.target.kind !== kind)
    throw new SqliteMigrationCapabilityError(
      'invalid_target',
      'SQLite step has an incompatible structured Migration Target',
    )

  if (step.kind === 'add_column' || step.kind === 'alter_column_type')
    capabilityCheck(() => assertSafeSqliteDataType(step.dataType), 'invalid_target')

  if (step.target.kind === 'namespace') {
    assertMain({
      namespace: step.target.namespace,
      relation: { spelling: 'placeholder', comparisonKey: 'placeholder' },
    })

    return
  }

  assertMain(step.target.relation)

  if (step.target.kind === 'column') assertIdentifier(step.target.column)
  if (step.target.kind === 'index') assertIdentifier(step.target.index)
  if (step.kind === 'create_index') step.columns.forEach(assertIdentifier)

  if (step.kind === 'add_foreign_key') {
    assertMain(step.references.relation)
    assertIdentifier(step.references.column)
  }
}

/** Groups all touching changes under canonical relation identity. */
function tableGroups(planned: PlannedMigration): TableGroup[] {
  const groups = planned.identities.createRegistry<TableGroup>()
  const ordered: TableGroup[] = []
  for (const [index, step] of planned.plan.steps.entries()) {
    if (step.target.kind === 'namespace') continue

    const identity = step.target.relation
    let group = groups.get(identity)

    if (!group) {
      group = { identity, steps: [] }
      ordered.push(group)
    }

    group.steps.push({ step, index })
    groups.set(identity, group)
  }

  return ordered
}

/**
 * Reserves deterministic replacement names against both live objects and all planned
 * targets.
 */
function replacementNames(
  planned: PlannedMigration,
  groups: readonly TableGroup[],
): Map<TableGroup, string> {
  const occupied = new Set(
    planned.planningCatalog.nameReservations.map(({ name }) =>
      asciiFoldSqliteIdentifier(name),
    ),
  )

  for (const group of groups) occupied.add(group.identity.relation.comparisonKey)
  for (const step of planned.plan.steps)
    if (step.target.kind === 'index') occupied.add(step.target.index.comparisonKey)
  const names = new Map<TableGroup, string>()
  for (const group of groups) {
    let suffix = 0
    const base = `__stratom_rebuild_${hashName(group.identity.relation.comparisonKey)}`
    while (occupied.has(`${base}_${suffix}`)) suffix++
    const name = `${base}_${suffix}`
    occupied.add(name)
    names.set(group, name)
  }

  return names
}

/** Produces a stable identifier-sized seed without relying on process state. */
function hashName(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++)
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(16)
}

/**
 * Uses direct ADD only when no constraints, generation or restricted default require a
 * rebuild.
 */
function directGroup(planned: PlannedMigration, group: TableGroup): boolean {
  return group.steps.every(({ step }) => {
    if (['create_index', 'drop_index'].includes(step.kind)) return true
    if (step.kind === 'drop_column') return directDrop(planned, group, step)

    return (
      step.kind === 'add_column' &&
      !step.unique &&
      !step.autoIncrement &&
      !step.generated &&
      literalDefault(step.databaseDefault?.sql) &&
      (!step.notNull ||
        (step.databaseDefault?.sql !== undefined &&
          !/^null$/i.test(step.databaseDefault.sql)))
    )
  })
}

/** Uses native DROP COLUMN only when no retained local constraint depends on the column. */
function directDrop(
  planned: PlannedMigration,
  group: TableGroup,
  step: Extract<MigrationStep, { kind: 'drop_column' }>,
): boolean {
  const definition = observedDefinition(observedTable(planned, group.identity))
  const name = step.target.column.spelling
  const touches = (columns: readonly string[]) =>
    columns.some((column) => sameName(column, name))

  return (
    !touches(definition.primaryKey) &&
    !definition.unique.some(touches) &&
    !definition.foreignKeys.some((key) => touches(key.columns)) &&
    !definition.indexes.some((index) => touches(index.columns))
  )
}

/** Compiles a newly created table and all of its plan-owned simple indexes. */
function createAction(planned: PlannedMigration, group: TableGroup): MigrationAction {
  const desired = planned.desiredTables.get(group.identity)

  if (!desired)
    throw new SqliteMigrationCapabilityError(
      'missing_desired_table',
      'SQLite CREATE TABLE lacks a registered desired table',
    )

  const definition = desiredDefinition(desired)
  const name = group.identity.relation.spelling

  const indexes = group.steps
    .filter(({ step }) => step.kind === 'create_index')
    .map(({ step }) => {
      if (step.kind !== 'create_index')
        throw new SqliteMigrationCapabilityError(
          'invalid_target',
          'Invalid SQLite index step',
        )

      return indexSql(name, {
        name: step.target.index.spelling,
        columns: step.columns.map((column) => column.spelling),
        unique: step.unique,
      })
    })

  return {
    sourceStepIndexes: group.steps.map(({ index }) => index),
    transaction: 'required',
    statements: [createSql(name, definition), ...indexes],
  }
}

/** Compiles direct column/index actions after checking complete catalog evidence. */
function directAction(planned: PlannedMigration, group: TableGroup): MigrationAction {
  const definition = finalDefinition(planned, group)
  const name = group.identity.relation.spelling
  const statements = group.steps.map(({ step }) => {
    if (step.kind === 'drop_column')
      return statement(
        `alter table ${address(name)} drop column ${quote(step.target.column.spelling)}`,
      )

    if (step.kind === 'drop_index')
      return statement(`drop index ${address(step.target.index.spelling)}`)

    if (step.kind === 'create_index')
      return indexSql(name, {
        name: step.target.index.spelling,
        columns: step.columns.map((column) => column.spelling),
        unique: step.unique,
      })

    if (step.kind !== 'add_column')
      throw new SqliteMigrationCapabilityError(
        'invalid_target',
        'Invalid SQLite direct operation',
      )

    const column = definition.columns.find(
      (candidate) =>
        asciiFoldSqliteIdentifier(candidate.name) === step.target.column.comparisonKey,
    )

    if (!column)
      throw new SqliteMigrationCapabilityError(
        'compile_failure',
        'Missing final SQLite column',
      )

    return statement(`alter table ${address(name)} add column ${columnSql(column)}`)
  })

  return {
    sourceStepIndexes: group.steps.map(({ index }) => index),
    transaction: 'required',
    statements: [statements[0]!, ...statements.slice(1)],
  }
}

/** Lowers one complete table group into a legal direct action or an atomic rebuild. */
function lowerGroup(planned: PlannedMigration, group: TableGroup, replacement: string) {
  checkDestructiveDependencies(planned, group)
  checkUniqueIndexDrops(planned, group)

  if (group.steps.some(({ step }) => step.kind === 'create_table'))
    return { action: createAction(planned, group), preconditions: [] }

  if (group.steps.some(({ step }) => step.kind === 'drop_table')) {
    observedTable(planned, group.identity)
    return {
      action: {
        sourceStepIndexes: group.steps.map(({ index }) => index),
        transaction: 'required' as const,
        statements: [
          statement(`drop table ${address(group.identity.relation.spelling)}`),
        ] as const,
      },
      preconditions: [],
    }
  }

  if (directGroup(planned, group))
    return { action: directAction(planned, group), preconditions: [] }

  return rebuild(planned, group, replacement)
}

/** Requires complete incoming FK evidence for destructive table or column drops. */
function checkDestructiveDependencies(
  planned: PlannedMigration,
  group: TableGroup,
): void {
  const droppedColumns = group.steps
    .filter(({ step }) => step.kind === 'drop_column')
    .map(({ step }) =>
      step.target.kind === 'column' ? step.target.column.comparisonKey : '',
    )

  const dropTable = group.steps.some(({ step }) => step.kind === 'drop_table')

  if (!dropTable && !droppedColumns.length) return

  requireDependencyEvidence(planned)

  for (const table of planned.planningCatalog.tables) {
    const retained = retainedIncomingKeys(planned, table.identity, group.identity)

    if (
      retained.some(
        (key) =>
          dropTable ||
          key.referencedColumns.some((column) =>
            droppedColumns.includes(asciiFoldSqliteIdentifier(column)),
          ),
      )
    )
      throw new SqliteMigrationCapabilityError(
        'compile_failure',
        'SQLite destructive drop has a retained incoming foreign-key dependency',
      )
  }
}

/** Requires exhaustive namespace coverage before discarding potential FK candidate keys. */
function requireDependencyEvidence(planned: PlannedMigration): void {
  const namespace = planned.catalogSnapshot.namespaces.items.find(
    (entry) => entry.identity[0]?.identifier.comparisonKey === 'main',
  )

  if (
    namespace?.relations.coverage.state !== 'complete' ||
    namespace.relations.items.some((relation) => relation.management !== 'managed')
  )
    throw new SqliteMigrationCapabilityError(
      'compile_failure',
      'SQLite destructive drops require complete main namespace dependency evidence',
    )
}

/** Reads final incoming FKs after applying this plan's source-table changes. */
function retainedIncomingKeys(
  planned: PlannedMigration,
  source: TableGroup['identity'],
  target: TableGroup['identity'],
) {
  const group = tableGroups(planned).find((item) =>
    planned.identities.equals(item.identity, source),
  )

  if (group?.steps.some(({ step }) => step.kind === 'drop_table')) return []

  const definition = group?.steps.some(({ step }) => step.kind === 'create_table')
    ? desiredDefinition(planned.desiredTables.get(source)!)
    : group
      ? finalDefinition(planned, group)
      : observedDefinition(observedTable(planned, source))

  return definition.foreignKeys.filter((key) =>
    planned.identities.equals(key.relation, target),
  )
}

/** Rejects loss of an FK candidate key before any unique-index drop reaches DDL. */
function checkUniqueIndexDrops(planned: PlannedMigration, group: TableGroup): void {
  const drops = group.steps.flatMap(({ step }) =>
    step.kind === 'drop_index' ? [step.target.index.spelling] : [],
  )

  if (!drops.length) return

  const original = observedDefinition(observedTable(planned, group.identity))
  const final = finalDefinition(planned, group)
  const candidates = [
    final.primaryKey,
    ...final.unique,
    ...final.indexes.filter((index) => index.unique).map((index) => index.columns),
  ]

  const lost = original.indexes.filter(
    (index) =>
      index.unique &&
      drops.some((name) => sameName(name, index.name)) &&
      !candidates.some((key) => sameColumns(key, index.columns)),
  )

  if (!lost.length) return

  requireDependencyEvidence(planned)
  const sources = [
    ...planned.planningCatalog.tables.map((table) => table.identity),
    ...tableGroups(planned).map((item) => item.identity),
  ]

  if (
    sources.some((source) =>
      retainedIncomingKeys(planned, source, group.identity).some((key) =>
        lost.some((index) => sameColumns(index.columns, key.referencedColumns)),
      ),
    )
  )
    throw new SqliteMigrationCapabilityError(
      'compile_failure',
      'SQLite unique-index drop has a retained incoming foreign-key dependency',
    )
}

/** Compares key column membership under SQLite identifier semantics. */
function sameColumns(left: readonly string[], right: readonly string[]): boolean {
  return (
    JSON.stringify(left.map(asciiFoldSqliteIdentifier).sort()) ===
    JSON.stringify(right.map(asciiFoldSqliteIdentifier).sort())
  )
}

/**
 * Orders table actions by semantic dependencies, with stable ordering for legal FK
 * cycles.
 */
function orderGroups(planned: PlannedMigration, groups: TableGroup[]): TableGroup[] {
  const ordered: TableGroup[] = []
  const pending = [...groups].sort((left, right) =>
    planned.identities.compare(left.identity, right.identity),
  )

  while (pending.length) {
    const ready = pending.findIndex(
      (group) =>
        !pending.some((other) => other !== group && dependsOn(planned, group, other)),
    )

    // FK enforcement is off; cyclic groups are legal and checked together before commit.
    ordered.push(pending.splice(ready < 0 ? 0 : ready, 1)[0]!)
  }

  return ordered
}

/**
 * Detects desired creation dependencies and reverses live dependencies for dropped
 * tables.
 */
function dependsOn(
  planned: PlannedMigration,
  group: TableGroup,
  other: TableGroup,
): boolean {
  const dropping = group.steps.some(({ step }) => step.kind === 'drop_table')
  const otherDropping = other.steps.some(({ step }) => step.kind === 'drop_table')

  if (dropping !== otherDropping) return dropping

  if (dropping)
    return (
      planned.planningCatalog.tables
        .find((table) => planned.identities.equals(table.identity, other.identity))
        ?.foreignKeys.some((key) =>
          planned.identities.equals(key.referencedRelation, group.identity),
        ) ?? false
    )

  return (
    planned.desiredTables
      .get(group.identity)
      ?.columns.some(
        (column) =>
          column.reference &&
          planned.identities.equals(column.reference.relation, other.identity),
      ) ?? false
  )
}

/** Lowers an entire SQLite Migration Plan; any issue suppresses the complete program. */
export function lowerSqliteMigrationPlan(
  planned: PlannedMigration,
  expected: MigrationSemanticProfile,
): MigrationLoweringResult {
  const issues = profileIssues(planned, expected)

  if (issues.length) return { issues }

  issues.push(...rowidIssues(planned))

  for (const [index, step] of planned.plan.steps.entries()) {
    issues.push(...stepIssues(planned, step, index))
  }

  if (issues.length) return { issues }

  const groups = tableGroups(planned)
  const names = replacementNames(planned, groups)
  const actions: MigrationAction[] = []
  const preconditions: MigrationPrecondition[] = []
  for (const group of orderGroups(planned, groups)) {
    const result = attemptSync(() => lowerGroup(planned, group, names.get(group)!))

    if (result.ok) {
      actions.push(result.value.action)
      preconditions.push(...result.value.preconditions)
      continue
    }

    if (!(result.error instanceof SqliteMigrationCapabilityError)) throw result.error

    issues.push(
      issue(
        result.error,
        group.steps.map(({ index }) => index),
      ),
    )
  }

  if (issues.length)
    return {
      issues: issues.sort(
        (left, right) =>
          (left.sourceStepIndexes[0] ?? -1) - (right.sourceStepIndexes[0] ?? -1),
      ),
    }

  return { program: { atomicity: 'plan-atomic', actions, preconditions } }
}

/** Rejects implicit rowid-alias changes even when affinity comparison produces no steps. */
function rowidIssues(planned: PlannedMigration): MigrationCapabilityIssue[] {
  return planned.planningCatalog.tables.flatMap(({ identity }) => {
    const desired = planned.desiredTables.get(identity)

    if (!desired) return []

    const sourceStepIndexes = planned.plan.steps.flatMap((step, index) =>
      step.target.kind !== 'namespace' &&
      planned.identities.equals(step.target.relation, identity)
        ? [index]
        : [],
    )

    try {
      const expected = desiredDefinition(desired).columns.filter(
        (column) => column.rowidAlias,
      )

      const observed = observedDefinition(
        observedTable(planned, identity),
      ).columns.filter((column) => column.rowidAlias)

      if (
        expected.length !== observed.length ||
        expected.some((column, index) => !sameName(column.name, observed[index]!.name))
      )
        throw new SqliteMigrationCapabilityError(
          'compile_failure',
          'Unsupported SQLite rowid alias conversion',
        )

      return []
    } catch (cause) {
      if (!(cause instanceof SqliteMigrationCapabilityError)) throw cause

      return [issue(cause, sourceStepIndexes)]
    }
  })
}

/** Checks target shape and desired registration before compiling any physical actions. */
function stepIssues(
  planned: PlannedMigration,
  step: MigrationStep,
  index: number,
): MigrationCapabilityIssue[] {
  try {
    checkStep(step)

    if (step.kind === 'create_table' && !planned.desiredTables.has(step.target.relation))
      return [
        {
          code: 'missing_desired_table',
          message: 'SQLite CREATE TABLE lacks a registered desired table',
          sourceStepIndexes: [index],
        },
      ]

    return []
  } catch (cause) {
    if (!(cause instanceof SqliteMigrationCapabilityError)) throw cause

    return [issue(cause, [index])]
  }
}

/** Records an executing Semantic Profile mismatch without exposing a partial program. */
function profileIssues(
  planned: PlannedMigration,
  expected: MigrationSemanticProfile,
): MigrationCapabilityIssue[] {
  try {
    checkProfile(planned, expected)
    return []
  } catch (cause) {
    if (!(cause instanceof SqliteMigrationCapabilityError)) throw cause

    return [issue(cause, [])]
  }
}

/** Retains deterministic capability diagnostics and original semantic provenance. */
function issue(
  cause: SqliteMigrationCapabilityError,
  sourceStepIndexes: readonly number[],
): MigrationCapabilityIssue {
  return {
    code: cause.code,
    message: cause.message,
    sourceStepIndexes,
  }
}
