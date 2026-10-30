# Reader Setup

A private feed and ebook reader at `reader.brandonj.ink`. Add a website by URL and it finds the site's feed. If the site has no feed, it watches the page for new article links instead. Upload `.txt`, `.pdf` and DRM-free `.epub` books, and `.cbz` comics, to read in the browser. Feeds and books each get their own colored tags you can filter by, and books can be downloaded to read offline. It has Light, Dark, Sepia and Auto themes.

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
npx wrangler d1 execute reader --remote --file migrations/0007_highlights.sql
npx wrangler d1 execute reader --remote --file migrations/0008_coverage.sql
npx wrangler d1 execute reader --remote --file migrations/0009_comic_layout.sql
npx wrangler d1 execute reader --remote --file migrations/0010_family.sql
npx wrangler d1 execute reader --remote --file migrations/0011_library_card_requests.sql
npx wrangler d1 execute reader --remote --file migrations/0012_request_limit.sql
npx wrangler d1 execute reader --remote --file migrations/0013_request_email.sql
npx wrangler d1 execute reader --remote --file migrations/0014_book_records.sql
npx wrangler d1 execute reader --remote --file migrations/0015_previews.sql
npx wrangler d1 execute reader --remote --file migrations/0016_book_catalog.sql
npx wrangler d1 execute reader --remote --file migrations/0017_audiobooks.sql
npx wrangler d1 execute reader --remote --file migrations/0018_feed_images.sql
npx wrangler d1 execute reader --remote --file migrations/0019_abs_ebooks.sql
npx wrangler deploy
```

A migration that already ran stops with an error such as "duplicate column name" or "table tags already exists" and changes nothing.

## Part 5: Put it on your Home Screen

1. Open `https://reader.brandonj.ink` in Safari.
2. Paste your token → **Continue**.
3. **Share** → **Add to Home Screen**.

An icon added before Reader had a web manifest (October 2026) can send a tap on the lock screen's Now Playing to another web app on brandonj.ink, such as wr1t3r. Delete that icon and add it again.

> [!check] Checkpoint
> Paste `https://www.theverge.com` into **Add a website or feed URL** → **Add**. The feed should appear under **Feeds** and its articles in **Unread**.

## Using it

**Feeds**
- **Adding:** paste a site's address or its feed address. The reader looks for a feed on the page, then at the usual places (`/feed`, `/rss.xml`, `/atom.xml` and so on). If there's no feed, it watches the page itself and lists its article links. Those feeds show a **page** tag.
- **Refreshing:** feeds refresh when you open the reader (any not checked in the last 5 minutes) and when you tap **Refresh**. Nothing runs in the background, so a feed that posts a lot may skip items if you don't open the reader for a long while.
- **Reading:** tap an article to open it. If the feed only gives a summary, the reader fetches the full article and keeps a copy. **Original ↗** opens the real page. Opening an article marks it read. **Save** keeps it in **Saved** for good.
- **Mark read as I scroll:** turn it on in **Settings** (the gear), per device. In **Unread**, a row that scrolls up past the header is marked read; it dims rather than disappearing, and its checkmark brings it back. A read mark made offline waits on the device and is sent when the connection is back, so other devices see it.
- **Clean-up:** unsaved articles older than 90 days are removed once the feed stops listing them.
- **Stories:** when a feed has several articles on the same story (AP often posts the news, a live page, photos and a profile), **Unread** and **All** show them as one entry: the newest headline, with the others listed under it. The story counts as one in the unread numbers, and opening any of its articles marks the whole story read (**Mark unread** brings it all back). If a new article on the story comes in later, the story shows as unread again with that one on top. Grouping only happens inside one feed, looks at the last three days, and goes by the words in the headlines and links, so it's approximate: now and then it will group two stories that only share a few words, or miss a match. **Saved** always shows articles one by one. (Update with migration 0006.)
- **Compare coverage** (needs Part 7): when another feed has the same story from around the same time, a box above the article says **Also covered by** and names it. **Compare coverage** gets the full text of each article and asks an AI model (Llama 3.3 70B on Workers AI) for a digest: **What the sources agree on** (only facts at least two of them report, with which ones) and **What the sources are saying** (per outlet, what it reports differently or alone). Each of those points quotes its article word for word, and the quote links to that passage on the original page; a point whose quote isn't really in the article is thrown out before you see it, and the digest says how many were. A paywalled article that only gave a teaser is marked as an excerpt, so it's never counted as leaving something out. The digest is saved: opening any of its articles shows **Show coverage digest** at no cost, and **Compare again** appears if a new source turns up. Matching goes by headline and opening words, two days either side, at most one article per feed, so it needs feeds that cover the same news. The model also drops an article that turns out to be a different story.

