import type {
  ComparisonOp,
  DeleteAst,
  Dialect,
  InsertAst,
  JoinAst,
  OrderByAst,
  PredicateAst,
  QualifiedColumnAst,
  ReturningAst,
  SelectAst,
  SelectItemAst,
  SqlExprAst,
  UpdateAst,
} from '@/dialects'
import type { ColumnRef, Prettify, TableHandle } from '@/types'
import type {
  InferInsert,
  InferSelect,
  InferSelectAllSide,
  InferSelectedColumns,
  InferUpdate,
  MergeJoinStar,
  MergeSelection,
  NullableFields,
  RightJoinStarResult,
  TableNameOf,
} from '@/types/views'
import { QueryError } from '@/utils/error'

import type { Executor } from './executor'
import type { ExpressionBuilder } from './expressions'
import {
  and,
  cmp,
  columnName,
  columnSchema,
  columnTable,
  eb,
  toQualified,
} from './expressions'
import type { ValueMapper } from './mapping'

/** Result when a write runs without `returning`. */
export type WriteResult = {
  rowCount: number
}

export type CompiledQuery = { sql: string; params: unknown[] }

type WhereInput =
  | PredicateAst
  | Record<string, unknown>
  | [column: ColumnRef | string, op: ComparisonOp, value: unknown]

type JoinOnInput = PredicateAst | ((builder: ExpressionBuilder) => PredicateAst)

/** Extract the JS type from a ColumnRef. Falls back to `unknown` for bare strings. */
type InferColumnValue<T> =
  T extends ColumnRef<string, string, infer TType> ? TType : unknown

function resolveOn(on: JoinOnInput): PredicateAst {
  return typeof on === 'function' ? on(eb) : on
}

function mapJoinsParams(
  handles: readonly TableHandle[],
  mapper: ValueMapper | undefined,
  joins: readonly JoinAst[] | undefined,
): readonly JoinAst[] | undefined {
  if (!joins || joins.length === 0) return joins
  return joins.map((join) => ({
    ...join,
    on: mapPredicateParams(handles, mapper, join.on)!,
  }))
}

function toJoinAst(type: JoinAst['type'], table: TableHandle, on: JoinOnInput): JoinAst {
  const info = table.getTableMetadata()
  return {
    type,
    table: info.name,
    ...(info.schema !== undefined ? { schema: info.schema } : {}),
    on: resolveOn(on),
  }
}

function isPredicateAst(value: unknown): value is PredicateAst {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind: string }).kind !== undefined &&
    ['cmp', 'and', 'or', 'not'].includes((value as { kind: string }).kind)
  )
}

function normalizeWhere(input: WhereInput): PredicateAst {
  if (Array.isArray(input)) {
    const [column, op, value] = input
    return cmp(column, op, value)
  }
  if (isPredicateAst(input)) {
    return input
  }
  const entries = Object.entries(input)
  if (entries.length === 0) {
    throw new QueryError({ message: 'where({}) requires at least one key' })
  }
  const preds = entries.map(([column, value]) => cmp(column, 'eq', value))
  return preds.length === 1 ? preds[0]! : and(...preds)
}

function mergeWhere(
  existing: PredicateAst | undefined,
  next: PredicateAst,
): PredicateAst {
  return existing ? and(existing, next) : next
}

function resolveReturningColumns(columns: readonly (ColumnRef | string)[]): string[] {
  return columns.map((c) => columnName(c))
}

type SelectSelectionInput =
  | readonly (ColumnRef | string)[]
  | ((
      builder: ExpressionBuilder,
    ) => readonly (
      | ColumnRef
      | string
      | { expr: SqlExprAst; alias: string }
      | SelectItemAst
    )[])

function selectionColumn(column: ColumnRef | string): SelectItemAst {
  const table = columnTable(column)
  const schema = columnSchema(column)
  return table
    ? {
        kind: 'column',
        column: columnName(column),
        table,
        ...(schema !== undefined ? { schema } : {}),
      }
    : { kind: 'column', column: columnName(column) }
}

function normalizeSelection(input: SelectSelectionInput): SelectItemAst[] {
  if (typeof input === 'function') {
    const items = input(eb)
    return items.map((item): SelectItemAst => {
      if (typeof item === 'string') {
        return { kind: 'column', column: item }
      }
      if (typeof item === 'object' && item !== null && 'kind' in item) {
        if (item.kind === 'all' || item.kind === 'column' || item.kind === 'expr') {
          return item as SelectItemAst
        }
      }
      if (
        typeof item === 'object' &&
        item !== null &&
        'expr' in item &&
        'alias' in item
      ) {
        return {
          kind: 'expr',
          expr: (item as { expr: SqlExprAst }).expr,
          alias: (item as { alias: string }).alias,
        }
      }
      return selectionColumn(item as ColumnRef)
    })
  }
  return input.map((c) => selectionColumn(c))
}

