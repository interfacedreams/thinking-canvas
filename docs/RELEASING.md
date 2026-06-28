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

Put them in a local, gitignored file (e.g. `~/.thinking-canvas-release.env`)
and source it before releasing. Do **not** commit them.

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="5BJ8XQLS2F"
export GH_TOKEN="github_pat_..."
```

## Cutting a release

1. Bump the version in `package.json` (e.g. `0.1.0` → `0.1.1`). The version
   string is what `electron-updater` compares against, so it must increase.
2. Source your credentials, then run:

   ```bash
   source ~/.thinking-canvas-release.env
   npm run release:mac
   ```

   This builds, signs, notarizes, and uploads the `.dmg`, `.zip`, and
   `latest-mac.yml` to a GitHub Release (created as a **draft**).
3. Go to the repo's Releases page, review the draft, and **publish** it.

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
