# Schema ORM

Schema ORM describes a desired relational schema and reconciles it with an existing database catalog.

## Language

**Migration Plan**:
A stable, canonically ordered description of the schema changes required to make the database catalog match the desired schema. Its step kinds, targets, and order are part of its meaning; equivalent desired schemas and catalogs produce the same plan regardless of input order.
_Avoid_: Migration diff, dry-run output

**Migration Target**:
The structured namespace, relation, column, or index one Migration Plan step addresses, built from canonical relation identity. Targets are never dotted or schema-string encoded.
_Avoid_: Step target string, qualified name

**Semantic Profile**:
The resolved identity adapter, writable namespace context, and registration default one Migration Plan was built under. Plan equality is promised within one profile; lowering rejects a plan whose profile differs from the one the executing run resolves.
_Avoid_: Plan version, dialect config
