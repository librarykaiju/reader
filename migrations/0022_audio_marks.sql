/* Migration 0022: bookmarks and clips in audiobooks.
     * audio_marks (new table): a place in an audiobook (t, seconds into the
       whole book) with an optional note. A clip also has end_t: it runs from
       t to end_t. Deleting the book deletes its marks.

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute. The old Worker
   code keeps working with the new table there.

   Running it a second time changes nothing. */

CREATE TABLE IF NOT EXISTS audio_marks (id INTEGER PRIMARY KEY AUTOINCREMENT, book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE, t REAL NOT NULL, end_t REAL, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS audio_marks_by_book ON audio_marks (book_id, t);
