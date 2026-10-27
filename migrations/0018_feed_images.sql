/* Migration 0018: feed artwork.
     * feeds.image_url (new column): the feed's artwork (a podcast's
       <itunes:image>), saved on each refresh and shown on the lock screen
       while an episode plays

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute. The old Worker
   code keeps working on the upgraded table.

   Running it a second time stops with "duplicate column name: image_url" and
   changes nothing. */

ALTER TABLE feeds ADD COLUMN image_url TEXT;