function mapWriteParams(
  handle: TableHandle,
  mapper: ValueMapper | undefined,
  columns: readonly string[],
  values: readonly (readonly unknown[])[],
): readonly (readonly unknown[])[] {
  if (!mapper) return values
  return values.map((row) =>
    row.map((value, i) => {
      const col = columns[i]!
      return mapper.mapParam(handle, col, value)
    }),
  )
}

function mapSetParams(
  handle: TableHandle,
  mapper: ValueMapper | undefined,
  set: readonly { readonly column: string; readonly value: unknown }[],
): readonly { readonly column: string; readonly value: unknown }[] {
  if (!mapper) return set
  return set.map((item) => ({
    column: item.column,
    value: mapper.mapParam(handle, item.column, item.value),
  }))
}

function mapPredicateParams(
  handles: readonly TableHandle[],
  mapper: ValueMapper | undefined,
  pred: PredicateAst | undefined,
): PredicateAst | undefined {
  if (!pred || !mapper) return pred
  switch (pred.kind) {
    case 'cmp': {
      // Column-vs-column join/on predicates have no bound params.
      if (pred.right || pred.value === null) return pred
      const handle = findHandle(handles, pred.table, pred.schema) ?? handles[0]!
      return {
        ...pred,
        value: mapper.mapParam(handle, pred.column, pred.value),
      }
    }
    case 'and':
      return {
        kind: 'and',
        preds: pred.preds.map((p) => mapPredicateParams(handles, mapper, p)!),
      }
    case 'or':
      return {
        kind: 'or',
        preds: pred.preds.map((p) => mapPredicateParams(handles, mapper, p)!),
      }
    case 'not':
      return {
        kind: 'not',
        pred: mapPredicateParams(handles, mapper, pred.pred)!,
      }
    default: {
      const _exhaustive: never = pred
      return _exhaustive
    }
  }
}

function findHandle(
  handles: readonly TableHandle[],
  table: string | undefined,
  schema: string | undefined,
): TableHandle | undefined {
  if (!table) return handles[0]
  const effectiveSchema = schema ?? 'public'
  return handles.find((handle) => {
    const metadata = handle.getTableMetadata()
    return metadata.name === table && (metadata.schema ?? 'public') === effectiveSchema
  })
}

type ResultColumn = { handle: TableHandle; column: string }

function resultColumnsForSelection(
  handles: readonly TableHandle[],
  selection: readonly SelectItemAst[],
): Map<string, ResultColumn> {
  const columns = new Map<string, ResultColumn>()
  const outputNames = new Set<string>()

  const add = (outputName: string, mapping?: ResultColumn) => {
    if (outputNames.has(outputName)) {
      throw new QueryError({
        message: `select output column "${outputName}" is ambiguous; alias one of the selected columns`,
      })
    }
    outputNames.add(outputName)
    if (mapping) columns.set(outputName, mapping)
  }

  const addAll = (handle: TableHandle) => {
    for (const column of Object.keys(handle.getSchema().entries)) {
      add(column, { handle, column })
    }
  }

  for (const item of selection) {
    if (item.kind === 'all') {
      if (!item.table) {
        for (const handle of handles) addAll(handle)
      } else {
        const handle = findHandle(handles, item.table, item.schema)
        if (!handle) {
          throw new QueryError({
            message: `selected table "${item.table}" is not joined`,
          })
        }
        addAll(handle)
      }
    } else if (item.kind === 'column') {
      const handle = findHandle(handles, item.table, item.schema)
      add(item.alias ?? item.column, handle ? { handle, column: item.column } : undefined)
    } else {
      const expression = item.expr
      const handle =
        expression.kind === 'column'
          ? findHandle(handles, expression.table, expression.schema)
          : undefined
      add(
        item.alias,
        handle && expression.kind === 'column'
          ? { handle, column: expression.column }
          : undefined,
      )
    }
  }
  return columns
}

function mapSelectedRows(
  mapper: ValueMapper,
  rows: unknown[],
  columns: ReadonlyMap<string, ResultColumn>,
): unknown[] {
  return rows.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
    const output: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      const mapping = columns.get(key)
      output[key] = mapping
        ? mapper.mapResultValue(mapping.handle, mapping.column, value)
        : value
    }
    return output
  })
}

