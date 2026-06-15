# Horus release checklist

Use this checklist for every version release. The automated release script
(`scripts/release.sh`) runs most steps — this checklist is the human gate.

> **For v0.1 specifically**, run the product readiness gate first:
> [`docs/v0.1-readiness-gate.md`](./v0.1-readiness-gate.md)
> All blocking items there must be checked before proceeding with this checklist.

---

## Pre-release

- [ ] **v0.1 readiness gate passed** — all blocking items in `docs/v0.1-readiness-gate.md` checked
- [ ] Working tree is clean in both `horus` and `horus-landing` repos
- [ ] `gh auth status` exits 0 (GitHub CLI authenticated)
- [ ] `horus-landing` checked out at `../horus-landing` relative to this repo
- [ ] The version in `apps/horus/package.json` is the correct target version

**Version bump locations** (updated automatically by `scripts/release.sh`):

| File | Field |
|------|-------|
| `apps/horus/package.json` | `"version"` |
| `packages/core/src/version.ts` | `HORUS_VERSION` constant |
| `horus-landing/public/install.sh` | `HORUS_VERSION=` line |

---

## Build & validate

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter ./apps/horus build
```

Pre-release smoke (local build, no curl install):

```bash
./scripts/smoke-test.sh apps/horus/dist/index.cjs
```

Required smoke commands — verify each exits 0 and outputs expected content:

```bash
HORUS_BIN=apps/horus/dist/index.cjs
node $HORUS_BIN --version         # → horus <version>
node $HORUS_BIN --help            # lists investigate / setup / index / connect
node $HORUS_BIN setup --help      # exits 0
node $HORUS_BIN index --help      # exits 0
node $HORUS_BIN investigate --help # exits 0
```

---

## Release

Run the release script (handles version sync, commit, tag, push, GitHub Release):

```bash
./scripts/release.sh [version]
```

The script will:
1. Sync versions across all three files above
2. Run `pnpm typecheck` + `pnpm --filter ./apps/horus build`
3. Run `scripts/smoke-test.sh`
4. Commit + tag both repos and push to origin
5. Upload `horus-vX.Y.Z` + `horus-vX.Y.Z.sha256` to the GitHub Release
6. Verify the artifact URL is reachable (3 retries)

---

## Post-release smoke (curl-install path)

After the GitHub Release is live and `horus-landing` is pushed:

```bash
# Full curl-install acceptance check — requires a container or isolated env:
docker run --rm ubuntu:22.04 bash -c \
  'apt-get install -y -qq curl nodejs && curl -fsSL https://horus.sh/install.sh | bash && horus --version'

# Or use the acceptance script against an existing install:
./scripts/acceptance/release-smoke.sh

# To verify exact version after release (set HORUS_EXPECTED_VERSION):
HORUS_EXPECTED_VERSION="horus 0.1.0" ./scripts/acceptance/release-smoke.sh
```

Required commands that must pass post-install:

```bash
horus --version         # exits 0, output contains "horus", shows semver
horus --help            # exits 0, lists investigate / setup / index / connect
horus setup --help      # exits 0
horus index --help      # exits 0
horus investigate --help # exits 0
horus init --path /tmp  # exits 0, prints "Initialized Horus project"
horus doctor            # prints "Horus readiness check" header + CLI version
```

- [ ] `horus --version` contains the correct version string (not "Axon")
- [ ] `horus --help` usage line reads `Usage: horus`
- [ ] All seven smoke commands above exit 0
- [ ] Config loading: `horus doctor --config horus.config.js` does not crash with babel.cjs error (HOR-83 regression guard)
- [ ] `horus init` creates `.horus/config.json` in a clean temp directory (HOR-98)
- [ ] `horus doctor` (no config) prints readiness header and CLI version (HOR-98)

---

## Artifact checklist

- [ ] GitHub Release exists at `https://github.com/Mhmdhammoud/horus/releases/tag/vX.Y.Z`
- [ ] `horus-vX.Y.Z` artifact is downloadable
- [ ] `horus-vX.Y.Z.sha256` is present and matches the artifact
- [ ] `horus-landing/public/install.sh` points at the new version
- [ ] `curl -fsSL https://horus.sh/install.sh | bash` installs the new version

---

## Rollback

If the release is broken after publishing:

1. Remove the GitHub Release and tag:
   ```bash
   gh release delete vX.Y.Z --yes
   git push origin --delete vX.Y.Z
   git tag -d vX.Y.Z
   ```
2. Revert the version bump commits in both repos and force-push if needed.
3. Re-point `horus-landing/public/install.sh` to the previous working version.
4. Verify the previous version installs cleanly with the smoke commands above.

---

## Notes

- No npm or Homebrew distribution is live yet; do not reference them in release notes.
- The CLI is a self-contained Node.js executable (Node 22+ required at runtime).
- The optional source-intelligence backend (`axoniq` on PyPI) is installed separately by the installer.
