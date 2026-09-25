/* Migration 0003: feed folders become tags.
     * tags (new table): tag names, unique ignoring case
     * feed_tags (new table): which feeds carry which tags; a feed can have
       any number
     * every feed folder becomes a tag of the same name on the feeds it held,
       then the feed folders are deleted (feeds.folder_id is left NULL; book
       folders are untouched)

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste this
   whole file into the D1 Console (dashboard, reader, Console) and Execute.
   The wrangler command for a terminal is in the Reader Setup guide.
   Until the new code is deployed, the old page shows
   every feed as Unfiled; nothing else changes. It doesn’t depend on 0002, so
   the two can run in either order.

   Running it a second time stops at the first statement (“table tags already
   exists”) before changing anything. */

CREATE TABLE tags (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	created_at INTEGER NOT NULL
);

CREATE TABLE feed_tags (
	feed_id INTEGER NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
	tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
	PRIMARY KEY (feed_id, tag_id)
);

CREATE INDEX feed_tags_by_tag ON feed_tags (tag_id);

/* Two folders whose names differ only in case end up as one tag. */
INSERT OR IGNORE INTO tags (name, created_at)
SELECT name, created_at FROM folders WHERE kind = 'feeds' ORDER BY position, id;

INSERT OR IGNORE INTO feed_tags (feed_id, tag_id)
SELECT f.id, t.id FROM feeds f
JOIN folders fo ON fo.id = f.folder_id AND fo.kind = 'feeds'
JOIN tags t ON t.name = fo.name;

UPDATE feeds SET folder_id = NULL WHERE folder_id IS NOT NULL;

DELETE FROM folders WHERE kind = 'feeds';
