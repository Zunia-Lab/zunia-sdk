# Changesets

Every change that affects a published package needs a changeset:

```bash
pnpm changeset
```

Pick the packages, the bump (patch, minor, major) and write one line for the changelog. Commit the generated file with your change.

To release:

```bash
pnpm version-packages   # applies the changesets: versions and CHANGELOG.md files
git commit -am "Release vX.Y.Z."
git tag vX.Y.Z
git push origin main vX.Y.Z   # the release workflow publishes to npm
```

`sdk-core`, `sdk-web` and `sdk-react` share one version. `interchain` is versioned on its own. The release workflow refuses a tag that does not match the package versions.
