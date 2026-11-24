/* Migration 0025: fewer D1 row reads, part two.
     * items_feed_created (new index): each feed's items by when they were
       first seen. A refresh that adds something prunes the feed's old items
       and regroups its last three days of stories; with this they read only
       those rows, not all of the feed's.
     * books_opened (new index): books by when they were last opened, for the
       Continue reading card atop Unread, so it reads one book instead of all.

   Run it when you can; the Worker works with or without it. Paste the line
   below into the D1 Console (dashboard, reader, Console) and Execute.

   Running it a second time changes nothing. */

CREATE INDEX IF NOT EXISTS items_feed_created ON items (feed_id, created_at); CREATE INDEX IF NOT EXISTS books_opened ON books (last_opened_at DESC, id DESC) WHERE last_opened_at IS NOT NULL;
