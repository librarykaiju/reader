/* Migration 0023: the family library's shelf (places and reading lists).
     * family_places (new table): where a family member is in a book they
       read online or listen to, so their shelf can take them back to it from
       any device. kind is 'read' or 'listen'; place is what the page keeps on
       the device (read: "chapter:paragraph" or a page number; listen:
       seconds); pct is how far through, 0 to 1, when the page knows it.
     * family_lists and family_list_books (new tables): reading lists each
       family member makes for themselves.
     Removing a person, or a book, deletes theirs.

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute. The old Worker
   code keeps working with the new tables there.

   Running it a second time changes nothing. */

CREATE TABLE IF NOT EXISTS family_places (person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE, book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE, kind TEXT NOT NULL, place TEXT NOT NULL, pct REAL, updated_at INTEGER NOT NULL, PRIMARY KEY (person_id, book_id, kind)); CREATE INDEX IF NOT EXISTS family_places_recent ON family_places (person_id, updated_at DESC); CREATE TABLE IF NOT EXISTS family_lists (id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS family_lists_by_person ON family_lists (person_id, updated_at DESC); CREATE TABLE IF NOT EXISTS family_list_books (list_id INTEGER NOT NULL REFERENCES family_lists (id) ON DELETE CASCADE, book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE, added_at INTEGER NOT NULL, PRIMARY KEY (list_id, book_id));
