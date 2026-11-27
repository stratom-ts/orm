# Pre-alpha releases

The npm package is `@stratom/orm`. Source lives at
<https://github.com/stratom-ts/orm>.

The **Release** GitHub Actions workflow stages `0.0.1-pre-alpha.N` versions
with the `pre-alpha` npm tag. It runs the full CI suite, builds the package,
stages it on npm, and creates a draft GitHub prerelease with the
same package archive attached. It uses the commit selected when the workflow starts.
A maintainer approves the package on npm before publishing the GitHub prerelease.

## First release

npm requires the package to exist before you can configure its trusted publisher.
Publish the first version locally with an npm account that can publish to `@stratom`.

1. Run `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, and `pnpm test` with PostgreSQL available.
2. Run `npm pack`. The `prepack` script builds JavaScript and declarations.
3. Check the archive contents with `tar -tf <archive.tgz>`.
4. Run `npm login`.
5. Run `npm publish <archive.tgz> --access public --tag pre-alpha`.
6. Create a GitHub prerelease for the published commit with a `v<version>` tag and attach the archive.

## Configure trusted publishing

Merge `.github/workflows/release.yml` into `main`. Open the package settings on npm
and add a GitHub Actions trusted publisher with these values:

| Field                | Value         |
| -------------------- | ------------- |
| Organization or user | `stratom-ts`  |
| Repository           | `orm`         |
| Workflow filename    | `release.yml` |
| Environment          | Leave empty   |

Leave direct publishing with `npm publish` disabled under allowed actions.
Trusted publishers allow `npm stage publish` by default.

The action uses GitHub OIDC credentials and npm >=11.15.0 for staged publishing.
It needs no npm token in GitHub secrets. Provenance is generated automatically for
public source repositories. npm does not support provenance for private source
repositories, so the workflow does not request it explicitly.
Run the next release within npm's two-day activation window for a new trusted
publisher configuration.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[npm trust prerequisites](https://docs.npmjs.com/cli/commands/npm-trust/).

## Subsequent releases

1. Increment `package.json` to the next unused `0.0.1-pre-alpha.N` version.
2. Merge the change into `main`.
3. Open **Actions → Release → Run workflow** and select `main`.
4. After the workflow completes, open npm's **Staged Packages** tab.
5. Review the package version, `pre-alpha` dist-tag, publisher, and archive contents.
6. Approve the staged package with 2FA after npm's scan completes.
7. Confirm availability with `npm view @stratom/orm@<version> version`.
8. Open the draft GitHub prerelease and publish it, keeping the prerelease flag enabled.

Staging does not make the version available for installation. npm approval requires
an interactive maintainer session. CI does not approve the package or publish the
GitHub release. The workflow summary links back to these instructions.

The action only runs releases from `main`. Failed CI checks prevent staging.
The action rejects versions outside the pre-alpha series and existing release tags.
Releases run one at a time.

If staging succeeds but draft creation fails, recover the archive with
`npm stage download <stage-id>` using npm >=11.15.0 in a signed-in local terminal.
Create the draft at the workflow's commit and attach that archive. Continue with
npm approval and GitHub publication. Do not rerun the workflow to recover the draft.

If review finds a problem, reject the package on npm and delete the GitHub draft.
Fix the problem and use a new pre-alpha version for the next attempt.

If npm approval succeeds but GitHub publication fails, publish the existing draft.
npm versions cannot be published again.

Users install the release with `pnpm add @stratom/orm@pre-alpha`.

See [npm staged publishing](https://docs.npmjs.com/staged-publishing/) for review,
download, approval, and rejection instructions.
