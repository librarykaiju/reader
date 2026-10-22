/* Migration 0014: book records, for the family library's Record page.
     * books.blurb (new column): the jacket copy, from the file's own
       description, Open Library or Google Books (or written by Claude when
       none of them has one)
     * books.pages (new column): the page count
     * books.appeal (new column): appeal terms as JSON,
       {"pacing": [...], "tone": [...], "style": [...], "characters": [...], "story": [...]}
     * books.record_from (new column): where each came from, as JSON,
       {"blurb": "file" | "openlibrary" | "google" | "ai" | "edited", "pages": ..., "appeal": ...}
     * books.record_at (new column): when the record was filled in; NULL =
       not yet (it's looked up the first time someone opens the book's record)

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute.

   Running it a second time stops with "duplicate column name: blurb" and
   changes nothing. */

ALTER TABLE books ADD COLUMN blurb TEXT;
ALTER TABLE books ADD COLUMN pages INTEGER;
ALTER TABLE books ADD COLUMN appeal TEXT;
ALTER TABLE books ADD COLUMN record_from TEXT;
ALTER TABLE books ADD COLUMN record_at INTEGER;
