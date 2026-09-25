/* Migration 0006: stories.
     * items.story_id (new column): items in one feed about the same story
       share the id of the first one, so the list shows the story once and
       counts it once (NULL = an item on its own)
     * items_story (new index): finding a story's items

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste this
   whole file into the D1 Console (dashboard, reader, Console) and Execute.
   The wrangler command for a terminal is in the Reader Setup guide.
   The old Worker code keeps working on the upgraded table.

   Nothing is grouped yet after running it. Each feed groups its last three
   days of items the next time it refreshes.

   Running it a second time stops at the first statement (“duplicate column
   name: story_id”) before changing anything. */

ALTER TABLE items ADD COLUMN story_id INTEGER;

CREATE INDEX IF NOT EXISTS items_story ON items (story_id) WHERE story_id IS NOT NULL;
