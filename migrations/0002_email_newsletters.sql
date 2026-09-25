/* Migration 0002: newsletters by email.
     * feeds.email (new column): the sender’s address on a newsletter’s feed
     * email_blocked (new table): senders whose mail is dropped

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste this
   whole file into the D1 Console (dashboard, reader, Console) and Execute.
   The wrangler command for a terminal is in the Reader Setup guide.
   The old Worker code keeps working on the upgraded
   tables.

   Running it a second time stops at the first statement (“duplicate column
   name: email”) before changing anything. */

ALTER TABLE feeds ADD COLUMN email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS feeds_email ON feeds (email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_blocked (
	address TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL
);
