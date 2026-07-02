# Releasing thinking canvas (signed Mac app + auto-update)

The app is distributed as a notarized `.dmg` on GitHub Releases and updates
itself via `electron-updater`. People download once; every later version
installs silently in the background.

## One-time setup

You already have the Developer ID Application cert in your keychain
(`Tommy Joseph (5BJ8XQLS2F)`). You need three more credentials, set as env vars:

| Var | What it is | How to get it |
| --- | --- | --- |
| `APPLE_ID` | Your Apple ID email | the account that owns the dev cert |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization | appleid.apple.com → Sign-In & Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | `5BJ8XQLS2F` | (your team id, already known) |
| `GH_TOKEN` | GitHub token to upload the release | github.com → Settings → Developer settings → Fine-grained token with `Contents: read/write` on `interfacedreams/thinking-canvas` |

They live in the repo's `.env` (gitignored — never commit it):

```bash
APPLE_ID="you@example.com"
APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
APPLE_TEAM_ID="5BJ8XQLS2F"
GH_TOKEN="github_pat_..."
```

## Cutting a release

1. Bump the version in `package.json` (e.g. `0.1.0` → `0.1.1`), and commit.
   The version string is what `electron-updater` compares against, so it must
   increase.
2. Load the credentials and release:

   ```bash
   set -a && . ./.env && set +a
   npm run release:mac
   ```

   This pushes the `vX.Y.Z` tag, builds, signs, notarizes, and uploads the
   `.dmg`, `.zip`, and `latest-mac.yml` to a **live** GitHub Release — no
   manual publish step (`publish.releaseType: release` in electron-builder.yml).

   The tag push is required: GitHub refuses to create a *published* release
   for a tag that doesn't exist ("Published releases must have a valid tag"),
   which strands a partial release. `release:mac` runs `release:tag` first so
   this can't happen.

That's it. Anyone running an older build gets a "Version X is ready" prompt on
next launch (or within 4 hours if left open) and restarts into the new version.

## How people install it the first time

Send them the GitHub Releases page (or the direct `.dmg` link). They download
the `.dmg`, drag the app to Applications, and open it — no Gatekeeper warning,
because it's signed and notarized.

## Notes

- `mac.target` includes both `dmg` (download) and `zip` (auto-update feed).
  Both must ship every release — `npm run release:mac` handles that.
- Auto-update is a no-op in `npm run dev` (only runs in packaged builds).
- To test an update locally without publishing: release `0.1.1`, install the
  `0.1.0` dmg, launch it, and watch it pull `0.1.1`.
