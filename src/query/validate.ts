import type { BaseIssue, ObjectEntries, ObjectSchema } from 'valibot'
import { object, optional, safeParse } from 'valibot'

import { analyzeSchema, getColumnMetadata } from '@/schemas'
import type { TableHandle } from '@/types'
import type { AnySchema } from '@/types/schema'
import { ValidationError } from '@/utils/error'

/**
 * Checks whether the outermost schema wrapper permits omission.
 *
 * @param schema - Column schema to inspect.
 */
function isDirectlyOmitOptionalSchema(schema: AnySchema): boolean {
  return (
    schema.type === 'optional' ||
    schema.type === 'exact_optional' ||
    schema.type === 'nullish'
  )
}

/**
 * Checks whether an insert may omit a column.
 *
 * @param schema - Column schema to inspect.
 */
function isInsertOptional(schema: AnySchema): boolean {
  if (analyzeSchema(schema).omitOnInsert) return true

  const meta = getColumnMetadata(schema)

  if (!meta) return false

  const generation = meta.generation

  if (generation?.kind === 'identity' && generation.mode === 'byDefault') {
    return true
  }

  if (meta.databaseDefault !== undefined) return true

  return false
}

/** Rejects undefined values for columns whose schema requires an insert value. */
function assertDefinedInsertValue(
  tableName: string,
  columnName: string,
  value: unknown,
  schema: AnySchema | undefined,
): void {
  if (value !== undefined || schema === undefined) return
  if (isInsertOptional(schema)) return

  throw new ValidationError({
    message: `Invalid insert into "${tableName}": column "${columnName}" cannot be undefined`,
  })
}

/**
 * Checks whether the database always generates a column value.
 *
 * @param schema - Column schema to inspect.
 */
function isAlwaysGenerated(schema: AnySchema): boolean {
  const meta = getColumnMetadata(schema)
  const generation = meta?.generation
  return (
    (generation?.kind === 'identity' && generation.mode === 'always') ||
    generation?.kind === 'computed'
  )
}

/**
 * Builds a Valibot object schema matching {@link InferInsert} rules:
 * always-generated omitted; byDefault / default / optional / nullish optional;
 * bare nullable stays required (accepts null).
 *
 * @example
 *   const schema = buildInsertSchema(User)
 *   safeParse(schema, { name: 'Alice' })
 *
 * @param handle - Table handle to derive the insert schema from.
 *
 * @returns Valibot object schema for insert validation
 */
export function buildInsertSchema(
  handle: TableHandle,
): ObjectSchema<ObjectEntries, undefined> {
  const entries = handle.getSchema().entries as Record<string, AnySchema>
  const insertEntries: ObjectEntries = {}

  for (const [name, columnSchema] of Object.entries(entries)) {
    if (isAlwaysGenerated(columnSchema)) continue

    if (isInsertOptional(columnSchema)) {
      insertEntries[name] = isDirectlyOmitOptionalSchema(columnSchema)
        ? columnSchema
        : optional(columnSchema)
    } else {
      // bare nullable and required columns stay as-is (nullable accepts null)
      insertEntries[name] = columnSchema
    }
  }

  return object(insertEntries)
}

/**
 * Builds a Valibot object schema matching {@link InferUpdate} rules:
 * partial patch; omits readonly and always-generated columns.
 *
 * @example
 *   const schema = buildUpdateSchema(User)
 *   safeParse(schema, { name: 'Bob' })
 *
 * @param handle - Table handle to derive the update schema from.
 *
 * @returns Valibot object schema for update patch validation
 */
export function buildUpdateSchema(
  handle: TableHandle,
): ObjectSchema<ObjectEntries, undefined> {
  const entries = handle.getSchema().entries as Record<string, AnySchema>
  const updateEntries: ObjectEntries = {}

  for (const [name, columnSchema] of Object.entries(entries)) {
    if (isAlwaysGenerated(columnSchema)) continue

    const meta = getColumnMetadata(columnSchema)

    if (meta?.readonly) continue

    // All updatable fields are optional patches (including bare nullable)
    updateEntries[name] = isDirectlyOmitOptionalSchema(columnSchema)
      ? columnSchema
      : optional(columnSchema)
  }

  return object(updateEntries)
}

