/* Migration 0021: genre tags taken off in Reader stay off.
     * book_tag_drops (new table): a tag taken off a book in Reader. The
       Audiobookshelf sync doesn't put a tag back on a book that has it
       here, whatever ABS's genres say. Adding the tag again in Reader puts
       it back as usual.

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute.

   Running it a second time changes nothing. */

CREATE TABLE IF NOT EXISTS book_tag_drops (
	book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
	tag_id INTEGER NOT NULL REFERENCES book_tags (id) ON DELETE CASCADE,
	PRIMARY KEY (book_id, tag_id)
);
