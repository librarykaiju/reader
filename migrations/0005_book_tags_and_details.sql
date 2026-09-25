/* Migration 0005: tags for books, and book details from YAML headers.
     * book_tags (new table): book tag names, unique ignoring case; a
       separate set from the feed tags
     * book_tag_links (new table): which books carry which tags; a book can
       have any number
     * books.author, books.series, books.volume (new columns): filled from a
       .txt book’s YAML header when it’s uploaded
     * book folders become book tags: each folder becomes a tag of the same
       name on the books inside it, and inside its subfolders; then the
       folders are deleted (the folders table stays, empty). Folders with the
       same name, in different places, become one tag. No book is deleted.

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste this
   whole file into the D1 Console (dashboard, reader, Console) and Execute.
   The wrangler command for a terminal is in the Reader Setup guide.
   Until the new code is deployed, the old page shows every book as
   Unfiled.

   Running it a second time stops at the first statement (“table book_tags
   already exists”) before changing anything. */

CREATE TABLE book_tags (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	created_at INTEGER NOT NULL
);

CREATE TABLE book_tag_links (
	book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
	tag_id INTEGER NOT NULL REFERENCES book_tags (id) ON DELETE CASCADE,
	PRIMARY KEY (book_id, tag_id)
);

CREATE INDEX book_tag_links_by_tag ON book_tag_links (tag_id);

ALTER TABLE books ADD COLUMN author TEXT;

ALTER TABLE books ADD COLUMN series TEXT;

ALTER TABLE books ADD COLUMN volume TEXT;

INSERT OR IGNORE INTO book_tags (name, created_at)
SELECT name, created_at FROM folders WHERE kind = 'books' ORDER BY position, id;

WITH RECURSIVE chain (book_id, folder_id) AS (
	SELECT id, folder_id FROM books WHERE folder_id IS NOT NULL
	UNION
	SELECT c.book_id, f.parent_id FROM chain c JOIN folders f ON f.id = c.folder_id WHERE f.parent_id IS NOT NULL
)
INSERT OR IGNORE INTO book_tag_links (book_id, tag_id)
SELECT c.book_id, t.id FROM chain c
JOIN folders f ON f.id = c.folder_id
JOIN book_tags t ON t.name = f.name;

UPDATE books SET folder_id = NULL WHERE folder_id IS NOT NULL;

UPDATE folders SET parent_id = NULL WHERE kind = 'books' AND parent_id IS NOT NULL;

DELETE FROM folders WHERE kind = 'books';