async function runQuery<T>(
  dialect: Dialect,
  executor: Executor,
  handle: TableHandle,
  mapper: ValueMapper | undefined,
  resultColumns: ReadonlyMap<string, ResultColumn>,
  ast: SelectAst | InsertAst | UpdateAst | DeleteAst,
): Promise<T> {
  const compiled = dialect.compile(ast)
  try {
    const rows = await executor.execute(compiled)
    if (mapper && ast.kind === 'select') {
      return mapSelectedRows(mapper, rows, resultColumns) as T
    }
    if (mapper && 'returning' in ast && ast.returning) {
      return mapper.mapResultRows(handle, rows) as T
    }
    return rows as T
  } catch (cause) {
    if (cause instanceof QueryError) throw cause
    throw new QueryError({
      message: cause instanceof Error ? cause.message : 'Query execution failed',
      cause,
    })
  }
}

async function runWrite(
  dialect: Dialect,
  executor: Executor,
  handle: TableHandle,
  mapper: ValueMapper | undefined,
  ast: InsertAst | UpdateAst | DeleteAst,
): Promise<unknown[] | WriteResult> {
  const compiled = dialect.compile(ast)
  try {
    if (ast.returning) {
      const rows = await executor.execute(compiled)
      return mapper ? mapper.mapResultRows(handle, rows) : rows
    }
    await executor.run(compiled)
    // db0 does not expose affected-row counts portably
    return { rowCount: 0 }
  } catch (cause) {
    if (cause instanceof QueryError) throw cause
    throw new QueryError({
      message: cause instanceof Error ? cause.message : 'Query execution failed',
      cause,
    })
  }
}

function takeFirstOrThrow<T>(rows: T[], message: string): T {
  const row = rows[0]
  if (row === undefined) {
    throw new QueryError({ message })
  }
  return row
}

// ---------------------------------------------------------------------------
// Insert builder
// ---------------------------------------------------------------------------

export type InsertBuilder<
  THandle extends TableHandle = TableHandle,
  TResult = WriteResult,
> = {
  returningAll(): InsertBuilder<THandle, InferSelect<THandle>>
  returning<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): InsertBuilder<THandle, InferSelectedColumns<THandle, TCols>>
  compile(): CompiledQuery
  execute(): Promise<TResult extends WriteResult ? WriteResult : TResult[]>
  executeTakeFirst(): Promise<
    TResult extends WriteResult ? WriteResult : TResult | undefined
  >
  executeTakeFirstOrThrow(): Promise<TResult extends WriteResult ? WriteResult : TResult>
}

export function createInsertBuilder<THandle extends TableHandle>(options: {
  handle: THandle
  dialect: Dialect
  executor: Executor
  mapper?: ValueMapper
  rows: Record<string, unknown>[]
  returning?: ReturningAst
}): InsertBuilder<THandle, unknown> {
  const { handle, dialect, executor, mapper, rows, returning } = options

  const buildAst = (): InsertAst => {
    // Union of keys across rows (stable order: first row keys, then extras)
    const columnSet: string[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key)
          columnSet.push(key)
        }
      }
    }
    const info = handle.getTableMetadata()
    if (columnSet.length === 0) {
      throw new QueryError({
        message: `insert into "${info.name}" requires at least one column`,
      })
    }

    // Missing keys become undefined → dialect emits DEFAULT (not NULL).
    const rawValues = rows.map((row) =>
      columnSet.map((col) => (Object.hasOwn(row, col) ? row[col] : undefined)),
    )
    const values = mapWriteParams(handle, mapper, columnSet, rawValues)

    return {
      kind: 'insert',
      table: info.name,
      ...(info.schema !== undefined ? { schema: info.schema } : {}),
      columns: columnSet,
      values,
      ...(returning ? { returning } : {}),
    }
  }

  const compile = () => dialect.compile(buildAst())

  const execute = async () => runWrite(dialect, executor, handle, mapper, buildAst())

  const executeTakeFirst = async () => {
    const result = await execute()
    if (returning) {
      return (result as unknown[])[0]
    }
    return result
  }

  const executeTakeFirstOrThrow = async () => {
    const result = await execute()
    if (returning) {
      return takeFirstOrThrow(result as unknown[], 'No rows returned from insert')
    }
    return result
  }

  return {
    returningAll() {
      return createInsertBuilder({
        handle,
        dialect,
        executor,
        mapper,
        rows,
        returning: { kind: 'all' },
      }) as never
    },
    returning(columns) {
      return createInsertBuilder({
        handle,
        dialect,
        executor,
        mapper,
        rows,
        returning: {
          kind: 'columns',
          columns: resolveReturningColumns(columns),
        },
      }) as never
    },
    compile,
    execute: execute as never,
    executeTakeFirst: executeTakeFirst as never,
    executeTakeFirstOrThrow: executeTakeFirstOrThrow as never,
  }
}

