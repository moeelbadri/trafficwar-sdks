# Releasing

The Node.js and Python packages are versioned independently. Both begin at
`1.0.0`.

## npm

Package: `@trafficwar/node`

Trusted Publisher settings:

- Provider: GitHub Actions
- GitHub owner: `moeelbadri`
- Repository: `trafficwar-sdks`
- Workflow: `publish-node.yml`
- Environment: `npm`
- Allowed action: publish

Publish by creating a GitHub release whose tag is
`node-v<package-version>`, for example `node-v1.0.0`.

If npm requires an authenticated first publish before Trusted Publishing can
be configured, bootstrap it once:

1. Run the full Node checks and `npm pack --workspace @trafficwar/node`.
2. Sign in with `npm login --auth-type=web`.
3. Publish that exact tarball with
   `npm publish ./trafficwar-node-1.0.0.tgz --access public`.
4. Configure the trusted publisher above on the new package. The equivalent
   `npm trust github` command requires npm 11.15 or newer and account-level
   two-factor authentication.
5. Run `npm logout`, then set the package's publishing access to require 2FA
   and disallow traditional tokens.

Do not create or store a long-lived automation token. Trusted GitHub publishes
automatically include npm provenance for this public repository.

## PyPI

Package: `trafficwar`

Pending Trusted Publisher settings:

- PyPI project name: `trafficwar`
- GitHub owner: `moeelbadri`
- Repository: `trafficwar-sdks`
- Workflow: `publish-python.yml`
- Environment: `pypi`

Publish by creating a GitHub release whose tag is
`python-v<package-version>`, for example `python-v1.0.0`. The pending
publisher creates the PyPI project on its first successful upload.

## Checklist

1. Update `packages/node/package.json` or
   `packages/python/src/trafficwar/_version.py`, plus `CHANGELOG.md`.
2. Run all checks and build both distribution artifacts.
3. Inspect the npm tarball and Python wheel/sdist.
4. Commit and push the release changes.
5. Create the package-specific GitHub release tag.
6. Confirm the registry version, provenance, and installation smoke test.
