/* Migration 0022: the ABS tidy-up's log.
     * abs_tidy (new table): one row for each Audiobookshelf item the hourly
       tidy-up has looked at, with what it changed there (JSON), shown on the
       Family page. An item with a row isn't looked at again.

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute.

   Running it a second time changes nothing. */

CREATE TABLE IF NOT EXISTS abs_tidy (
	item_id TEXT PRIMARY KEY,
	title TEXT,
	author TEXT,
	changes TEXT,
	at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS abs_tidy_by_at ON abs_tidy (at);
