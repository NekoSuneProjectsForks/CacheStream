# Project memory

Shared, in-repo copy of the project's working memory so anyone (not just the
original author's tooling) can read the running context, conventions, and
decisions behind this codebase.

- **[MEMORY.md](MEMORY.md)** — the index: one line per note.
- **[changelog-attribution.md](changelog-attribution.md)** — how `CHANGELOG.md`
  entries are credited (human committer by username; Claude → CacheNetworks).
- **[desktop-app-next-phase.md](desktop-app-next-phase.md)** — the Electron
  desktop app: architecture, what's done, and the open end-to-end test.

Each note carries a short frontmatter block (`name` / `description` / `type`)
and may link to others with `[[note-name]]`. These are point-in-time notes —
verify against the current code before relying on any file/line reference.

Kept in sync with the maintainer's working memory; updated as the project
moves.
