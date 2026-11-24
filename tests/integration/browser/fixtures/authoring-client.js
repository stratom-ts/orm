import {
  getColumnMetadata,
  getReferenceMetadata,
  isTableHandle,
} from '@stratom/orm/schema'
import { parse } from 'valibot'

import { Related, Table, formSchema } from './shared-schema.js'

globalThis.result = {
  ...parse(formSchema, { name: 'Example' }),
  table: isTableHandle(Table),
  related: isTableHandle(Related),
  unique: getColumnMetadata(Related.getSchema().entries.id).unique,
  reference: getReferenceMetadata(Related.getSchema().entries.exampleId).target.column,
  lazyId: parse(Related.getSchema().entries.lazyId, 'parent'),
}