// ---------------------------------------------------------------------------
// Insert-values builder (db.insert(table).values(row))
// ---------------------------------------------------------------------------

export type InsertValuesBuilder<THandle extends TableHandle = TableHandle> = {
  values(
    row: InferInsert<THandle> | InferInsert<THandle>[],
  ): InsertBuilder<THandle, InferSelect<THandle>>
}

// ---------------------------------------------------------------------------
// Update builder
// ---------------------------------------------------------------------------

export type UpdateSetBuilder<THandle extends TableHandle = TableHandle> = {
  set(patch: InferUpdate<THandle>): UpdateBuilder<THandle, InferSelect<THandle>>
}

export type UpdateBuilder<
  THandle extends TableHandle = TableHandle,
  TResult = WriteResult,
> = {
  where<TCol extends ColumnRef | string>(
    column: TCol,
    op: ComparisonOp,
    value: InferColumnValue<TCol>,
  ): UpdateBuilder<THandle, TResult>
  where(
    predicate: Record<string, unknown> | PredicateAst,
  ): UpdateBuilder<THandle, TResult>
  /** Opt into full-table update (no where). */
  all(): UpdateBuilder<THandle, TResult>
  returningAll(): UpdateBuilder<THandle, InferSelect<THandle>>
  returning<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): UpdateBuilder<THandle, InferSelectedColumns<THandle, TCols>>
  compile(): CompiledQuery
  execute(): Promise<Prettify<TResult extends WriteResult ? WriteResult : TResult>[]>
  executeTakeFirst(): Promise<
    TResult extends WriteResult ? WriteResult : TResult | undefined
  >
  executeTakeFirstOrThrow(): Promise<TResult extends WriteResult ? WriteResult : TResult>
}

export function createUpdateBuilder<THandle extends TableHandle>(options: {
  handle: THandle
  dialect: Dialect
  executor: Executor
  mapper?: ValueMapper
  patch: Record<string, unknown>
  where?: PredicateAst
  allowAll: boolean
  returning?: ReturningAst
}): UpdateBuilder<THandle, unknown> {
  const { handle, dialect, executor, mapper, patch, where, allowAll, returning } = options

  const buildAst = (): UpdateAst => {
    const info = handle.getTableMetadata()
    if (!where && !allowAll) {
      throw new QueryError({
        message: `update on "${info.name}" requires where(...) or .all()`,
      })
    }
    const set = mapSetParams(
      handle,
      mapper,
      Object.entries(patch).map(([column, value]) => ({ column, value })),
    )
    return {
      kind: 'update',
      table: info.name,
      ...(info.schema !== undefined ? { schema: info.schema } : {}),
      set,
      ...(where ? { where: mapPredicateParams([handle], mapper, where) } : {}),
      allowAll,
      ...(returning ? { returning } : {}),
    }
  }

  const compile = () => dialect.compile(buildAst())

  const execute = async () => runWrite(dialect, executor, handle, mapper, buildAst())

  const executeTakeFirst = async () => {
    const result = await execute()
    if (returning) return (result as unknown[])[0]
    return result
  }

  const executeTakeFirstOrThrow = async () => {
    const result = await execute()
    if (returning) {
      return takeFirstOrThrow(result as unknown[], 'No rows returned from update')
    }
    return result
  }

  const withWhere = (input: WhereInput) =>
    createUpdateBuilder({
      handle,
      dialect,
      executor,
      mapper,
      patch,
      where: mergeWhere(where, normalizeWhere(input)),
      allowAll,
      returning,
    })

  return {
    where(...args: unknown[]) {
      if (args.length === 1) {
        return withWhere(args[0] as WhereInput) as never
      }
      return withWhere([
        args[0] as ColumnRef | string,
        args[1] as ComparisonOp,
        args[2],
      ]) as never
    },
    all() {
      return createUpdateBuilder({
        handle,
        dialect,
        executor,
        mapper,
        patch,
        where,
        allowAll: true,
        returning,
      }) as never
    },
    returningAll() {
      return createUpdateBuilder({
        handle,
        dialect,
        executor,
        mapper,
        patch,
        where,
        allowAll,
        returning: { kind: 'all' },
      }) as never
    },
    returning(columns) {
      return createUpdateBuilder({
        handle,
        dialect,
        executor,
        mapper,
        patch,
        where,
        allowAll,
        returning: {
          kind: 'columns',
          columns: resolveReturningColumns(columns),
        },
      }) as never
    },
    compile,
    execute: execute as never,
    executeTakeFirst: executeTakeFirst as never,
    executeTakeFirstOrThrow: executeTakeFirstOrThrow as never,
  }
}

