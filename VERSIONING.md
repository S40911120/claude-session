# Versioning

@recensa/claude-session follows [Semantic Versioning](https://semver.org/). While the
package is pre-1.0, minor versions (0.x) may contain breaking changes; patch versions
do not.

## What a release is

One version = one git tag = one npm publish:

- `package.json` version, the git tag (`v<version>`), and the npm version always match.
- Every release has a [CHANGELOG](./CHANGELOG.md) entry.
- Publishing runs through CI on the tag push (`.github/workflows/npm-publish.yml`):
  the test suite must pass, and the tarball is published with npm provenance.

## Compatibility contracts

Two surfaces are versioned conservatively because other tools build on them:

- **Library ↔ CLI parity.** Every analysis export returns the same object shape as the
  CLI's `<command> --json` output. Changing an output shape is at least a minor bump.
- **Stable identifiers.** The internal stable-hash algorithm never changes; derived IDs
  stay valid across versions.

## Relation to Recensa

The [Recensa](https://github.com/S40911120/recensa) viewer depends on this package via
a caret range and pins an exact version in its lockfile. The version bundled in a given
Recensa Docker image is whatever its lockfile pinned at image build time — see
Recensa's own VERSIONING.md.
