import { analyzeSchema } from '@/schemas/utils/analyzeSchema'
import { SchemaError } from '@/utils/error'

import { mapPostgresParamValue, mapPostgresResultValue } from './mapping'
import { resolvePostgresQuery } from './queryAddressing'

function validatePostgresValueMapping(
  _dataType: string,
  context: import('../types').DialectValueMappingContext,
): void {
  if (!context.authoredSchema) return

  const target = analyzeSchema(context.schema)
  const authored = analyzeSchema(context.authoredSchema)

  if (authored.outputKind !== target.outputKind) {
    throw new SchemaError({
      message:
        'PostgreSQL reference transformations must preserve the resolved target output kind or provide explicit parameter and result mappings',
    })
  }
}

/** PostgreSQL query addressing and value mapping. */
export const postgresQuery = {
  validateValueMapping: validatePostgresValueMapping,
  resolve: resolvePostgresQuery,
  mapResultValue: mapPostgresResultValue,
  mapParamValue: mapPostgresParamValue,
}
