/* Migration 0017: audiobooks from Audiobookshelf, in the family library.
     * books.abs_id (new column): the Audiobookshelf item's id; NULL for every
       other book. An audiobook's row is type 'pdf' with a name ending
       .audiobook and r2_key "abs/<abs_id>" (see "Audiobooks" in src/index.js).
     * books.narrator, books.duration (new columns): from Audiobookshelf;
       duration in seconds
     * books.abs_updated (new column): when Audiobookshelf last changed it, so
       the sync only rewrites what changed
     * books.abs_media (new column): its files and chapters as JSON, fetched
       the first time it's played or downloaded
     * books.gone_at (new column): set when it's no longer in Audiobookshelf,
       which hides it from family; cleared if it comes back

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute.

   Running it a second time stops with "duplicate column name: abs_id" and
   changes nothing. */

ALTER TABLE books ADD COLUMN abs_id TEXT;
ALTER TABLE books ADD COLUMN narrator TEXT;
ALTER TABLE books ADD COLUMN duration INTEGER;
ALTER TABLE books ADD COLUMN abs_updated INTEGER;
ALTER TABLE books ADD COLUMN abs_media TEXT;
ALTER TABLE books ADD COLUMN gone_at INTEGER;
CREATE UNIQUE INDEX books_abs_id ON books (abs_id) WHERE abs_id IS NOT NULL;
