# Publishing

Releases go out through changesets and npm Trusted Publishing (OIDC), from `.github/workflows/release.yml`. **There is no `NPM_TOKEN` secret**: npm trusts this repository and that workflow file directly, and every publish is stamped with provenance.

## What is published

| package          | from                | command      |
| ---------------- | ------------------- | ------------ |
| `@missiv/common` | `packages/common`   |              |
| `@missiv/server` | `packages/server`   |              |
| `@missiv/client` | `packages/client`   |              |
| `@missiv/bun`    | `platforms/bun`     | `missiv-bun` |
| `missiv`         | `platforms/nodejs`  | `missiv`     |

`@missiv/cf-worker` is `private` (and changesets' `privatePackages.version` is off): it is a deployment, not a package, so it is never versioned or published. The list lives in `scripts/npm-names.txt` too, and `pnpm check:packaging` (part of the verify gate) checks every publishable package has the `repository`, `license` and `publishConfig.access` that provenance and scoped publishing need.

These names replaced `missiv-common`, `missiv-server`, `missiv-client`, `missiv-server-bun`, `missiv-server-nodejs` and `missiv-server-cf-worker` (from 0.4.0), which stop at their last version (0.3.x) and are deprecated.

## The normal flow

1. Add a changeset with the change: `pnpm changeset`.
2. Merge to `main`. The release workflow opens (or updates) a **"Version Packages"** PR that applies the pending changesets.
3. Merge that PR. The workflow runs `pnpm release:ci`: the verify gate (packaging check, format, build, tests), then `changeset publish`, which publishes in dependency order and skips versions already on npm.

When `main` already carries bumped, unpublished versions and no changesets, step 3 happens directly (Actions, `release`, Run workflow, if no push triggers it).

## The one-time bootstrap (per package name)

npm keeps the trusted-publisher setting on the package, so a name has to exist before it can hold one. `~/dev/tools/reserve-npm-name.mjs` does both steps for the whole list: it publishes an empty `0.0.0` placeholder for every name that does not exist yet, then runs `npm trust github <name> --file release.yml --repo wighawag/missiv --allow-publish` for every name (new ones, and existing ones you maintain such as `missiv`), skipping a package that already has a trusted publisher.

Requirements: npm `>= 11.15.0` for `npm trust`, 2FA on the npm account, and the `@missiv` org. The first `npm trust` call asks for 2FA in the browser; tick "skip 2FA for the next 5 minutes" there and the rest of the list goes through.

```bash
# dry run first: prints what it would reserve and trust, changes nothing
node ~/dev/tools/reserve-npm-name.mjs --names-file scripts/npm-names.txt --repo https://github.com/wighawag/missiv --trust-github wighawag/missiv --workflow release.yml

# then for real
node ~/dev/tools/reserve-npm-name.mjs --names-file scripts/npm-names.txt --repo https://github.com/wighawag/missiv --trust-github wighawag/missiv --workflow release.yml --publish
```

The placeholders carry `AGPL-3.0-only`, the script's default and missiv's license. A new trusted publisher is reported to need a real OIDC publish within about two days, so run the release workflow straight after (Actions, `release`, Run workflow). If it lapses: `npm trust list <name>`, `npm trust revoke <name> --id <id>`, then trust again.

The same setting by hand, per package on npmjs.com, Settings, Trusted publisher: GitHub Actions, user `wighawag`, repository `missiv`, workflow `release.yml`, environment empty. A package added later needs the same bootstrap.

## Checking a release

```bash
npm view @missiv/client version
npm view @missiv/client --json | jq .dist.attestations
npx missiv@latest --help
```

The attestations block is the provenance. If it is missing, the publish did not go through OIDC.
