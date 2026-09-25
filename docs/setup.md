# Reader Setup

A private feed and ebook reader at `reader.brandonj.ink`. Add a website by URL and it finds the site's feed. If the site has no feed, it watches the page for new article links instead. Upload `.txt` and `.pdf` books, and `.cbz` comics, to read in the browser. Feeds and books each get their own colored tags you can filter by, and books can be downloaded to read offline. It has Light, Dark, Sepia and Auto themes.

Everything runs on one Cloudflare Worker, a D1 database (feeds, tags, articles, books, reading positions) and a private R2 bucket (book files). The code is in the `librarykaiju/reader` repo. It all fits in the free tiers. Newsletters can also be emailed straight in (Part 6). Only you can use it: every request needs your token.

## Part 1: Make a token

Generate a long random password (32+ characters) in your password manager. The page asks for it once on each device. Use a different one from the photo upload token.

## Part 2: Create the database

1. Cloudflare dashboard → **Storage & Databases** → **D1 SQL Database** → **Create database**.
2. Name it `reader` → **Create**.
3. Open it → **Console**. Paste everything in the SQL block below → **Execute**.

```sql
CREATE TABLE IF NOT EXISTS folders (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('feeds', 'books')),
	parent_id INTEGER REFERENCES folders (id),
	position INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS folders_unique_name ON folders (kind, COALESCE(parent_id, 0), name);

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

CREATE TABLE IF NOT EXISTS email_blocked (
	address TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL
);

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

CREATE TABLE IF NOT EXISTS books (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	title TEXT NOT NULL,
	filename TEXT NOT NULL,
	type TEXT NOT NULL CHECK (type IN ('txt', 'pdf')),
	size INTEGER NOT NULL,
	r2_key TEXT NOT NULL UNIQUE,
	position TEXT,
	folder_id INTEGER REFERENCES folders (id) ON DELETE SET NULL,
	created_at INTEGER NOT NULL,
	last_opened_at INTEGER,
	finished_at INTEGER,
	author TEXT,
	series TEXT,
	volume TEXT
);

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
```

> [!check] Checkpoint
> Run `SELECT name FROM sqlite_master WHERE type = 'table';` in the Console. You should see `folders`, `feeds`, `items`, `books`, `email_blocked`, `tags`, `feed_tags`, `book_tags` and `book_tag_links` (plus a `sqlite_sequence` table and one or two starting with `_cf_`, which you can ignore).

## Part 3: Create the bucket

1. **R2 Object Storage** → **Create bucket**.
2. Name it `reader-books` → **Create bucket**.
3. Leave public access **off**. Books are only served through the Worker, after it checks your token.

## Part 4: Deploy the Worker

The code is about 3,400 lines, too long to keep in this note. Do this part on a laptop: copying that much on a phone is painful.

1. **Workers & Pages** → **Create** → **Start with Hello World!**
2. Name it `reader` → **Deploy**.
3. Open `src/index.js` in the repo on GitHub → **Raw**. Select all and copy.
4. Back in the Worker: **Edit code**. Delete everything in `worker.js`, paste → **Deploy**.
5. **Settings** → **Bindings** → **Add binding**:
   - **D1 database**: variable name `DB`, database `reader`.
   - **R2 bucket**: variable name `BOOKS`, bucket `reader-books`.
6. **Settings** → **Variables and Secrets** → **Add**: type **Secret**, name `READER_TOKEN`, value your token → **Deploy**.
7. **Settings** → **Domains & Routes** → **Add** → **Custom domain** → `reader.brandonj.ink` → **Add domain**. Cloudflare creates the DNS record and certificate itself. It can take a few minutes before the address loads.

From a terminal instead, in the repo root:

```sh
npx wrangler d1 create reader        # paste the id it prints into wrangler.toml
npx wrangler d1 execute reader --remote --file schema.sql
npx wrangler r2 bucket create reader-books
npx wrangler deploy
npx wrangler secret put READER_TOKEN
```

Then add the custom domain as in step 7.

### Updating

Some updates change the database too. Those come with a file in `migrations/`. Run each new one once, and always before the new code:

1. Open the migration file in the repo on GitHub → **Raw**. Select all and copy.
2. D1 → `reader` → **Console**. Paste → **Execute**.
3. Then paste the new `index.js` into **Edit code** → **Deploy**.

