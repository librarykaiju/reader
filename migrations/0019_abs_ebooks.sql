/* Migration 0019: ebooks from Audiobookshelf, in both libraries.
     * books.abs_ebook (new column): the Audiobookshelf item whose ebook
       (EPUB, PDF or CBZ) this row is; NULL for every other book. Its r2_key
       is "absbook/<item id>/<file ino>/<mtime>", and reading it goes to
       Audiobookshelf instead of R2 (see "Audiobooks" in src/index.js). An
       item with an audiobook and an ebook has a row for each.

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute.

   Running it a second time stops with "duplicate column name: abs_ebook" and
   changes nothing. */

ALTER TABLE books ADD COLUMN abs_ebook TEXT;
CREATE UNIQUE INDEX books_abs_ebook ON books (abs_ebook) WHERE abs_ebook IS NOT NULL;