// ---------------------------------------------------------------------------
// Delete builder
// ---------------------------------------------------------------------------

export type DeleteBuilder<
  THandle extends TableHandle = TableHandle,
  TResult = WriteResult,
> = {
  where<TCol extends ColumnRef | string>(
    column: TCol,
    op: ComparisonOp,
    value: InferColumnValue<TCol>,
  ): DeleteBuilder<THandle, TResult>
  where(
    predicate: Record<string, unknown> | PredicateAst,
  ): DeleteBuilder<THandle, TResult>
  /** Opt into full-table delete (no where). */
  all(): DeleteBuilder<THandle, TResult>
  returningAll(): DeleteBuilder<THandle, InferSelect<THandle>>
  returning<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): DeleteBuilder<THandle, InferSelectedColumns<THandle, TCols>>
  compile(): CompiledQuery
  execute(): Promise<TResult extends WriteResult ? WriteResult : TResult[]>
  executeTakeFirst(): Promise<
    TResult extends WriteResult ? WriteResult : TResult | undefined
  >
  executeTakeFirstOrThrow(): Promise<TResult extends WriteResult ? WriteResult : TResult>
}

export function createDeleteBuilder<THandle extends TableHandle>(options: {
  handle: THandle
  dialect: Dialect
  executor: Executor
  mapper?: ValueMapper
  where?: PredicateAst
  allowAll: boolean
  returning?: ReturningAst
}): DeleteBuilder<THandle, unknown> {
  const { handle, dialect, executor, mapper, where, allowAll, returning } = options

  const buildAst = (): DeleteAst => {
    const info = handle.getTableMetadata()
    if (!where && !allowAll) {
      throw new QueryError({
        message: `delete from "${info.name}" requires where(...) or .all()`,
      })
    }
    return {
      kind: 'delete',
      table: info.name,
      ...(info.schema !== undefined ? { schema: info.schema } : {}),
      ...(where ? { where: mapPredicateParams([handle], mapper, where) } : {}),
      allowAll,
      ...(returning ? { returning } : {}),
    }
  }

  const compile = () => dialect.compile(buildAst())

  const execute = async () => runWrite(dialect, executor, handle, mapper, buildAst())

  const executeTakeFirst = async () => {
    const result = await execute()
    if (returning) return (result as unknown[])[0]
    return result
  }

  const executeTakeFirstOrThrow = async () => {
    const result = await execute()
    if (returning) {
      return takeFirstOrThrow(result as unknown[], 'No rows returned from delete')
    }
    return result
  }

  const withWhere = (input: WhereInput) =>
    createDeleteBuilder({
      handle,
      dialect,
      executor,
      mapper,
      where: mergeWhere(where, normalizeWhere(input)),
      allowAll,
      returning,
    })

  return {
    where(...args: unknown[]) {
      if (args.length === 1) {
        return withWhere(args[0] as WhereInput) as never
      }
      return withWhere([
        args[0] as ColumnRef | string,
        args[1] as ComparisonOp,
        args[2],
      ]) as never
    },
    all() {
      return createDeleteBuilder({
        handle,
        dialect,
        executor,
        mapper,
        where,
        allowAll: true,
        returning,
      }) as never
    },
    returningAll() {
      return createDeleteBuilder({
        handle,
        dialect,
        executor,
        mapper,
        where,
        allowAll,
        returning: { kind: 'all' },
      }) as never
    },
    returning(columns) {
      return createDeleteBuilder({
        handle,
        dialect,
        executor,
        mapper,
        where,
        allowAll,
        returning: {
          kind: 'columns',
          columns: resolveReturningColumns(columns),
        },
      }) as never
    },
    compile,
    execute: execute as never,
    executeTakeFirst: executeTakeFirst as never,
    executeTakeFirstOrThrow: executeTakeFirstOrThrow as never,
  }
}

// ---------------------------------------------------------------------------
// Select builder
// ---------------------------------------------------------------------------

export type SelectBuilder<
  THandle extends TableHandle = TableHandle,
  TResult = InferSelect<THandle>,
  HasSelection extends boolean = false,
  /** Table names whose selected columns are outer-join nullable. */
  TNullable extends string = never,
