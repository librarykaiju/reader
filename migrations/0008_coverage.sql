/* Migration 0008: saved coverage digests ("Compare coverage").
     * coverage (new table): one digest comparing how several feeds covered
       one story. item_ids is a JSON array of the articles it compared (the
       one it was asked from first), digest the JSON the page shows.

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste the
   line below into the D1 Console (dashboard, reader, Console) and Execute.
   The old Worker code keeps working with the new table there.

   Running it a second time changes nothing. */

CREATE TABLE IF NOT EXISTS coverage (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, item_ids TEXT NOT NULL, digest TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS coverage_by_item ON coverage (item_id);