**Newsletters by email** (needs Part 6)
- Subscribe to a newsletter with your reader address (`news@bkaijunews.org`). Each sender gets its own feed with an **email** tag, and each issue shows up as an article in **Unread** as soon as it arrives. **Refresh** doesn't touch these feeds.
- Paid posts arrive in full, since the email is the full post.
- **Patreon** sends every creator's posts from one address, so the reader splits them into one feed per creator, named after the creator. Mail it can't place (receipts, account notices) goes to a shared **Patreon** feed. Some creators' emails are only a preview; **Original ↗** opens the post on Patreon.
- The first email is usually a "confirm your subscription" message. Open it in the reader and tap the confirm link.
- **Removing** a newsletter's feed (in **Edit**) also ignores any more mail from that sender. Unsubscribe with the link at the bottom of an issue first. To let a sender back in, run `DELETE FROM email_blocked WHERE address = 'sender@example.com';` in the D1 Console.
- Unsaved issues older than 90 days are removed when the next issue from that sender arrives.

**Podcasts**
- **Podcasts** opens on your shows' artwork (a drawn tile where a show has none), the newest episode's show first, each with a badge for its unread episodes. Tap a show for its episodes, newest first; **Mark all read** there clears its badge. Marking an episode unplayed makes it unread again. Episodes stay out of **Unread** and **All**.
- **+ Add** above the shows: type words to search Apple's podcast directory, or paste a feed link or an Apple Podcasts page. A podcast's feed address also works in the feed list's **Add**, like any other feed.
- **▶** plays an episode in the bar at the bottom. It keeps playing while you read, and it shows on the lock screen with skip buttons. In the bar: back 15 seconds, forward 30, speed (tap to cycle 0.8× to 2×), and **×** to close. Tap the title to open the episode's notes, where **Sleep** sets a sleep timer for the episode playing: 15, 30, 45 minutes, an hour, or the end of the episode, and **Voice** boosts voices, as on the audiobook player page. With it on, an episode that isn't downloaded streams through the Worker (`/media`), since the browser only lets the boost reach files from Reader's own address.
- The reader remembers where you stopped in each episode on every device, and picks up there next time. An episode played to the end shows as **Played** and is marked read.
- **⤓** downloads an episode to this device, and **✓** means it's downloaded (tap it to remove). **Downloaded** at the top shows only those, as one newest-first list.
- **Offline:** open the reader with no connection and it goes straight to your downloaded episodes, which play normally. Everything else needs a connection. On iPhone, add the reader to your Home Screen (Part 5), or Safari may clear downloads after about a week of not opening it.
- Video podcasts go in **Videos** instead (below).

**Videos**
- Add a YouTube channel, a Twitch feed, a Vimeo feed, or a video podcast like any other feed. For YouTube, paste the channel's address and the reader usually finds its feed. Twitch has no feed of its own, so use a Twitch-to-RSS service's address for the channel.
- **Videos** opens on the channels, each with its unread count, like **Podcasts**. A channel's picture comes from its feed or, for YouTube, from the channel's page. **+ Add** there takes a channel's link or its @handle. Like podcasts, videos stay out of **Unread** and **All**.
- A video plays at the top of its page. The reader remembers where you stopped on every device, starts there next time, and shows **Played** once you reach the end.
- Videos that are real files (most video podcasts) get the podcast controls under the player: back 15, forward 30, and speed. They can also be downloaded with **⤓** and watched offline.
- YouTube, Twitch and Vimeo videos play in their own player, which has its own speed setting. They can't be downloaded, because those sites don't hand out the file.

