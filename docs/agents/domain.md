# Domain Docs

How engineering skills consume this repository's domain documentation while exploring the codebase.

## Before exploring

- Read `CONTEXT.md` at the repository root.
- Read ADRs under `docs/adr/` that touch the area being changed.

If an ADR directory or relevant record does not exist, proceed silently. Domain-modeling creates terms and ADRs lazily when decisions resolve.

## Layout

This is a single-context repository:

```text
/
|-- CONTEXT.md
|-- docs/
|   `-- adr/
`-- src/
```

## Vocabulary

Use terms defined in `CONTEXT.md` when naming domain concepts in issues, architecture proposals, tests, and code. Avoid synonyms the glossary rejects.

If a required concept is absent, reconsider whether new language is necessary or update the glossary through domain-modeling when the term is resolved.

## ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding it.
