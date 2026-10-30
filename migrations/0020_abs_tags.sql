/* Migration 0020: genre tags that come from Audiobookshelf.
     * book_tag_links.abs (new column): 1 when the sync put the tag on the
       book from the ABS item's tags or genres, 0 for one added in Reader.
       The sync adds and takes off only abs = 1 tags, so a change in ABS
       reaches Reader and tags added in Reader stay.
     * Genre tags already on an ABS book are marked as from ABS: until now
       the sync was the only thing that put tags on them. Other tags (Hide
       from family, say) stay as Reader's.

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute.

   Running it a second time stops with "duplicate column name: abs" and
   changes nothing. */

ALTER TABLE book_tag_links ADD COLUMN abs INTEGER NOT NULL DEFAULT 0;
UPDATE book_tag_links SET abs = 1
WHERE book_id IN (SELECT id FROM books WHERE abs_id IS NOT NULL OR abs_ebook IS NOT NULL)
AND tag_id IN (SELECT id FROM book_tags WHERE name IN ('Urban Fantasy', 'Science Fiction', 'Fantasy', 'Horror', 'Mystery', 'Thriller', 'Romance', 'Historical Fiction', 'Literary Fiction', 'Young Adult', 'Children''s', 'Humor', 'Short Fiction', 'Poetry', 'Drama', 'Classics', 'Mythology & Folklore', 'Comics', 'Superheroes', 'History', 'Biography & Memoir', 'Philosophy', 'Religion', 'Science'));
