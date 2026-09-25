/* Migration 0004: podcasts.
     * items.media_url, items.media_type (new columns): an episode’s audio
       (or video) file, from the feed’s enclosure
     * items.media_pos, items.media_len (new columns): seconds listened and
       the episode’s length, so playback picks up where it stopped on any
       device (media_pos NULL = not started)
     * items_media (new index): the Podcasts tab’s newest-first list

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste this
   whole file into the D1 Console (dashboard, reader, Console) and Execute.
   The wrangler command for a terminal is in the Reader Setup guide.
   The old Worker code keeps working on the upgraded
   table.

   Running it a second time stops at the first statement (“duplicate column
   name: media_url”) before changing anything. */

ALTER TABLE items ADD COLUMN media_url TEXT;
ALTER TABLE items ADD COLUMN media_type TEXT;
ALTER TABLE items ADD COLUMN media_pos REAL;
ALTER TABLE items ADD COLUMN media_len REAL;

CREATE INDEX IF NOT EXISTS items_media ON items (COALESCE(published_at, created_at) DESC, id DESC) WHERE media_url IS NOT NULL;
