# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments` with appropriate label and state filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repo from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a request surface

**PRs as a request surface: no.**

## Skill operations

When a skill says "publish to the issue tracker", create a GitHub issue.

When a skill says "fetch the relevant ticket", run `gh issue view <number> --comments`.

## Wayfinding operations

- **Map**: Create one issue labelled `wayfinder:map` that holds Notes, Decisions-so-far, and Fog.
- **Child ticket**: Link child issues as GitHub sub-issues. If sub-issues are unavailable, add them to a task list in the map and include `Part of #<map>` in each child.
- **Blocking**: Use GitHub native issue dependencies. If dependencies are unavailable, include `Blocked by: #<n>` in the child body.
- **Frontier query**: Select the first open, unassigned child without open blockers in map order.
- **Claim**: Run `gh issue edit <n> --add-assignee @me` as the session's first write.
- **Resolve**: Comment with the answer, close the child, then add a context pointer to the map's Decisions-so-far.
