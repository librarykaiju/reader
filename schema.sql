-- Tables for the reader Worker (D1 database "reader"), for a fresh install:
--   npx wrangler d1 execute reader --remote --file schema.sql
-- Safe to re-run: everything is IF NOT EXISTS. Times are Unix milliseconds.
-- A database made from an older version of this file is upgraded by the
-- files in migrations/ instead (each one says how).

-- Unused: feeds and books both have tags now (below). The table stays
-- because feeds.folder_id and books.folder_id still point at it (SQLite
-- can't drop those columns); migrations 0003 and 0005 emptied it.
CREATE TABLE IF NOT EXISTS folders (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('feeds', 'books')),
	parent_id INTEGER REFERENCES folders (id),
	position INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS folders_unique_name ON folders (kind, COALESCE(parent_id, 0), name);

-- url is what was typed in; feed_url is the discovered feed (NULL when the
-- site has no feed and the page itself is watched, mode = 'scrape').
-- email is set on a newsletter's feed: the sender's address, or
-- "patreon:<creator>" for Patreon, which mails every creator's posts from one
-- address (mode is 'scrape', and nothing is ever fetched for these feeds).
CREATE TABLE IF NOT EXISTS feeds (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	url TEXT NOT NULL,
	feed_url TEXT,
	mode TEXT NOT NULL DEFAULT 'feed' CHECK (mode IN ('feed', 'scrape')),
	title TEXT NOT NULL DEFAULT '',
	site_url TEXT,
	folder_id INTEGER REFERENCES folders (id) ON DELETE SET NULL,
	created_at INTEGER NOT NULL,
	last_fetched_at INTEGER,
	email TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS feeds_email ON feeds (email) WHERE email IS NOT NULL;

-- Senders whose mail is dropped: removing a newsletter's feed adds its
-- feeds.email here. To take one back: DELETE FROM email_blocked WHERE address = '...';
CREATE TABLE IF NOT EXISTS email_blocked (
	address TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL
);

-- content holds whatever the feed provided (or the extracted article once
-- it has been opened); NULL means "fetch the link when opened".
CREATE TABLE IF NOT EXISTS items (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	feed_id INTEGER NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
	guid TEXT NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	link TEXT,
	author TEXT,
	published_at INTEGER,
	content TEXT,
	read INTEGER NOT NULL DEFAULT 0,
	saved INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	-- A podcast episode's audio (or video) file, from the feed's enclosure;
	-- media_pos/media_len are seconds listened and its length (NULL = not started).
	media_url TEXT,
	media_type TEXT,
	media_pos REAL,
	media_len REAL,
	-- Items on the same story (one feed) share the first one's id; NULL = on its own.
	story_id INTEGER,
	UNIQUE (feed_id, guid)
);

CREATE INDEX IF NOT EXISTS items_by_date ON items (COALESCE(published_at, created_at) DESC, id DESC);
CREATE INDEX IF NOT EXISTS items_by_feed ON items (feed_id, read);
CREATE INDEX IF NOT EXISTS items_saved ON items (saved) WHERE saved = 1;
CREATE INDEX IF NOT EXISTS items_media ON items (COALESCE(published_at, created_at) DESC, id DESC) WHERE media_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS items_story ON items (story_id) WHERE story_id IS NOT NULL;

-- position is JSON text: {"f": 0.42} for .txt (fraction of the text),
-- {"page": 12, "pf": 0.3, "pages": 80, "f": 0.14} for .pdf; NULL = the start.
-- finished_at is set on reaching the end (or by hand); "Start over" keeps it.
CREATE TABLE IF NOT EXISTS books (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	title TEXT NOT NULL,
	filename TEXT NOT NULL,
	-- A .cbz comic is saved as 'pdf'; its file name marks it (BOOK_TYPE in src/index.js).
	type TEXT NOT NULL CHECK (type IN ('txt', 'pdf')),
	size INTEGER NOT NULL,
	r2_key TEXT NOT NULL UNIQUE,
	position TEXT,
	folder_id INTEGER REFERENCES folders (id) ON DELETE SET NULL,
	created_at INTEGER NOT NULL,
	last_opened_at INTEGER,
	finished_at INTEGER,
	-- From a .txt book's YAML header (see parseFrontMatter in src/index.js).
	author TEXT,
	series TEXT,
	volume TEXT
);

-- Tags for feeds. A feed can carry any number of them, and the page filters
-- the feed and item lists by one. Names are unique ignoring case. Removing a
-- feed or a tag takes its feed_tags rows with it (D1 enforces foreign keys).
CREATE TABLE IF NOT EXISTS tags (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_tags (
	feed_id INTEGER NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
	tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
	PRIMARY KEY (feed_id, tag_id)
);

CREATE INDEX IF NOT EXISTS feed_tags_by_tag ON feed_tags (tag_id);

-- Tags for books: their own set, separate from the feed tags, so each list
-- only offers its own. Books keep their folders too.
CREATE TABLE IF NOT EXISTS book_tags (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS book_tag_links (
	book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
	tag_id INTEGER NOT NULL REFERENCES book_tags (id) ON DELETE CASCADE,
	PRIMARY KEY (book_id, tag_id)
);

CREATE INDEX IF NOT EXISTS book_tag_links_by_tag ON book_tag_links (tag_id);
