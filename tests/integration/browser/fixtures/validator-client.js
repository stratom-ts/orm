import { parse } from 'valibot'

import { formSchema } from './shared-schema.js'

globalThis.result = parse(formSchema, { name: 'Example' })
