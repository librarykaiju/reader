/* Migration 0007: highlights and notes in .txt books.
     * highlights (new table): a stretch of a book's text, by character
       position (start_pos up to end_pos, into the text after any YAML
       header), the words themselves, and an optional note. Deleting the
       book deletes its highlights.

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste the
   line below into the D1 Console (dashboard, reader, Console) and Execute.
   The old Worker code keeps working with the new table there.

   Running it a second time changes nothing. */

CREATE TABLE IF NOT EXISTS highlights (id INTEGER PRIMARY KEY AUTOINCREMENT, book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE, start_pos INTEGER NOT NULL, end_pos INTEGER NOT NULL, text TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS highlights_by_book ON highlights (book_id, start_pos);