> = {
  selectAll(): SelectBuilder<
    THandle,
    MergeSelection<HasSelection, TResult, InferSelectAllSide<THandle, TNullable>>,
    true,
    TNullable
  >
  selectAll<TSide extends TableHandle>(
    handle: TSide,
  ): SelectBuilder<
    THandle,
    MergeSelection<HasSelection, TResult, InferSelectAllSide<TSide, TNullable>>,
    true,
    TNullable
  >
  select<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): SelectBuilder<
    THandle,
    MergeSelection<
      HasSelection,
      TResult,
      InferSelectedColumns<THandle, TCols, TNullable>
    >,
    true,
    TNullable
  >
  select(
    callback: (
      builder: ExpressionBuilder,
    ) => readonly (
      | ColumnRef
      | string
      | { expr: SqlExprAst; alias: string }
      | SelectItemAst
    )[],
  ): SelectBuilder<THandle, Record<string, unknown>, true, TNullable>
  where<TCol extends ColumnRef | string>(
    column: TCol,
    op: ComparisonOp,
    value: InferColumnValue<TCol>,
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  where(
    predicate:
      | Record<string, unknown>
      | PredicateAst
      | ((builder: ExpressionBuilder) => PredicateAst),
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  orderBy(
    column: ColumnRef | string,
    direction?: 'asc' | 'desc',
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  limit(count: number): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  offset(count: number): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  groupBy(
    columns: readonly (ColumnRef | string)[] | ColumnRef | string,
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  having(
    predicate: PredicateAst | ((builder: ExpressionBuilder) => PredicateAst),
  ): SelectBuilder<THandle, TResult, HasSelection, TNullable>
  innerJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    MergeJoinStar<HasSelection, TResult, InferSelect<TSide>>,
    HasSelection,
    TNullable
  >
  leftJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    MergeJoinStar<HasSelection, TResult, NullableFields<InferSelect<TSide>>>,
    HasSelection,
    TNullable | TableNameOf<TSide>
  >
  rightJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    HasSelection extends true ? TResult : RightJoinStarResult<THandle, TResult, TSide>,
    HasSelection,
    TNullable | TableNameOf<THandle>
  >
  compile(): CompiledQuery
  execute(): Promise<Prettify<TResult>[]>
  executeTakeFirst(): Promise<TResult | undefined>
  executeTakeFirstOrThrow(): Promise<TResult>
}

type SelectState = {
  selection: SelectItemAst[]
  joins: JoinAst[]
  joinedHandles: TableHandle[]
  where?: PredicateAst
  orderBy: OrderByAst[]
  limit?: number
  offset?: number
  groupBy: QualifiedColumnAst[]
  having?: PredicateAst
}

function createSelectBuilder<THandle extends TableHandle>(options: {
  handle: THandle
  dialect: Dialect
  executor: Executor
  mapper?: ValueMapper
  state: SelectState
}): SelectBuilder<THandle, unknown> {
  const { handle, dialect, executor, mapper, state } = options

  const buildAst = (): SelectAst => {
    const info = handle.getTableMetadata()
    const handles = [handle, ...state.joinedHandles]
    const selection =
      state.selection.length === 0 ? [{ kind: 'all' } as const] : state.selection
    resultColumnsForSelection(handles, selection)
    return {
      kind: 'select',
      table: info.name,
      ...(info.schema !== undefined ? { schema: info.schema } : {}),
      selection,
      ...(state.joins.length > 0
        ? { joins: mapJoinsParams(handles, mapper, state.joins) }
        : {}),
      ...(state.where ? { where: mapPredicateParams(handles, mapper, state.where) } : {}),
      ...(state.orderBy.length > 0 ? { orderBy: state.orderBy } : {}),
      ...(state.limit !== undefined ? { limit: state.limit } : {}),
      ...(state.offset !== undefined ? { offset: state.offset } : {}),
      ...(state.groupBy.length > 0 ? { groupBy: state.groupBy } : {}),
      ...(state.having
        ? { having: mapPredicateParams(handles, mapper, state.having) }
        : {}),
    }
  }

  const next = (patch: Partial<SelectState>) =>
    createSelectBuilder({
      handle,
      dialect,
      executor,
      mapper,
      state: {
        selection: patch.selection ?? state.selection,
        joins: patch.joins ?? state.joins,
        joinedHandles: patch.joinedHandles ?? state.joinedHandles,
        where: 'where' in patch ? patch.where : state.where,
        orderBy: patch.orderBy ?? state.orderBy,
        limit: 'limit' in patch ? patch.limit : state.limit,
        offset: 'offset' in patch ? patch.offset : state.offset,
        groupBy: patch.groupBy ?? state.groupBy,
        having: 'having' in patch ? patch.having : state.having,
      },
    })

  const compile = () => dialect.compile(buildAst())

  const execute = async () => {
    const ast = buildAst()
    const resultColumns = resultColumnsForSelection(
      [handle, ...state.joinedHandles],
      ast.selection,
    )
    return runQuery(dialect, executor, handle, mapper, resultColumns, ast)
  }

  const executeTakeFirst = async () => {
    const rows = (await execute()) as unknown[]
    return rows[0]
  }

  const executeTakeFirstOrThrow = async () => {
    const rows = (await execute()) as unknown[]
    return takeFirstOrThrow(rows, 'No rows returned from select')
  }

  return {
    selectAll(side?: TableHandle) {
      const metadata = side?.getTableMetadata()
      const item: SelectItemAst = metadata
        ? {
            kind: 'all',
            table: metadata.name,
            schema: metadata.schema ?? 'public',
          }
        : { kind: 'all' }
      return next({ selection: [...state.selection, item] }) as never
    },
    select(input: SelectSelectionInput) {
      return next({
        selection: [...state.selection, ...normalizeSelection(input)],
      }) as never
    },
    where(...args: unknown[]) {
      let pred: PredicateAst
      if (args.length === 1) {
        const arg = args[0]
        if (typeof arg === 'function') {
          pred = (arg as (builder: ExpressionBuilder) => PredicateAst)(eb)
        } else {
          pred = normalizeWhere(arg as WhereInput)
        }
      } else {
        pred = normalizeWhere([
          args[0] as ColumnRef | string,
          args[1] as ComparisonOp,
          args[2],
        ])
      }
      return next({ where: mergeWhere(state.where, pred) }) as never
    },
    orderBy(column, direction: 'asc' | 'desc' = 'asc') {
      const q = toQualified(column)
      return next({
        orderBy: [
          ...state.orderBy,
          {
            column: q.column,
            ...(q.table !== undefined ? { table: q.table } : {}),
            ...(q.schema !== undefined ? { schema: q.schema } : {}),
            direction,
          },
        ],
      }) as never
    },
    limit(count) {
      return next({ limit: count }) as never
    },
    offset(count) {
      return next({ offset: count }) as never
    },
    groupBy(columns) {
      const list = Array.isArray(columns) ? columns : [columns]
      return next({
        groupBy: [
          ...state.groupBy,
          ...list.map((c) => toQualified(c as ColumnRef | string)),
        ],
      }) as never
    },
    having(input: PredicateAst | ((builder: ExpressionBuilder) => PredicateAst)) {
      const pred = typeof input === 'function' ? input(eb) : input
      return next({
        having: state.having ? and(state.having, pred) : pred,
      }) as never
    },
    innerJoin(table, on) {
      return next({
        joins: [...state.joins, toJoinAst('inner', table, on)],
        joinedHandles: [...state.joinedHandles, table],
      }) as never
    },
    leftJoin(table, on) {
      return next({
        joins: [...state.joins, toJoinAst('left', table, on)],
        joinedHandles: [...state.joinedHandles, table],
      }) as never
    },
    rightJoin(table, on) {
      return next({
        joins: [...state.joins, toJoinAst('right', table, on)],
        joinedHandles: [...state.joinedHandles, table],
      }) as never
    },
    compile,
    execute: execute as never,
    executeTakeFirst: executeTakeFirst as never,
    executeTakeFirstOrThrow: executeTakeFirstOrThrow as never,
  }
}

// ---------------------------------------------------------------------------
// Root table query builder
// ---------------------------------------------------------------------------

/**
 * Fluent query builder rooted on a registered table handle.
 * Default terminal path is `select *`; use insert/update/delete for writes.
 */
export type QueryBuilder<THandle extends TableHandle = TableHandle> = {
  /** Compile `select * from table` (default read path). */
  compile(): CompiledQuery
  /** Execute `select * from table`. */
  execute(): Promise<InferSelect<THandle>[]>
  executeTakeFirst(): Promise<InferSelect<THandle> | undefined>
  executeTakeFirstOrThrow(): Promise<InferSelect<THandle>>
  /** Explicit select-all (same as default execute path). */
  selectAll(): SelectBuilder<THandle, InferSelect<THandle>, true, never>
  selectAll<TSide extends TableHandle>(
    handle: TSide,
  ): SelectBuilder<THandle, InferSelect<TSide>, true, never>
  select<const TCols extends readonly (ColumnRef | string)[]>(
    columns: TCols,
  ): SelectBuilder<THandle, InferSelectedColumns<THandle, TCols>, true, never>
  select(
    callback: (
      builder: ExpressionBuilder,
    ) => readonly (
      | ColumnRef
      | string
      | { expr: SqlExprAst; alias: string }
      | SelectItemAst
    )[],
  ): SelectBuilder<THandle, Record<string, unknown>, true, never>
  innerJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<THandle, InferSelect<THandle> & InferSelect<TSide>, false, never>
  leftJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    InferSelect<THandle> & NullableFields<InferSelect<TSide>>,
    false,
    TableNameOf<TSide>
  >
  rightJoin<TSide extends TableHandle>(
    table: TSide,
    on: JoinOnInput,
  ): SelectBuilder<
    THandle,
    NullableFields<InferSelect<THandle>> & InferSelect<TSide>,
    false,
    TableNameOf<THandle>
  >
  where<TCol extends ColumnRef | string>(
    column: TCol,
    op: ComparisonOp,
    value: InferColumnValue<TCol>,
  ): SelectBuilder<THandle, InferSelect<THandle>, false, never>
  where(
    predicate:
      | Record<string, unknown>
      | PredicateAst
      | ((builder: ExpressionBuilder) => PredicateAst),
  ): SelectBuilder<THandle, InferSelect<THandle>, false, never>
  orderBy(
    column: ColumnRef | string,
    direction?: 'asc' | 'desc',
  ): SelectBuilder<THandle, InferSelect<THandle>, false, never>
  limit(count: number): SelectBuilder<THandle, InferSelect<THandle>, false, never>
  offset(count: number): SelectBuilder<THandle, InferSelect<THandle>, false, never>
  groupBy(
    columns: readonly (ColumnRef | string)[] | ColumnRef | string,
  ): SelectBuilder<THandle, InferSelect<THandle>, false, never>
  having(
    predicate: PredicateAst | ((builder: ExpressionBuilder) => PredicateAst),
  ): SelectBuilder<THandle, InferSelect<THandle>, false, never>
}

function emptySelectState(): SelectState {
  return {
    selection: [],
    joins: [],
    joinedHandles: [],
    orderBy: [],
    groupBy: [],
  }
}

/** Creates a table-scoped query builder (select + insert/update/delete). */
export function createTableBuilder<THandle extends TableHandle>(options: {
  handle: THandle
  dialect: Dialect
  executor: Executor
  mapper?: ValueMapper
}): QueryBuilder<THandle> {
  const { handle, dialect, executor, mapper } = options

  const rootSelect = () =>
    createSelectBuilder({
      handle,
      dialect,
      executor,
      mapper,
      state: emptySelectState(),
    })

  // Default path: select * with no filters (terminals on QueryBuilder)
  const defaultSelect = createSelectBuilder({
    handle,
    dialect,
    executor,
    mapper,
    state: emptySelectState(),
  })

  return {
    compile: () => defaultSelect.compile(),
    execute: () => defaultSelect.execute() as Promise<InferSelect<THandle>[]>,
    executeTakeFirst: () =>
      defaultSelect.executeTakeFirst() as Promise<InferSelect<THandle> | undefined>,
    executeTakeFirstOrThrow: () =>
      defaultSelect.executeTakeFirstOrThrow() as Promise<InferSelect<THandle>>,
    selectAll(tableHandle?: TableHandle) {
      return rootSelect().selectAll(tableHandle as never) as never
    },
    select(input: SelectSelectionInput) {
      return rootSelect().select(input as never) as never
    },
    innerJoin(table, on) {
      return rootSelect().innerJoin(table, on) as never
    },
    leftJoin(table, on) {
      return rootSelect().leftJoin(table, on) as never
    },
    rightJoin(table, on) {
      return rootSelect().rightJoin(table, on) as never
    },
    where(...args: unknown[]) {
      return (rootSelect().where as (...a: unknown[]) => SelectBuilder)(...args) as never
    },
    orderBy(column, direction) {
      return rootSelect().orderBy(column, direction) as never
    },
    limit(count) {
      return rootSelect().limit(count) as never
    },
    offset(count) {
      return rootSelect().offset(count) as never
    },
    groupBy(columns) {
      return rootSelect().groupBy(columns) as never
    },
    having(input: PredicateAst | ((builder: ExpressionBuilder) => PredicateAst)) {
      return rootSelect().having(input as never) as never
    },
  }
}

/** @deprecated Use {@link createTableBuilder}. Kept for compatibility. */
export function createSelectAllBuilder<THandle extends TableHandle>(options: {
  handle: THandle
  dialect: Dialect
  executor: Executor
  mapper?: ValueMapper
}): QueryBuilder<THandle> {
  return createTableBuilder(options)
}
