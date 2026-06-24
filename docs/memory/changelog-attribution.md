---
name: changelog-attribution
description: "How to attribute CHANGELOG.md entries — credit the human committer by username, never Claude"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7f25c0a3-b71f-4828-b98a-f9466c18a312
---

In `CHANGELOG.md`, every version entry must record **who committed/pushed it**, by username only, as a line directly under the version heading:

```
## 1.18.4

_Committed by NekoSuneVR._
```

Rules:
- Use the **git committer username** — never the email address.
- **Never mention Claude / AI in the changelog.** Credit the human only.
- **Claude-only commit → `CacheNetworks`** (the upstream author). When Claude appears alongside a real user, use that user (a NekoSuneVR commit stays NekoSuneVR even with a Claude co-author trailer). Two distinct real humans on one commit → list **both** names (e.g. `NekoSuneVR & CacheNetworks`).
- Era split in this repo: **≥ 1.14.0 → NekoSuneVR** (fork era, desktop app onward); **≤ 1.13.9 → CacheNetworks** (upstream `cachenetworks`/Claude era, originally released at github.com/cachenetworks/CacheStream, 1.6.0–1.13.8). No commit in this history has two distinct humans, so no dual-name cases currently.

**Why:** the user wants to track which person shipped each release; the changelog is shown as the in-app updater's release notes.

**How to apply:** when adding a new `## <version>` block, add the `_Committed by <username>._` line under it. Get the name from `git config user.name`.

**Contributor summary:** `CHANGELOG.md` has a contributors line under the `# Changelog` header listing each person's mapped commit count. Refresh it on each release/version bump from `git shortlog -sn HEAD`, mapping cachenetworks / Claude / CacheNetworks → **CacheNetworks** and NekoSuneVR → **NekoSuneVR**. Write counts INCLUSIVE of the commit being made.

**In-repo memory copy:** this memory is mirrored into the repo at `docs/memory/` (MEMORY.md + each note + README) so others can read it. When a note changes, re-copy it there and commit. See [[changelog-attribution]] itself as the canonical source.
