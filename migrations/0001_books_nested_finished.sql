/* Migration 0001: nested book folders + the Finished badge.
   Upgrades a “reader” database made from the first schema.sql in place:
     * books.finished_at (new column)
     * folders.parent_id (book folders nest), and folder names only need to be
       unique among siblings: the table-level UNIQUE (kind, name) becomes a
       unique index on (kind, COALESCE(parent_id, 0), name). SQLite can’t drop
       a table constraint, so the folders table is rebuilt (same ids).

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste this
   whole file into the D1 Console (dashboard, reader, Console) and Execute.
   The wrangler command for a terminal is in the Reader Setup guide.
   The old Worker code keeps working on the upgraded
   tables, so there’s no rush between the two steps.

   Running it a second time stops at the first statement (“duplicate column
   name: finished_at”) before changing anything.

   D1 enforces foreign keys, and dropping the old folders table nulls out
   every feeds/books folder_id (their ON DELETE SET NULL fires as the rows go,
   deferred or not). So the assignments are copied aside first and put back
   after; foreign-key checks are deferred to the end of the transaction, when
   every folder_id points at a folder again. It gives the same result when a
   console runs the statements one by one. */

PRAGMA defer_foreign_keys = true;

ALTER TABLE books ADD COLUMN finished_at INTEGER;

CREATE TABLE folders_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('feeds', 'books')),
	parent_id INTEGER REFERENCES folders (id),
	position INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);

INSERT INTO folders_new (id, name, kind, parent_id, position, created_at)
SELECT id, name, kind, NULL, position, created_at FROM folders;

CREATE TABLE migration_0001_links AS
SELECT 'feeds' AS tbl, id, folder_id FROM feeds WHERE folder_id IS NOT NULL
UNION ALL
SELECT 'books' AS tbl, id, folder_id FROM books WHERE folder_id IS NOT NULL;

DROP TABLE folders;

ALTER TABLE folders_new RENAME TO folders;

UPDATE feeds SET folder_id = (SELECT l.folder_id FROM migration_0001_links l WHERE l.tbl = 'feeds' AND l.id = feeds.id)
WHERE id IN (SELECT id FROM migration_0001_links WHERE tbl = 'feeds');

UPDATE books SET folder_id = (SELECT l.folder_id FROM migration_0001_links l WHERE l.tbl = 'books' AND l.id = books.id)
WHERE id IN (SELECT id FROM migration_0001_links WHERE tbl = 'books');

DROP TABLE migration_0001_links;

CREATE UNIQUE INDEX IF NOT EXISTS folders_unique_name ON folders (kind, COALESCE(parent_id, 0), name);