If an update has no new migration file, only do step 3. Your feeds, books, tags and positions stay where they are.

From a terminal instead, in the repo root:

```sh
npx wrangler d1 execute reader --remote --file migrations/0001_books_nested_finished.sql   # if not run yet
npx wrangler d1 execute reader --remote --file migrations/0002_email_newsletters.sql
npx wrangler d1 execute reader --remote --file migrations/0003_feed_tags.sql
npx wrangler d1 execute reader --remote --file migrations/0004_podcasts.sql
npx wrangler d1 execute reader --remote --file migrations/0005_book_tags_and_details.sql
npx wrangler d1 execute reader --remote --file migrations/0006_stories.sql
npx wrangler deploy
```

A migration that already ran stops with an error such as "duplicate column name" or "table tags already exists" and changes nothing.

## Part 5: Put it on your Home Screen

1. Open `https://reader.brandonj.ink` in Safari.
2. Paste your token → **Continue**.
3. **Share** → **Add to Home Screen**.

> [!check] Checkpoint
> Paste `https://www.theverge.com` into **Add a website or feed URL** → **Add**. The feed should appear under **Feeds** and its articles in **Unread**.

## Using it

**Feeds**
- **Adding:** paste a site's address or its feed address. The reader looks for a feed on the page, then at the usual places (`/feed`, `/rss.xml`, `/atom.xml` and so on). If there's no feed, it watches the page itself and lists its article links. Those feeds show a **page** tag.
- **Refreshing:** feeds refresh when you open the reader (any not checked in the last 5 minutes) and when you tap **Refresh**. Nothing runs in the background, so a feed that posts a lot may skip items if you don't open the reader for a long while.
- **Reading:** tap an article to open it. If the feed only gives a summary, the reader fetches the full article and keeps a copy. **Original ↗** opens the real page. Opening an article marks it read. **Save** keeps it in **Saved** for good.
- **Clean-up:** unsaved articles older than 90 days are removed once the feed stops listing them.
- **Stories:** when a feed has several articles on the same story (AP often posts the news, a live page, photos and a profile), **Unread** and **All** show them as one entry: the newest headline, with the others listed under it. The story counts as one in the unread numbers, and opening any of its articles marks the whole story read (**Mark unread** brings it all back). If a new article on the story comes in later, the story shows as unread again with that one on top. Grouping only happens inside one feed, looks at the last three days, and goes by the words in the headlines and links, so it's approximate: now and then it will group two stories that only share a few words, or miss a match. **Saved** always shows articles one by one. (Update with migration 0006.)

**Newsletters by email** (needs Part 6)
- Subscribe to a newsletter with your reader address (`news@bkaijunews.org`). Each sender gets its own feed with an **email** tag, and each issue shows up as an article in **Unread** as soon as it arrives. **Refresh** doesn't touch these feeds.
- Paid posts arrive in full, since the email is the full post.
- **Patreon** sends every creator's posts from one address, so the reader splits them into one feed per creator, named after the creator. Mail it can't place (receipts, account notices) goes to a shared **Patreon** feed. Some creators' emails are only a preview; **Original ↗** opens the post on Patreon.
- The first email is usually a "confirm your subscription" message. Open it in the reader and tap the confirm link.
- **Removing** a newsletter's feed (in **Edit**) also ignores any more mail from that sender. Unsubscribe with the link at the bottom of an issue first. To let a sender back in, run `DELETE FROM email_blocked WHERE address = 'sender@example.com';` in the D1 Console.
- Unsaved issues older than 90 days are removed when the next issue from that sender arrives.

**Podcasts**
- Add a podcast by its feed address, like any other feed. Every episode from every feed shows in **Podcasts**, newest first. Episodes stay out of **Unread** and **All**. To see them in the feed list, tap the podcast's feed.
- Tags work here too: tags on podcast feeds show as pills above the episode list. Tap one to see only those podcasts.
- **▶** plays an episode in the bar at the bottom. It keeps playing while you read, and it shows on the lock screen with skip buttons. In the bar: back 15 seconds, forward 30, speed (tap to cycle 0.8× to 2×), and **×** to close. Tap the title to open the episode's notes.
- The reader remembers where you stopped in each episode on every device, and picks up there next time. An episode played to the end shows as **Played** and is marked read.
- **⤓** downloads an episode to this device, and **✓** means it's downloaded (tap it to remove). **Downloaded** at the top shows only those.
- **Offline:** open the reader with no connection and it goes straight to your downloaded episodes, which play normally. Everything else needs a connection. On iPhone, add the reader to your Home Screen (Part 5), or Safari may clear downloads after about a week of not opening it.
- Video podcasts go in **Videos** instead (below).

