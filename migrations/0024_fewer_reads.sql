/* Migration 0024: fewer D1 row reads.
     * items_unread (new index): the unread items in date order. Unread and
       the feed list's unread counts read only these, not every item.
     * items_articles (new index): each feed's articles (not episodes or
       videos), for telling a show from a site in the feed list.
     * sync_state (new table): small values kept between runs; 'abs' is the
       fingerprint of Audiobookshelf's listing at the last finished sync, so
       the 30-minute sync stops early when nothing there changed.

   Run it when you can; the Worker works with or without it (without it, the
   lists read more rows and every sync does the whole thing). Paste the line
   below into the D1 Console (dashboard, reader, Console) and Execute.

   Running it a second time changes nothing. */

CREATE INDEX IF NOT EXISTS items_unread ON items (COALESCE(published_at, created_at) DESC, id DESC) WHERE read = 0; CREATE INDEX IF NOT EXISTS items_articles ON items (feed_id) WHERE media_url IS NULL; CREATE TABLE IF NOT EXISTS sync_state (k TEXT PRIMARY KEY, v TEXT);
