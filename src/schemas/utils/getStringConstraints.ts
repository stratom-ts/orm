import type { StringConstraints } from '@/types/constraints'
import type { AnySchema, AnySchemaAsync } from '@/types/schema'

import { extractStorageFacts } from '../valibot/storageFacts'

/**
 * Reads min/max length constraints from a string schema pipe.
 *
 * @example
 *   const c = getStringConstraints(pipe(string(), maxLength(255)))
 *   // { maxLength: 255 }
 *
 * @param schema - String schema that may include length actions.
 *
 * @returns Extracted `minLength` and `maxLength` if present
 */
export function getStringConstraints(
  schema: AnySchema | AnySchemaAsync,
): StringConstraints {
  return extractStorageFacts(schema as AnySchema).stringConstraints
}
