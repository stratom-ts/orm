# Schema ORM

Schema ORM describes a desired relational schema and reconciles it with an existing database catalog.

## Language

**Migration Plan**:
A stable, canonically ordered description of the schema changes required to make the database catalog match the desired schema. Its step kinds, targets, and order are part of its meaning; equivalent desired schemas and catalogs produce the same plan regardless of input order.
_Avoid_: Migration diff, dry-run output