**Books**
- **Library** → **Upload**. The menu next to it puts a tag on the new books (it starts on the tag you're looking at; **New tag…** makes one). `.txt`, `.pdf`, `.epub` or `.cbz`, up to 95 MB each. A comic opens one page at a time: swipe or tap the sides to turn, tap the middle to switch between whole page and page width. CBR comics need converting to CBZ first.
- **Comic layouts:** ⋯ → **Pages / Scroll / Right to left**. **Scroll** is for webtoons: every page stacked at full width with no gaps, so strips cut into slices join up, and your place is kept to the spot within a page. **Right to left** is for manga: tap or swipe the other way, the arrow keys and the slider are mirrored, and guided view reads panels right to left. The first time a comic opens it picks one by itself: **Scroll** when its ComicInfo.xml says `<Format>Webtoon</Format>` or its pages are about twice as tall as wide, **Right to left** when it says `<Manga>YesAndRightToLeft</Manga>`, otherwise **Pages**. The choice is saved on the book, so it's the same on every device. (Update with migration 0009.)
- The reader remembers your place in each book across devices.
- **Continue reading** is a shelf atop Unread, All and the Library: every book you've opened and not finished, most recent first, then **Up next**, the next volume of each series you've finished one of (and aren't part-way through another). Swipe it sideways. In the Library it hides while you search, pick a tag or open a series.
- **EPUBs** read like a `.txt`: one long scroll in the reader's font, size and theme, with the book's italics, bold, headings and pictures kept and its own fonts and layout left out. **⋯** → **Contents** lists the chapters (the one you're in is marked), and links inside the book, such as footnotes, jump to their place. Highlights and notes work the same as in a `.txt`. The title, author and series come from the EPUB itself when you upload it; renaming the book afterwards sticks. Only DRM-free EPUBs open: a store copy with copy protection (Apple Books, Kobo, Google Play, Adobe) is turned away at upload with a message saying so.
- Plain-text books with hard line breaks every ~70 characters (like Project Gutenberg files) are joined back into normal paragraphs.
- **Finished:** a book gets a **Finished** badge in the Library when you reach the end. For a `.txt` or `.epub` that's when the last line is on screen (an EPUB's end is its last chapter, not notes kept after it). For a PDF it's when the bottom of the last page is on screen. Scrolling back doesn't remove it.
- To set or clear it by hand, open the book → **⋯** → **Mark finished** or **Mark unfinished**. It's also in **Edit** on the book's row.
- **Deleting:** open the book → **⋯** → **Delete book**, or **Edit** → **Delete** on its row. The book and its file are removed for good, from every device, along with this device's download of it.
- **Furthest place and bookmark:** the reader keeps the furthest point you've read to in each book. Scroll back by accident and a **Back to furthest** button appears under the header; tap it to return (**×** hides it). Only reading on moves the furthest point: jumping well ahead (a fling of the scrollbar, a chapter from **Contents**) leaves it where it was. The bookmark button next to the page number marks your current place by hand (tap it again on the same spot to remove it), and **⋯** → **Go to bookmark** or **Go to furthest** jumps to either. Both sync across devices with your place and work offline.
- **Start over:** **⋯** → **Start over** (or **Edit** → **Start over**) takes you back to the beginning and clears your saved place and furthest point; a bookmark stays. A finished book keeps its badge.
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
- Tags show as pills above the Library, with how many books have each, and as dots on each book's row. Tags no book has are hidden (they still show in **Edit**). Tap one to see only those books, **Untagged** for books with none, and tap it again to see everything.
- Picking a tag narrows the bar too: only the tags the shown books also carry stay, with how many of those books have each. Tap a second one to see books with both, and so on. Tap a picked tag to drop it, or **Clear** to drop them all. The link (`#/library?tag=3,7`) keeps the picks.
- **Edit** in the Library shows every tag under each book: tap one to put it on or take it off. **+ Tag** makes a new one and puts it on that book, and **New tag** above the list makes one without using it yet. Pick a tag in **Edit** to rename or delete it. Deleting a tag only takes it off its books.
- **Genre tags:** an uploaded `.epub`, `.cbz` or `.pdf` gets genre tags from its own details (an EPUB's subjects, a comic's ComicInfo.xml genres and tags, a PDF's keywords). Every comic also gets **Comics**. **Tag genres** does the same for books already in the Library, and when the file has none, looks the book up on Open Library by its title and author. It's in a book's right-click menu, in **Edit details** (which looks it up by the title and author as typed), and in **Edit** for every ticked book at once.
  - Subjects are matched against a fixed list of genres (Science Fiction, Fantasy, Urban Fantasy, Horror, Mystery, Thriller, Romance, Historical Fiction, Literary Fiction, Young Adult, Children's, Humor, Short Fiction, Poetry, Drama, Classics, Mythology & Folklore, Comics, Superheroes, History, Biography & Memoir, Philosophy, Religion, Science), so "FICTION / Fantasy / Urban" or "Fiction, fantasy, general" becomes one clean tag and noise like "Accessible book" is dropped. A subject in the file that's already the name of one of your book tags is used as well.
  - Open Library is only trusted when its match has the same title (give or take a subtitle) and the same author's surname, and it adds at most three genres. Tags are only ever added; none are taken off.
- **Folders are gone** (update with migration 0005): each book folder became a book tag of the same name, on the books that were in it or in its subfolders. Nothing else changed and no book was deleted. Folders with the same name in different places became one tag.

**Tags (feeds)**
- A feed can have any number of tags. They show as colored pills above the feed list, with unread counts, and as colored dots on each feed's row. The colors are the same pastels brandonj.ink uses for its tag pills. A tag keeps its color; with more than 8 tags, colors repeat.
- Tap a tag to see only its feeds and their articles. **Untagged** shows feeds with no tags. Tap the tag again, or **All feeds**, to see everything.
- **Edit** (on the **Feeds** row) shows every tag under each feed: tap one to put it on or take it off. **+ Tag** makes a new tag and puts it on that feed. **New tag**, next to **Edit**, makes one without using it yet.
- To rename or delete a tag, pick it above the list while in **Edit**. Deleting a tag only takes it off its feeds.
- The menu next to **Add** puts one tag on a new feed. It starts on the tag you're looking at.

**Family library: The Back Alley Library** (update with migrations 0010 and 0011)
- It lives at `reader.brandonj.ink/library` (the old `/family` address redirects there, invite links included). Anyone who opens it without a sign-in sees a landing page with **Request your library card**: they give their name and, if they like, their email and how you know them. Requests show at the top of the Family screen, and as a card atop Unread. **Approve** makes their link to send them; if they gave an email, it also opens a ready-to-send email with the link in your mail app (there's an **Email** button too, if it didn't open). **Decline** drops the request.
- The request form is guarded: a hidden field that only bots fill in, at most 3 requests a day from one address, and at most 25 waiting at once. For a captcha as well, set up Cloudflare Turnstile (free):
  1. Cloudflare dashboard → **Turnstile** → **Add widget**. Name it "Back Alley Library", add the hostname `reader.brandonj.ink`, mode **Managed** → **Create**.
  2. Copy the **Site key** into `wrangler.toml` under `[vars]` as `TURNSTILE_SITE_KEY = "..."`.
  3. Set the **Secret key** with `npx wrangler secret put TURNSTILE_SECRET` and paste it.
  4. `npx wrangler deploy`. The check shows on the form once someone taps **Request your library card**, and usually passes by itself. Until both keys are set, the form works without it.
- When a request is waiting, the **settings gear** gets a red dot and **Family library** a count, and a request that's new to this device pops up a message with **See**. Reader checks when it opens, when you come back to it, and every 5 minutes while it's showing. The Home Screen icon shows the count too where the browser supports it; on an iPhone or iPad that needs notifications allowed for Reader, which it doesn't ask for yet.
- **Settings** (the gear) → **Family library**. Type a name → **Make link**, then **Copy** or **Share** it to them. The link works once: opening it signs that browser in (a cookie that lasts a year and renews on each visit) and changes the address to the plain `reader.brandonj.ink/library`, which is the one to bookmark. An unused link runs out after 7 days.
- The first time someone opens their link they get a welcome page: the plain address to keep and how to save it on their device (Home Screen or bookmark), then **Go to the library**. It's there again from **How to save this page** at the bottom. Set your name for it with `OWNER_NAME` in `wrangler.toml`.
- Their page is always in the Sepia colors: covers (a series is one cover that opens to its volumes), search by title, author or series, and filters for format (EPUB, PDF, Comics, Text) and tag. The Fiction and Nonfiction genre cards under the search (Comics first, which holds every comic plus any book tagged Comics, Graphic Novels or Manga) take turns with those filters: tapping a genre sets format back to **All** and tag to **All tags**, and picking a format or tag lets go of the genre, so a genre never shows an empty page because of a filter left on. Tapping a book downloads it, saved as `Title - Author.epub`. Nothing else is open to them: no feeds, places, highlights, Edit details, uploads or deletes. Put the tag **Hide from family** on any book to keep it out of their view. Comics under 100 MB are kept out of it too, since those are single issues rather than collections. They stay in your own Library.
- Each person can download 10 different books in any 24 hours (taking the same book again doesn't count twice). Their page shows how many they have left, and a tap past the limit says to come back tomorrow. The number is `DOWNLOADS_PER_DAY` in `src/index.js`; you have no limit.
- **Read online** on a book's Record opens the whole book to read on the page, the way **Listen** plays a whole audiobook, without downloading it and without counting toward the 10. An EPUB or text file comes in pieces of about 30 pages, the next loading as they near the end of the last; a PDF is drawn page by page from the parts of the file it needs; a comic shows every page. The place is kept on that device, and the book opens there next time, with **Start from the beginning** under the title. Hidden books can't be read. (The `previews` table from migration 0015 held the old previews' 40% limit on PDFs and isn't used any more.)
- On the Family screen, **N downloads ›** under a person lists what they downloaded and when.
- **New link** makes a fresh link and signs them out everywhere (a lost phone, a forwarded link). **Remove** cuts them off at once. Links are shown only when made, since only a scrambled copy is stored; if one gets lost, make a new one.

**Display:** the **settings gear** switches the theme and text size, remembered per device. **Auto** follows the phone's light or dark setting. In Dark and Sepia, PDF pages are re-tinted to match.

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

## Part 7: Compare coverage

This turns on the **Compare coverage** button. It uses Cloudflare Workers AI, which comes with your Cloudflare account: no other sign-up, no key. Do the Updating steps for migration `0008` first.

1. Cloudflare dashboard → Workers → `reader` → **Settings** → **Bindings** → **Add binding** → **Workers AI**.
2. Variable name `AI` → **Add Binding** (or **Deploy**).

(`npx wrangler deploy` adds it by itself: it's in `wrangler.toml`.)

The model is Llama 3.3 70B. Workers AI gives every account 10,000 free Neurons a day, reset at midnight UTC, and one comparison uses roughly 500 to 1,000 of them, so ten to twenty comparisons a day cost nothing. Past that the button says the allowance is used up until tomorrow; on the free Workers plan nothing is ever charged. Saved digests cost nothing to open again. Very long articles are cut to fit the model (about 56,000 characters between them) and marked as excerpts.

Expect rougher digests than Claude would write, and probably more misquotes; those points are dropped (the digest says how many). To use Claude instead, remove the `AI` binding and add an Anthropic API key with credit as the secret `ANTHROPIC_API_KEY` (about 5 to 15 cents a comparison). With both set, Workers AI is used.

## Part 8: Audiobooks from Audiobookshelf

This puts the audiobooks from your Audiobookshelf (ABS) server into the family library. Family can listen to them on the page or download them, 2 a day each on top of the 10 books. They never get ABS accounts, and ABS stays off the internet: Reader reaches it through a Cloudflare Tunnel that only Reader's service token gets through. Run migration `0017` first (Updating).

1. **A read-only ABS user.** In ABS go to Settings → **Users** → **Add User**: username `reader`, type **User**. Turn on **Can Download**, **Access all libraries**, **Access all tags** and explicit content. Turn off Update, Delete and Upload.
2. **An API key** (ABS 2.26 or later): Settings → **API Keys** → **Add API Key**, name `Reader`, never expires, acting as `reader`. Copy it; it's shown once.
3. **The tunnel.** Cloudflare dashboard → Zero Trust → Networks → **Tunnels** → **Create a tunnel** → Cloudflared, named `unraid`, and copy its token. On Unraid, install **cloudflared** from Apps with that token (or post arguments `tunnel --no-autoupdate run --token <TOKEN>`). Back on the tunnel, add a **Public Hostname**: subdomain `abs`, your domain, type HTTP, URL `<Unraid LAN IP>:13378` (or wherever ABS listens).
4. **Lock it.** Zero Trust → Access → Service Auth → **Service Tokens** → Create `reader-worker`, non-expiring; copy the Client ID and Secret. Then Access → Applications → **Add** → Self-hosted, domain `abs.<your domain>`, with one policy: action **Service Auth**, include Service Token `reader-worker`.
5. **Test it.** `https://abs.<your domain>` in a browser should be blocked. This should list your libraries:
   ```
   curl https://abs.<your domain>/api/libraries -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" -H "Authorization: Bearer <API key>"
   ```
6. **Secrets on the Worker:** Workers → `reader` → Settings → Variables and Secrets, each as a **Secret**: `ABS_URL` (`https://abs.<your domain>`), `ABS_TOKEN` (the API key), `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`.
7. Deploy. The cron in `wrangler.toml` reads ABS every 30 minutes. To read it now:
   ```
   curl -X POST https://reader.brandonj.ink/api/audiobooks/sync -H "Authorization: Bearer <READER_TOKEN>"
   ```
   It answers with how many were added, updated and gone.

How it behaves:
- Every ABS book library is included, except ones ABS marks missing. Items with no audio come in as ebooks (below). One removed from ABS disappears from the library at the next sync, and comes back if it returns.
- Covers come from ABS once and are kept in R2. Records use ABS's description, then the usual lookups; Length is the running time, and the narrator gets a line.
- **Listen** on a Record plays the whole book on the page, laid out like your own player page: the square cover, a slider across the chapter playing, back 15 / forward 30, previous and next chapter, speed, a sleep timer (15, 30, 45 minutes, an hour, or the end of the chapter), **Voice** (voice boost: tap for a little, again for more, again for off; it lifts the range voices are clearest in and evens out quiet and loud, and stays set on that device), and every chapter to jump to, from the chapter's name, **Chapters**, or the list below. The lock screen shows the cover and takes play, pause and skips, and tapping it there opens the library. Once it has played, it keeps going after leaving the page, in a bar at the bottom of the library (tap the title to go back to the player, **×** to stop), until another audiobook plays. It remembers the place on that device, and it isn't counted. **Download** sends the .m4b as it is, or a zip when the book is several files.
- **Chapters** come from ABS. A book in several files with none gets a chapter per file. A single file with none (an .m4b without chapter marks) gets Audible's chapters, looked up by the ASIN in ABS or by its title and author, but only when Audible's release runs as long as the file, since another recording's chapters would land in the wrong places. To fix one by hand, set its chapters in ABS (the book's Chapters tab, where **Lookup** does the same thing); Reader picks them up the next time ABS changes it.
- While the server, the tunnel or the home internet is down, the library still browses; playing and downloading say the server is offline.
- In your own Library in the app, an audiobook with the same title and author as an ebook is one entry, as in the family library, with an open book and headphones beside it. **All formats** above the list narrows it to ebooks or audiobooks. Every entry opens its **Record**: **Read** opens the ebook, and **Listen** plays the audiobook in the player bar, so it keeps going while you read feeds. The place syncs between devices like a reading place, and the Record lists the chapters to start from. Tap the title in the player bar (or **Player** on the Record) for the player page: the square cover, a slider across the chapter playing, back 15 / forward 30, previous and next chapter, speed, a sleep timer (15, 30, 45 minutes, an hour, or the end of the chapter; a timer still set when a podcast starts keeps going, and the end of the chapter becomes the end of the episode), **Voice** (voice boost: tap for a little, again for more, again for off; it lifts the range voices are clearest in and evens out quiet and loud, and stays set on that device), and every chapter to jump to. The lock screen shows it too, and tapping it there opens Reader. Audiobooks can't be deleted in the app (remove them in ABS), and their title and author come back from ABS whenever ABS changes them.

### Ebooks from Audiobookshelf

The same sync brings in ABS's ebooks, so books can live on the server instead of in R2. Run migration `0019` first (Updating). They show up in your Library and in the family library like uploaded books: they open, preview, download (counted in the 10 a day) and get records as usual.

1. **Give ABS the folder.** On Unraid: Docker → Audiobookshelf → Edit → **Add another Path**. Container path `/ebooks`, host path where the ebooks are (say `/mnt/user/media/ebooks`), access mode Read Only → Apply.
2. **One folder per book**, as for audiobooks: `ebooks/Author/Title/Title.epub`, with a series folder in between if you like. EPUB, PDF and CBZ come into Reader. ABS also takes MOBI, AZW3 and CBR, but Reader leaves those out (convert CBR to CBZ).
3. **Add it to a library.** ABS → Settings → **Libraries**: add `/ebooks` as a folder of your Books library, or make a new library with media type **Book** on `/ebooks`. Either works for Reader.
4. **Let `reader` see it.** Settings → **Users** → `reader`: **Access all libraries** (or tick the new one).
5. **Scan** the library in ABS, then sync Reader (step 7 above) or wait for the cron. A sync looks up at most 100 new or changed ebooks (fewer on the Workers free plan, which stops it at about 40), new ones first; the answer's `ebooks.waiting` says how many are left for the next one.

How they behave:
- An ebook sitting in the same folder as an audiobook's files is one ABS item, and one entry with both formats in either library. An ebook in a folder of its own pairs with its audiobook the usual way, by title and author.
- Covers come from ABS, once, and are kept in R2.
- The file is read from ABS each time it's opened, a piece at a time for comics, PDFs and previews, so it's a little slower than R2. **Download for offline** in the app works as before.
- While the server is down, these books say the home server is offline; books in R2 still open.
- **Genre tags** come from ABS too, for audiobooks and ebooks: an item's tags (an audiobook's are Audible's categories), else its genres, matched against the same list as **Tag genres** (run migration `0020` first). They follow ABS: change an item's tags or genres there and the next sync adds or takes off its genre tags in Reader. Tags you add in Reader stay whatever ABS says, but a genre tag that came from ABS comes back if you remove it in Reader, so change those in ABS. Books ABS has no genres for can still use **Tag genres**.
- They can't be deleted in the app (remove them in ABS), uploading a file with the same name adds a separate book instead of replacing it, and their title, author and series come back from ABS whenever ABS changes the item. A changed file gets its cover and preview made again.

### Comics from Audiobookshelf

Comics kept as a folder per series, with every issue in it (`Comics/Invincible/Invincible 001.cbz`, `Invincible 002.cbz`, …), come in too, one book per issue. ABS makes one item of a folder and lists all but one issue as extra files; Reader takes every CBZ, PDF and EPUB in an item that has no audio and more than one of them.

1. **Make a library.** ABS → Settings → **Libraries** → add one with media type **Book**, named say `Comics`, on the comics folder (it needs to be inside a path the ABS container can see). Keeping comics out of the Ebooks library keeps them apart from novels in ABS; Reader doesn't mind either way.
2. **Let `reader` see it** and **scan** it, as above. Each series folder is one lookup, so even a big collection comes in within a few syncs.

How they behave:
- Each issue is titled from its file name, without the `(2015)` and `[tags]` groups. Its series is the folder's title in ABS, and its number is the last number left in that name (`Star Wars 001` → 1).
- Its cover is its own first page, not the folder's cover.
- A folder with just one comic is one book, titled and covered the way ABS has it.
- CBR is left out, as for ebooks: convert it to CBZ (same pages, a different archive).

## If something goes wrong

| You see | Fix |
|---|---|
| "That token didn't work." | The token doesn't match `READER_TOKEN`. Paste it again. |
| Errors mentioning `DB` or `no such table` | Check the `DB` binding points at `reader`, and that the SQL in Part 2 ran. |
| Upload fails straight away | Check the `BOOKS` binding points at `reader-books`. |
| Audiobooks: "Cloudflare Access turned Reader away" | `CF_ACCESS_CLIENT_ID` or `_SECRET` is wrong, or the Access policy isn't **Service Auth** with that token. |
| Audiobooks: "turned down Reader's API key" | `ABS_TOKEN` is wrong or expired, or the `reader` user is disabled. |
| "No feed, watching the page" but no articles show up | The site builds its pages with JavaScript or blocks servers. Delete it and try the site's feed address directly (often `/feed` or `/rss`). |
| "Couldn't load the PDF viewer from cdnjs" | The PDF viewer loads from cdnjs when you open a PDF. Check you're online, then reload. |
| "Couldn't find the article text on that page." | Tap **Original ↗** to read it on the site. |
| A newsletter never shows up | **Email Routing** → **Activity log** shows whether the mail arrived and what the Worker did. A sender you removed before is ignored until you take it off `email_blocked`. |
| Other errors | Worker → **Logs** in Cloudflare. |

To change the token, update `READER_TOKEN` in Cloudflare, then **Settings** (the gear) → **Forget token on this device** and enter the new one.
