import { column, defineTable, reference } from '@stratom/orm/schema'
import { object, partial, pick, pipe, required, string } from 'valibot'

export const schema = object({ id: string(), name: string() })
export const formSchema = required(partial(pick(schema, ['name'])))
export const Table = defineTable('examples', schema, { primaryKey: 'id' })
export const Related = defineTable(
  'related',
  {
    id: pipe(string(), column({ unique: true })),
    exampleId: reference(Table, 'id'),
    lazyId: reference(string(), () => Table, 'id'),
  },
  { primaryKey: 'id' },
)
