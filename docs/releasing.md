# Pre-alpha releases

The npm package is `@stratom/orm`. Source lives at
<https://github.com/stratom-ts/orm>.

The **Release** GitHub Actions workflow publishes `0.0.1-pre-alpha.N` versions
with the `pre-alpha` npm tag. It runs the full CI suite, builds the package,
publishes it to npm with provenance, and creates a GitHub prerelease with the
package archive attached. It uses the commit selected when the workflow starts.

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

Under allowed actions, enable direct publishing with `npm publish`.
New trusted publishers otherwise allow only staged publishing.

The action uses GitHub OIDC credentials. It needs no npm token in GitHub secrets.
Run the next release within npm's two-day activation window for a new trusted
publisher configuration.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[npm trust prerequisites](https://docs.npmjs.com/cli/commands/npm-trust/).

## Subsequent releases

1. Increment `package.json` to the next unused `0.0.1-pre-alpha.N` version.
2. Merge the change into `main`.
3. Open **Actions → Release → Run workflow** and select `main`.
4. Check the npm publication and GitHub prerelease after the workflow completes.

The action only runs releases from `main`. Failed CI checks prevent publication.
The action rejects versions outside the pre-alpha series and existing release tags.
Releases run one at a time.

If npm publication succeeds but GitHub release creation fails, create the GitHub
prerelease for the published version at the workflow's commit. npm versions cannot
be published again. Download the archive with `npm pack @stratom/orm@<version>`
if you need to attach it to that release.

Users install the release with `pnpm add @stratom/orm@pre-alpha`.
