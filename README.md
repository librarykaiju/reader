# Reader

A private feed, newsletter, podcast, video and ebook reader that runs on one Cloudflare Worker, with a D1 database and a private R2 bucket. Live at https://reader.brandonj.ink. Every `/api/` request needs `READER_TOKEN`.

Moved here from `workers/reader/` in `librarykaiju/w3bz1n3`.

## Layout

- `src/index.js` — the whole app: page (inlined), API, feed fetching, email handler. No build step; it can be pasted into the Cloudflare dashboard editor.
- `wrangler.toml` — Worker config and the `DB` (D1) and `BOOKS` (R2) bindings.
- `schema.sql` — tables for a fresh database.
- `migrations/` — upgrades for an existing database. Run each new one once, before deploying the code that needs it.
- `extension/` — a tiny browser extension that opens the reader in every new tab.
- `docs/setup.md` — full setup, updating and usage guide.
- Fix-later list (bugs and feature requests): `content/_docs/Reader Fix Later.md` in librarykaiju/w3bz1n3, so it syncs to Obsidian.
- `docs/build-your-own.md` — notes for anyone building their own version.

## Deploy

```
npx wrangler d1 execute reader --remote --file migrations/<new migration>.sql   # only if there is one
npx wrangler deploy
```

For a first-time setup (database, bucket, token, custom domain, email routing) see `docs/setup.md`.