/**
 * Formats validation issues as a semicolon-delimited diagnostic.
 *
 * @param issues - Validation issues to format.
 */
function formatIssues(issues: readonly BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => {
      const path = issue.path?.map((item) => String(item.key)).join('.') ?? ''
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('; ')
}

/**
 * Validates a single insert row; throws {@link ValidationError} on failure.
 *
 * @example
 *   const cleaned = validateInsertRow(User, { name: 'Alice', email: 'a@b.com' })
 *
 * @param handle - Table handle for schema derivation.
 * @param row - Raw row object to validate.
 *
 * @returns Cleaned row with only insertable columns
 *
 * @throws ValidationError - When the row fails validation
 */
export function validateInsertRow(
  handle: TableHandle,
  row: unknown,
): Record<string, unknown> {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new ValidationError({
      message: `Invalid insert into "${handle.getTableMetadata().name}": expected a plain object row`,
    })
  }

  const entries = handle.getSchema().entries as Record<string, AnySchema>
  const schema = buildInsertSchema(handle)
  const allowed = new Set(Object.keys(schema.entries))

  for (const key of Object.keys(row as object)) {
    if (!allowed.has(key)) {
      throw new ValidationError({
        message: `Invalid insert into "${handle.getTableMetadata().name}": unknown or non-insertable column "${key}"`,
      })
    }

    assertDefinedInsertValue(
      handle.getTableMetadata().name,
      key,
      (row as Record<string, unknown>)[key],
      entries[key],
    )
  }

  const result = safeParse(schema, row)

  if (!result.success) {
    throw new ValidationError({
      message: `Invalid insert into "${handle.getTableMetadata().name}": ${formatIssues(result.issues)}`,
      issues: result.issues,
    })
  }

  // Keep only provided keys (optional/default omitted → SQL DEFAULT)
  const cleaned: Record<string, unknown> = {}

  for (const key of Object.keys(row as object)) {
    if (key in (result.output as object)) {
      cleaned[key] = (result.output as Record<string, unknown>)[key]
    }
  }

  // Include parsed defaults from optional schemas that produced values
  return includeParsedDefaults(result, cleaned)
}

/** Adds parsed schema defaults without replacing explicitly supplied insert values. */
function includeParsedDefaults(
  result: {
    readonly typed: true
    readonly success: true
    readonly output: { [x: string]: unknown; [x: number]: unknown }
    readonly issues: undefined
  },
  cleaned: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(result.output as object)) {
    if (value !== undefined && !(key in cleaned)) {
      cleaned[key] = value
    }
  }

  return cleaned
}

/**
 * Validates an update patch; throws {@link ValidationError} on failure.
 * Rejects empty patches and unknown keys via schema parse.
 *
 * @example
 *   const cleaned = validateUpdatePatch(User, { name: 'Bob' })
 *
 * @param handle - Table handle for schema derivation.
 * @param patch - Raw patch object to validate.
 *
 * @returns Cleaned patch with only updatable columns
 *
 * @throws ValidationError - When the patch fails validation
 */
export function validateUpdatePatch(
  handle: TableHandle,
  patch: unknown,
): Record<string, unknown> {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError({
      message: `Invalid update on "${handle.getTableMetadata().name}": expected a plain object patch`,
    })
  }

  const schema = buildUpdateSchema(handle)
  const result = safeParse(schema, patch)

  if (!result.success) {
    throw new ValidationError({
      message: `Invalid update on "${handle.getTableMetadata().name}": ${formatIssues(result.issues)}`,
      issues: result.issues,
    })
  }

  const output = result.output as Record<string, unknown>

  // Drop undefined keys so SET only includes provided fields
  const cleaned: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(output)) {
    if (value !== undefined) cleaned[key] = value
  }

  // Reject keys not in the update schema (Valibot object strips unknown by default)
  const allowed = new Set(Object.keys(schema.entries))

  for (const key of Object.keys(patch as object)) {
    if (!allowed.has(key)) {
      throw new ValidationError({
        message: `Invalid update on "${handle.getTableMetadata().name}": unknown or non-updatable column "${key}"`,
      })
    }
  }

  if (Object.keys(cleaned).length === 0) {
    throw new ValidationError({
      message: `Invalid update on "${handle.getTableMetadata().name}": patch must include at least one column`,
    })
  }

  return cleaned
}
