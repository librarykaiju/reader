/* Migration 0010: the family library. Family members get their own sign-in
   and can browse and download books, nothing else.
     * people (new table): one row per family member. A person starts with an
       invite code (single use, 7 days) and trades it for their own token the
       first time they open the link. Only SHA-256 hashes of both are kept,
       so nothing here can be replayed as a sign-in. "New link" clears
       token_hash (their old devices are signed out) and sets a fresh invite.
     * downloads (new table): who downloaded which book, and when.

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute. The old Worker
   code keeps working with the new tables there.

   Running it a second time stops with "table people already exists" and
   changes nothing. */

CREATE TABLE people (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	token_hash TEXT UNIQUE,
	invite_hash TEXT UNIQUE,
	invite_expires_at INTEGER,
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER
);

CREATE TABLE downloads (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
	book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
	at INTEGER NOT NULL
);

CREATE INDEX downloads_by_person ON downloads (person_id, at DESC);