**Videos**
- Add a YouTube channel, a Twitch feed, a Vimeo feed, or a video podcast like any other feed. For YouTube, paste the channel's address and the reader usually finds its feed. Twitch has no feed of its own, so use a Twitch-to-RSS service's address for the channel.
- Every video shows in **Videos**, newest first. Like podcasts, videos stay out of **Unread** and **All**, and tags show as pills to filter by.
- A video plays at the top of its page. The reader remembers where you stopped on every device, starts there next time, and shows **Played** once you reach the end.
- Videos that are real files (most video podcasts) get the podcast controls under the player: back 15, forward 30, and speed. They can also be downloaded with **⤓** and watched offline.
- YouTube, Twitch and Vimeo videos play in their own player, which has its own speed setting. They can't be downloaded, because those sites don't hand out the file.

**Books**
- **Library** → **Upload**. The menu next to it puts a tag on the new books (it starts on the tag you're looking at; **New tag…** makes one). `.txt`, `.pdf` or `.cbz`, up to 95 MB each. A comic opens one page at a time: swipe or tap the sides to turn, tap the middle to switch between whole page and page width. CBR comics need converting to CBZ first.
- The reader remembers your place in each book across devices.
- Plain-text books with hard line breaks every ~70 characters (like Project Gutenberg files) are joined back into normal paragraphs.
- **Finished:** a book gets a **Finished** badge in the Library when you reach the end. For a `.txt` that's when the last line is on screen. For a PDF it's when the bottom of the last page is on screen. Scrolling back doesn't remove it.
- To set or clear it by hand, open the book → **⋯** → **Mark finished** or **Mark unfinished**. It's also in **Edit** on the book's row.
- **Deleting:** open the book → **⋯** → **Delete book**, or **Edit** → **Delete** on its row. The book and its file are removed for good, from every device, along with this device's download of it.
- **Start over:** **⋯** → **Start over** (or **Edit** → **Start over**) takes you back to the beginning and clears your saved place. A finished book keeps its badge.
- **Offline:** **⤓** on a book's row (or **⋯** → **Download for offline** inside it) keeps the book on this device, and **✓** means it's downloaded (tap it to remove). With no connection, the Library shows your downloaded books and they open normally, PDFs included. Your place and **Finished** are saved on the device and sent when you're back online. If you read further on another device in the meantime, the later place wins. On iPhone, add the reader to your Home Screen (Part 5), or Safari may clear downloads after about a week of not opening it.
- **Book details from YAML:** a `.txt` book can start with a header like this, and the reader fills in its details when you upload it:

  ```yaml
  ---
  title: The Fifth Season
  author: N. K. Jemisin
  series: The Broken Earth
  volume: 1
  genre: [Fantasy, Science fiction]
  ---
  ```

  The title replaces the file name, the author and "Series #1" show under it in the Library, and each genre becomes a book tag (made if it's new). Every line is optional. Genres can also be one per line (`- Fantasy`) or comma-separated. The header is hidden while you read. A book uploaded before this update gets its details the first time you open it.
- **Replacing a book's file:** upload a file with the same name as a book already in the Library (the name, ignoring capitals) and it replaces that book's file instead of adding a second copy. The book keeps its place, **Finished** and tags. A YAML header in the new file updates the details, and new genres are added as tags (none are taken off). If the book was downloaded, the new file downloads in its place. This is the way to change a book's details: edit the header in the file, then upload it again.

**Tags (books)**
- Books have their own tags, separate from the feed tags: a book tag never shows on the feed list, and the other way round.
- Tags show as pills above the Library, with how many books have each, and as dots on each book's row. Tap one to see only those books, **Untagged** for books with none, and tap it again to see everything.
- **Edit** in the Library shows every tag under each book: tap one to put it on or take it off. **+ Tag** makes a new one and puts it on that book, and **New tag** above the list makes one without using it yet. Pick a tag in **Edit** to rename or delete it. Deleting a tag only takes it off its books.
- **Folders are gone** (update with migration 0005): each book folder became a book tag of the same name, on the books that were in it or in its subfolders. Nothing else changed and no book was deleted. Folders with the same name in different places became one tag.

**Tags (feeds)**
- A feed can have any number of tags. They show as colored pills above the feed list, with unread counts, and as colored dots on each feed's row. The colors are the same pastels brandonj.ink uses for its tag pills. A tag keeps its color; with more than 8 tags, colors repeat.
- Tap a tag to see only its feeds and their articles. **Untagged** shows feeds with no tags. Tap the tag again, or **All feeds**, to see everything.
- **Edit** on the feed list shows every tag under each feed: tap one to put it on or take it off. **+ Tag** makes a new tag and puts it on that feed. **New tag** at the bottom makes one without using it yet.
- To rename or delete a tag, pick it above the list while in **Edit**. Deleting a tag only takes it off its feeds.
- The menu next to **Add** puts one tag on a new feed. It starts on the tag you're looking at.

**Display:** **Aa** switches the theme and text size, remembered per device. **Auto** follows the phone's light or dark setting. In Dark and Sepia, PDF pages are re-tinted to match.

## Part 6: Newsletters by email

This lets newsletters mail themselves straight into the reader. It uses Cloudflare Email Routing, which is free. Do the Updating steps for migration `0002` first.

> [!note] Why a separate domain
> Newsletters go to `bkaijunews.org`, a domain used only for this. Email Routing has to own a domain's MX records, and `brandonj.ink` already has MX records for another mail service, so Cloudflare refuses to turn it on there (and a subdomain needs the main domain turned on first).

1. Cloudflare dashboard → **Compute** → **Email Service** → **Email Routing**. (Older dashboards: pick `bkaijunews.org` → **Email** → **Email Routing**.)
2. Pick `bkaijunews.org` → **Enable Email Routing** → **Add records and enable**.
3. **Routing rules** → **Create address**. Custom address `news`, action **Send to a Worker**, destination `reader` → **Save**.

### Patreon through Proton

Keep your Patreon account on Proton and forward just the post emails. This needs a paid Proton plan (Mail Plus, Unlimited or similar).

1. Proton → **Settings** → **All settings** → **Forward and auto-reply** → add a forwarding rule to `news@bkaijunews.org`.
2. Add a condition so only Patreon mail goes: sender contains `patreon.com`. If your Proton version only offers subject conditions, pick one that matches Patreon's post emails.
3. If Proton sends a confirmation email to the new address, it arrives in the reader as its own feed. Open it and tap the confirm link, then remove that feed.

Forwarded Patreon mail is still recognized as Patreon even if Proton puts your address in the From line.

> [!check] Checkpoint
> From any email account, send a message to `news@bkaijunews.org`. Open the reader: a feed named after you, tagged **email**, should appear with the message in it. Remove it afterwards (that also ignores more mail from that address, see **Newsletters by email** above).

## If something goes wrong

| You see | Fix |
|---|---|
| "That token didn't work." | The token doesn't match `READER_TOKEN`. Paste it again. |
| Errors mentioning `DB` or `no such table` | Check the `DB` binding points at `reader`, and that the SQL in Part 2 ran. |
| Upload fails straight away | Check the `BOOKS` binding points at `reader-books`. |
| "No feed, watching the page" but no articles show up | The site builds its pages with JavaScript or blocks servers. Delete it and try the site's feed address directly (often `/feed` or `/rss`). |
| "Couldn't load the PDF viewer from cdnjs" | The PDF viewer loads from cdnjs when you open a PDF. Check you're online, then reload. |
| "Couldn't find the article text on that page." | Tap **Original ↗** to read it on the site. |
| A newsletter never shows up | **Email Routing** → **Activity log** shows whether the mail arrived and what the Worker did. A sender you removed before is ignored until you take it off `email_blocked`. |
| Other errors | Worker → **Logs** in Cloudflare. |

To change the token, update `READER_TOKEN` in Cloudflare, then **Aa** → **Forget token on this device** and enter the new one.
