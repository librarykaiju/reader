// reader: a private feed and ebook reader for one person. The Worker is a
// thin API -- auth, a fetch proxy, D1 for feeds/tags/items/books, R2 for
// the book files. Everything clever (feed discovery, RSS/Atom/JSON Feed
// parsing, page scraping, article extraction, HTML sanitizing, the PDF
// viewer) happens in the browser, in the page at the bottom of this file.
//
// Bindings / settings (Cloudflare dashboard -> this Worker -> Settings):
//   DB                   D1 database binding -> "reader" (tables: schema.sql)
//   BOOKS                R2 bucket binding -> "reader-books" (kept private)
//   READER_TOKEN         secret; any long random string, entered once on the page (the owner)
//   AI                   Workers AI binding, optional; turns on "Compare coverage" (see Coverage below)
//   ANTHROPIC_API_KEY    secret, optional; compares with Claude instead, when there's no AI binding; and picks
//                        the family library's appeal terms (Workers AI does without it; see "Book records")
//   CATALOG_TOKEN        secret, optional; a read-only token for GET /api/catalog, which the site's build
//                        uses to fill its book logs' catalog details (any long random string)
//   OWNER_NAME           optional; your name on the family welcome page ("Welcome to Brandon's library")
//   TURNSTILE_SITE_KEY   optional; with TURNSTILE_SECRET (a secret), a Cloudflare Turnstile check on the
//                        library card request form (docs/setup.md, "Family library")
//   ABS_URL, ABS_TOKEN   optional; Audiobookshelf's address (through a Cloudflare Tunnel) and an API key for a
//                        read-only user there: its audiobooks join the family library (see "Audiobooks")
//   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
//                        secrets, optional; the Cloudflare Access service token in front of ABS_URL
//   ALLOW_PRIVATE_FETCH  dev only: "1" lets /api/fetch reach localhost and
//                        private IPs, for local test fixtures. Never in production.
//
// Routes (everything under /api/ needs "Authorization: Bearer <READER_TOKEN>",
// except /api/family/, which a family member's sign-in cookie also opens; see
// "Family library" below):
//   GET    /                       the app page (no data in it; asks for the token)
//   GET    /library                the family library: a landing page with "Request your library card",
//                                  or the books once signed in (signs in from #invite=<code>)
//   GET    /family                 its old address: redirects to /library (an invite's #code goes along)
//   GET    /sw.js                  its service worker: keeps the page for offline use
//   GET    /fonts/fraunces-soft(-italic).woff2
//                                  the display and reading typeface (src/fonts/, OFL)
//   GET    /api/fetch?url=         fetch a feed/page for the browser -> the upstream
//                                  body + Content-Type, and X-Final-URL after redirects
//   GET    /api/tags               -> {"tags": [...]}      (feed tags, A-Z)
//   POST   /api/tags               {name} -> {"tag"} (the existing one if the name is taken)
//   PATCH  /api/tags/:id           {name}
//   DELETE /api/tags/:id           takes it off its feeds; the feeds stay
//   GET/POST /api/booktags, PATCH/DELETE /api/booktags/:id
//                                  the same for book tags, a separate set
//   GET    /api/feeds              -> {"feeds": [...each with an unread count, episodes, videos, articles, and tags: [tag ids]]}
//                                  (podcast episodes and videos aren't in unread, or in Unread/All unless feed= is given;
//                                  a show's unread episodes are unread_episodes, its newest one's date latest_episode;
//                                  a video channel's, unread_videos and latest_video)
//   POST   /api/feeds              {url, feed_url, mode, title, site_url, tags?}
//   PATCH  /api/feeds/:id          {title?, feed_url?, mode?, site_url?, tags?}
//                                  (tags: the feed's whole set of tag ids)
//   DELETE /api/feeds/:id          also deletes its items
//   GET    /api/items?view=unread|saved|all|podcasts|videos&feed=&tag=&before=&limit=
//                                  newest first -> {"items", "next"} (tag=0: untagged feeds);
//                                  Unread and All list a story once, with its other items in related
//   POST   /api/items              {feed_id, items: [...], image?} -- one feed's refresh (image: its artwork)
//                                  (podcasts/videos: each with notes, a short plain-text preview of its show notes)
//   GET    /api/items/:id          one item, with its content
//   PATCH  /api/items/:id          {read?, saved?, content?, media_pos?, media_len?} (read covers its whole story)
//   POST   /api/items/mark-read    {feed?, tag?} or {ids: [...]} (ids: those items and their stories,
//                                  as the list marks rows read on scroll)
//   GET    /api/items/:id/coverage -> {"sources", "digest", "new_sources", "enabled"}: the article and its best
//                                  match in each other feed from around the same time, and the newest saved digest
//                                  covering it (null if none); new_sources counts matches that digest left out
//   POST   /api/items/:id/coverage {sources: [{id, text}]} -> {"digest"}: compares them with Claude and saves it
//                                  (ids from GET; text is each article's full text as the page extracted it)
//   GET    /api/continue           -> {"episode", "book", "requests"}: the newest podcast episode part-way
//                                  through, the last opened book not finished (either may be null),
//                                  and how many library card requests are waiting
//   GET    /api/media?url=         a podcast episode's file, streamed through for
//                                  downloading (podcast hosts rarely allow CORS)
//   GET    /api/media/listen?url=  -> {"url", "expires"}: a signed /media address for the episode, good for LISTEN_HOURS
//   GET    /media?u=&e=&s=         the episode streamed through with ranged reads, for the player bar with
//                                  voice boost on (Web Audio only hears files from this site)
//   GET    /api/books              -> {"books": [...each with tags: [book tag ids]]} (audiobooks too: type "audiobook",
//                                  with narrator and duration; the page joins each to its ebook, see "Formats")
//   GET    /api/books/:id/listen   an audiobook's parts to play -> {"duration", "chapters", "files": [{duration, url}], "download"};
//                                  each url is a signed /listen/ address good for LISTEN_HOURS (an <audio> can't
//                                  send the token)
//   GET    /listen/:id/:n?e=&s=    audiobook file n (from 0), streamed from Audiobookshelf with ranged reads
//                                  (/listen/:id/file: the whole audiobook as a download, as the family library's)
//   POST   /api/audiobooks/sync    -> {"added", "updated", "gone", "total", "ebooks", "covers"}: reads Audiobookshelf now (a cron
//                                  also does every 30 minutes), and fetches up to 40 covers not kept yet; 503 when
//                                  it isn't set up
//   PUT    /api/books?name=&tag=  body = a .txt, .pdf, .cbz or .epub file -> {"book"} (tag: a book tag id to put on it)
//                                  (a file name already in the Library replaces that book's file: {"book", "replaced": true})
//   POST   /api/books/uploads?name=  a file over 95 MB, sent in pieces -> {key, upload_id, part_size}
//   PUT    /api/books/uploads?key=&upload_id=&n=  body = piece n (from 1) -> {part}
//   POST   /api/books/uploads/done?name=&key=&upload_id=&tag=  {parts} -> as PUT /api/books
//   DELETE /api/books/uploads?key=&upload_id=  gives up on an upload
//   GET    /api/books/lookup?q=    Open Library's matches for a title (and author) -> {hits: [{title, author, year, thumb, work, cover_id}]}
//   GET    /api/books/lookup/covers?work=&title=&author=&cover_id=  -> {covers: [image URLs]} (Google Books, then Open Library's editions)
//   GET    /api/books/lookup/image?url=  one of those covers, fetched for the page (Open Library and Google Books only)
//   GET    /api/books/:id/file     the file itself (?dl=1: saving it for offline, so not "opened")
//   GET    /api/books/:id/part?at=&len=  len bytes of the file from byte at (up to 4 MB; for drawing a PDF's cover)
//   GET    /api/books/:id/cover    the cover image (an EPUB's or a comic's first page is found the first time); 404 if none
//   GET    /api/books/:id/record  -> {"id", "record": {blurb, pages, appeal, from, filled}} (?fill=1: looks it up if it
//                                  hasn't been; ?refresh=1: looks it all up again, keeping what was edited)
//   POST   /api/books/:id/genres  {title?, author?, online?} -> {"book", "added": [tag names], "from": "file"|"online"|""}
//                                  adds genre tags from the file's own subjects, else Open Library's (never removes any)
//   PUT    /api/books/:id/cover    body = a JPEG/PNG/WebP: a PDF's first page the page drew, or one chosen in Edit details
//   DELETE /api/books/:id/cover    back to the automatic cover (the file's own, or a PDF's first page)
//   PATCH  /api/books/:id          {title?, author?, series?, volume?, position?, finished?, opened?, tags?, reread?, layout?,
//                                  blurb?, pages?, appeal?} (the last three: the Record page's, see "Book records")
//                                  (layout, a comic's: "pages", "scroll" (webtoon), "rtl" (manga), or null)
//                                  (author/series/volume: the page reads them from an EPUB's own details;
//                                  reread: fill them in again from a .txt's YAML header or a comic's ComicInfo.xml)
//                                  (position null = start over)
//   DELETE /api/books/:id          also deletes the file from R2
//   GET    /api/books/:id/highlights -> {"highlights": [...]} in the order they come in the book
//   POST   /api/books/:id/highlights {start_pos, end_pos, text, note?} -> {"highlight"}
//   PATCH  /api/highlights/:id     {note?, start_pos?, end_pos?} (note null or "" = no note)
//   DELETE /api/highlights/:id
//   GET    /api/people             -> {"people": [...each with signed_in, invite_expires_at, last_seen_at, downloads,
//                                  requested_at, request_note and request_email (a library card request not yet answered)]}
//   POST   /api/people             {name} -> {"person", "code"}: a new family member and their invite code
//   POST   /api/people/:id/link    -> {"person", "code"}: a fresh invite code; signs out their devices
//                                  (on a request: approves it)
//   DELETE /api/people/:id         removes them (and their download log); their sign-in stops at once
//   POST   /api/family/redeem      {code} -> {"name"} and the sign-in cookie (no token needed; the code works once)
//   POST   /api/family/request     {name, note?, check?} -> {ok}: asks for a library card (no token needed; check is
//                                  the Turnstile token when it's set up); shows on the Family screen
//   GET    /api/people/:id/downloads -> {"downloads": [{at, book_id, title, author}]}, newest first
//   GET    /api/family/me          -> {"name", "owner", "left", "today", "audio_left", "audio_today"} (name null for
//                                  the owner; owner from OWNER_NAME; left and today: downloads left in the last 24
//                                  hours and the book ids already taken, null for the owner; audio_: the same for
//                                  audiobooks, which have their own limit); renews the cookie
//   GET    /api/family/books       -> {"books": [...each with tags: [names]]}, without any tagged "Hide from family"
//   GET    /api/catalog           -> {"books": [{id, title, author, series, volume, pages, pages_estimated,
//                                  year?, publisher?, language?, classification?, isbn?}]}: catalog details for the
//                                  site's book logs; takes CATALOG_TOKEN (read-only) as well as READER_TOKEN
//   GET    /api/family/books/:id  -> {"id", "record"}: the book's Record (as /api/books/:id/record), looked up the
//                                  first time it's opened; 404 for a hidden book
//   GET    /api/family/books/:id/cover   as /api/books/:id/cover
//   GET    /api/family/books/:id/file    the file as a download named "Title - Author.ext" (logged for a family member,
//                                        who gets 10 different books in any 24 hours; a page saying so after that;
//                                        an audiobook is its .m4b, or a zip of its files, 2 a day)
//   GET    /api/family/books/:id/audio/:n  an audiobook's file n (from 0), streamed from Audiobookshelf with ranged
//                                  reads for the player; not a download, so not counted
//   GET    /api/family/books/:id/preview?at=  -> the book to read online (not counted as a download; see
//                                  "Reading online"): {"type": "epub"|"txt", "blocks", "at", "next"}, a piece of the
//                                  text from at (a chapter for an EPUB, a byte for .txt) with where the next starts
//                                  (null at the end); {"type": "cbz", "pages"}, {"type": "pdf", "size"} or
//                                  {"type": "audiobook", "files", "chapters", "duration"}
//   GET    /api/family/books/:id/preview/page/:n  a comic's page n (from 0)
//   GET    /api/family/books/:id/preview/part?at=&len=  len bytes of a PDF from byte at, for pdf.js
//
// Email (Cloudflare Email Routing -> "Send to a Worker" -> this Worker):
//   each message sent to the routed address (news@brandonj.ink, say) becomes
//   an item in a feed for its sender. See "Newsletters by email" below.

// Free-plan request bodies top out at 100MB anyway; this just gives a clear
// error instead of Cloudflare's bare 413.
const MAX_BOOK_BYTES = 95 * 1024 * 1024;

const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const FETCH_MAX_REDIRECTS = 5;

const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_ITEMS_PER_BATCH = 200;
// D1 rows top out at 2MB; bigger articles are dropped and fetched on open.
const MAX_CONTENT_CHARS = 500000;
const PRUNE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
// Email Routing itself takes up to 25MB; newsletters are far smaller.
const MAX_EMAIL_BYTES = 10 * 1024 * 1024;

const BOOK_TYPES = { txt: "text/plain; charset=utf-8", pdf: "application/pdf", cbz: "application/vnd.comicbook+zip", epub: "application/epub+zip" };
// A CBZ comic (a zip of page images) or an EPUB is saved with type 'pdf',
// because the live books table only allows 'txt' and 'pdf' and changing that
// means rebuilding the table. Its .cbz or .epub file name is what marks it,
// so the type read back from the database comes from that.
// An audiobook from Audiobookshelf is the same: 'pdf', with a name ending
// .audiobook (see "Audiobooks"). An ebook from Audiobookshelf keeps its
// .epub, .pdf or .cbz name; its r2_key starting "absbook/" is what sends its
// reads there (bookObject).
const BOOK_TYPE = "CASE WHEN filename LIKE '%.cbz' THEN 'cbz' WHEN filename LIKE '%.epub' THEN 'epub' WHEN filename LIKE '%.audiobook' THEN 'audiobook' ELSE type END";
function storedType(ext) { return ext === "cbz" || ext === "epub" ? "pdf" : ext; }
function bookType(book) { const m = /\.(cbz|epub|audiobook)$/i.exec(book.filename); return m ? m[1].toLowerCase() : book.type; }
const NOT_AUDIOBOOK = "filename NOT LIKE '%.audiobook'";
// Every book column but r2_key, which never leaves the Worker.
const BOOK_COLUMNS = `id, title, filename, ${BOOK_TYPE} AS type, size, position, finished_at, created_at, last_opened_at, author, series, volume, layout, pages, narrator, duration, abs_ebook IS NOT NULL AS home`;
// An item with a media file is a podcast episode, or a video if the file is
// video; YouTube, Twitch and Vimeo videos are stored as video/x-youtube etc.
const VIEWS = {
	unread: "i.read = 0", saved: "i.saved = 1", all: "1 = 1",
	podcasts: "i.media_url IS NOT NULL AND i.media_type NOT LIKE 'video/%'", videos: "i.media_type LIKE 'video/%'",
};
const MEDIA_TYPE = /^(audio|video)\/[\w.+-]{1,60}$/i;
// Episodes are big; this only stops a runaway (a live stream, say).
const MEDIA_MAX_BYTES = 1024 * 1024 * 1024;
const MEDIA_MAX_REDIRECTS = 10;

// Look like Safari, so sites hand over the same page a person would get.
const FETCH_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
	Accept:
		"text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/feed+json,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
};

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) return page();
		if (url.pathname === "/library" && (request.method === "GET" || request.method === "HEAD")) return familyPage(env);
		// Browsers keep the #invite=... part across a redirect, so old links still sign in.
		if (url.pathname === "/family" && (request.method === "GET" || request.method === "HEAD")) return Response.redirect(new URL("/library" + url.search, url), 301);
		if (url.pathname === "/sw.js" && request.method === "GET") return serviceWorker();
		if (url.pathname === "/apple-touch-icon.png" && request.method === "GET") return touchIcon();
		if (FONTS[url.pathname] && request.method === "GET") return font(FONTS[url.pathname]);
		const listen = url.pathname.match(/^\/listen\/(\d+)\/(\d+|file)$/);
		if (listen && request.method === "GET") return listenFile(request, env, url, Number(listen[1]), listen[2]).catch(errorJSON);
		if (url.pathname === "/media" && request.method === "GET") return mediaFile(request, env, url).catch(errorJSON);
		if (!url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

		try {
			if (url.pathname === "/api/family/redeem" && request.method === "POST") return await redeemInvite(request, env);
			if (url.pathname === "/api/family/request" && request.method === "POST") return await requestCard(request, env);
			// The site's build reads catalog details with its own read-only token.
			if (url.pathname === "/api/catalog" && request.method === "GET") {
				if (!(await tokenIs(request, env.CATALOG_TOKEN)) && !(await isOwner(request, env))) return json({ error: "Unauthorized" }, 401);
				return await catalogFeed(env);
			}
			const who = await signedIn(request, env);
			if (!who) return json({ error: "Unauthorized" }, 401);
			// The role check: a family sign-in reaches the family routes and nothing else.
			if (url.pathname.startsWith("/api/family/")) return (await familyApi(request, env, url, who)) || json({ error: "Not found" }, 404);
			if (who.person) return json({ error: "Only the family library is open to this sign-in" }, 403);
			return (await api(request, env, url)) || json({ error: "Not found" }, 404);
		} catch (err) {
			if (err instanceof HttpError) return json({ error: err.message }, err.status);
			return json({ error: String(err?.message || err) }, 500);
		}
	},

	async email(message, env) {
		await receiveEmail(message, env);
	},

	// Every 30 minutes (wrangler.toml): new and changed audiobooks and ebooks from Audiobookshelf.
	async scheduled(event, env, ctx) {
		if (absOn(env)) ctx.waitUntil(absSync(env).then(() => absWarmCovers(env)).catch((err) => console.warn("audiobooks", err)));
	},
};

// -> {owner: true} for READER_TOKEN, {person} for a family member's cookie, or null.
async function signedIn(request, env) {
	if (await isOwner(request, env)) return { owner: true };
	const person = await familyPerson(request, env);
	return person ? { person } : null;
}

function isOwner(request, env) {
	return tokenIs(request, env.READER_TOKEN);
}
// Whether the request's Bearer token is this secret (false when it isn't set).
async function tokenIs(request, secret) {
	if (!secret || !secret.trim()) return false;
	const header = request.headers.get("Authorization") || "";
	const given = header.replace(/^Bearer\s+/i, "").trim();
	if (!given) return false;
	// Hash both sides so the constant-time compare always sees equal lengths.
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(given)),
		crypto.subtle.digest("SHA-256", enc.encode(secret.trim())),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}

async function api(request, env, url) {
	const m = request.method;
	const p = url.pathname;
	let id;

	if (p === "/api/fetch" && m === "GET") return proxyFetch(url.searchParams.get("url"), env);
	if (p === "/api/media" && m === "GET") return proxyMedia(url.searchParams.get("url"), env);
	if (p === "/api/media/listen" && m === "GET") return mediaListen(env, url.searchParams.get("url"));

	for (const [path, t] of [["/api/tags", TAGS.feeds], ["/api/booktags", TAGS.books]]) {
		if (p === path) {
			if (m === "GET") return listTags(env, t);
			if (m === "POST") return addTag(request, env, t);
		}
		if ((id = matchId(p, path + "/"))) {
			if (m === "PATCH") return updateTag(request, env, t, id);
			if (m === "DELETE") return deleteTag(env, t, id);
		}
	}

	if (p === "/api/feeds") {
		if (m === "GET") return listFeeds(env);
		if (m === "POST") return addFeed(request, env);
	}
	if ((id = matchId(p, "/api/feeds/"))) {
		if (m === "PATCH") return updateFeed(request, env, id);
		if (m === "DELETE") return deleteFeed(env, id);
	}

	if (p === "/api/items") {
		if (m === "GET") return listItems(env, url);
		if (m === "POST") return addItems(request, env);
	}
	if (p === "/api/items/mark-read" && m === "POST") return markRead(request, env);
	if (p === "/api/continue" && m === "GET") return continueCards(env);
	const cov = p.match(/^\/api\/items\/(\d+)\/coverage$/);
	if (cov) {
		if (m === "GET") return getCoverage(env, toId(cov[1]));
		if (m === "POST") return compareCoverage(request, env, toId(cov[1]));
	}
	if ((id = matchId(p, "/api/items/"))) {
		if (m === "GET") return getItem(env, id);
		if (m === "PATCH") return updateItem(request, env, id);
	}

	if (p === "/api/audiobooks/sync" && m === "POST") return json({ ...(await absSync(env)), covers: await absWarmCovers(env) });
	if (p === "/api/books") {
		if (m === "GET") return listBooks(env);
		if (m === "PUT") return uploadBook(request, env, url);
	}
	if (p === "/api/books/uploads") {
		if (m === "POST") return startUpload(env, url);
		if (m === "PUT") return uploadPart(request, env, url);
		if (m === "DELETE") return abortUpload(env, url);
	}
	if (p === "/api/books/uploads/done" && m === "POST") return finishUpload(request, env, url);
	if (p === "/api/books/lookup" && m === "GET") return lookupBooks(url);
	if (p === "/api/books/lookup/covers" && m === "GET") return lookupCovers(url);
	if (p === "/api/books/lookup/image" && m === "GET") return lookupImage(url);
	const file = p.match(/^\/api\/books\/(\d+)\/file$/);
	if (file && m === "GET") return bookFile(env, toId(file[1]), url.searchParams.has("dl"));
	const part = p.match(/^\/api\/books\/(\d+)\/part$/);
	if (part && m === "GET") return bookPart(env, toId(part[1]), url);
	const genres = p.match(/^\/api\/books\/(\d+)\/genres$/);
	if (genres && m === "POST") return tagGenres(request, env, toId(genres[1]));
	const listenInfo = p.match(/^\/api\/books\/(\d+)\/listen$/);
	if (listenInfo && m === "GET") return listenParts(env, toId(listenInfo[1]));
	const record = p.match(/^\/api\/books\/(\d+)\/record$/);
	if (record && m === "GET") return ownerRecord(env, toId(record[1]), url);
	const cover = p.match(/^\/api\/books\/(\d+)\/cover$/);
	if (cover) {
		if (m === "GET") return bookCover(env, toId(cover[1]));
		if (m === "PUT") return putBookCover(request, env, toId(cover[1]));
		if (m === "DELETE") return deleteBookCover(env, toId(cover[1]));
	}
	if ((id = matchId(p, "/api/books/"))) {
		if (m === "PATCH") return updateBook(request, env, id);
		if (m === "DELETE") return deleteBook(env, id);
	}
	const hl = p.match(/^\/api\/books\/(\d+)\/highlights$/);
	if (hl) {
		if (m === "GET") return listHighlights(env, toId(hl[1]));
		if (m === "POST") return addHighlight(request, env, toId(hl[1]));
	}
	if ((id = matchId(p, "/api/highlights/"))) {
		if (m === "PATCH") return updateHighlight(request, env, id);
		if (m === "DELETE") return deleteHighlight(env, id);
	}

	if (p === "/api/people") {
		if (m === "GET") return listPeople(env);
		if (m === "POST") return addPerson(request, env);
	}
	const link = p.match(/^\/api\/people\/(\d+)\/link$/);
	if (link && m === "POST") return newInvite(env, toId(link[1]));
	const dls = p.match(/^\/api\/people\/(\d+)\/downloads$/);
	if (dls && m === "GET") return listDownloads(env, toId(dls[1]));
	if ((id = matchId(p, "/api/people/")) && m === "DELETE") return removePerson(env, id);
	return null;
}

// ---------------------------------------------------------------------------
// Fetch proxy. The browser can't read other sites directly (CORS), so it asks
// the Worker. Only public http(s) addresses, a handful of redirects (each one
// re-checked), 15s and 5MB at most, and only for someone holding the token --
// never an open proxy. Hostnames that *resolve* to private IPs can't reach
// anything private from a Worker anyway (fetch runs on Cloudflare's edge), so
// the checks below are about literal addresses and local-only names.

async function proxyFetch(raw, env) {
	const allowPrivate = env.ALLOW_PRIVATE_FETCH === "1";
	let target = checkTarget(raw, allowPrivate);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		let res;
		for (let hop = 0; ; hop++) {
			res = await fetch(target.href, { headers: FETCH_HEADERS, redirect: "manual", signal: controller.signal });
			const location = res.status >= 300 && res.status < 400 ? res.headers.get("Location") : null;
			if (!location) break;
			await res.body?.cancel();
			if (hop >= FETCH_MAX_REDIRECTS) throw new HttpError(502, "Too many redirects");
			target = checkTarget(new URL(location, target).href, allowPrivate);
		}
		if (!res.ok) {
			await res.body?.cancel();
			throw new HttpError(502, `The site answered ${res.status}`);
		}
		if (Number(res.headers.get("Content-Length")) > FETCH_MAX_BYTES) {
			await res.body?.cancel();
			throw new HttpError(413, "That page is over 5 MB");
		}
		const body = await readCapped(res.body, FETCH_MAX_BYTES);
		return new Response(body, {
			headers: {
				"Content-Type": res.headers.get("Content-Type") || "application/octet-stream",
				"X-Final-URL": target.href,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				// Someone else's HTML, served from this origin: never let it run here.
				"Content-Security-Policy": "default-src 'none'; sandbox",
			},
		});
	} catch (err) {
		if (err instanceof HttpError) throw err;
		if (controller.signal.aborted) throw new HttpError(504, "The site took too long to answer");
		throw new HttpError(502, `Couldn't fetch that: ${err?.message || err}`);
	} finally {
		clearTimeout(timer);
	}
}

// An episode file, streamed through (never held in memory), for the page to
// save for offline listening. Same address checks as above, more redirects
// (podcast links bounce through a stats service or two), no time limit once
// the file starts, and only audio/video (or a generic binary type).
// range: the player's Range header (/media), passed on so it can seek.
async function proxyMedia(raw, env, range) {
	const allowPrivate = env.ALLOW_PRIVATE_FETCH === "1";
	let target = checkTarget(raw, allowPrivate);
	const ask = { "User-Agent": FETCH_HEADERS["User-Agent"], Accept: "audio/*, video/*, */*" };
	if (range) ask.Range = range;
	let res;
	try {
		for (let hop = 0; ; hop++) {
			res = await fetch(target.href, { headers: ask, redirect: "manual" });
			const location = res.status >= 300 && res.status < 400 ? res.headers.get("Location") : null;
			if (!location) break;
			await res.body?.cancel();
			if (hop >= MEDIA_MAX_REDIRECTS) throw new HttpError(502, "Too many redirects");
			target = checkTarget(new URL(location, target).href, allowPrivate);
		}
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(502, `Couldn't fetch that: ${err?.message || err}`);
	}
	if (!res.ok) {
		await res.body?.cancel();
		throw new HttpError(range && res.status === 416 ? 416 : 502, `The site answered ${res.status}`);
	}
	const type = (res.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
	if (!MEDIA_TYPE.test(type) && !/^(application\/octet-stream|binary\/octet-stream|application\/x-download)$/.test(type)) {
		await res.body?.cancel();
		throw new HttpError(415, "That isn't an audio or video file");
	}
	const length = Number(res.headers.get("Content-Length"));
	if (length > MEDIA_MAX_BYTES) {
		await res.body?.cancel();
		throw new HttpError(413, "That file is over 1 GB");
	}
	const headers = {
		"Content-Type": MEDIA_TYPE.test(type) ? type : "application/octet-stream",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'; sandbox",
	};
	if (length > 0) headers["Content-Length"] = String(length);
	if (range) for (const k of ["Content-Range", "Accept-Ranges"]) if (res.headers.get(k)) headers[k] = res.headers.get(k);
	return new Response(res.body, { status: range && res.status === 206 ? 206 : 200, headers });
}

async function readCapped(stream, max) {
	if (!stream) return new Uint8Array(0);
	const reader = stream.getReader();
	const chunks = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			throw new HttpError(413, "That page is over 5 MB");
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

function checkTarget(raw, allowPrivate) {
	let u;
	try {
		u = new URL(String(raw || ""));
	} catch {
		throw new HttpError(400, "That isn't a valid URL");
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "Only http and https URLs");
	if (u.username || u.password) throw new HttpError(400, "URLs with a username or password aren't allowed");
	if (!allowPrivate && isPrivateHost(u.hostname)) throw new HttpError(403, "That address is private");
	u.hash = "";
	return u;
}

// The URL parser has already normalized odd IPv4 spellings (0x7f.1,
// 2130706433, 127.1 ...) to dotted decimal and IPv6 to compressed hex.
function isPrivateHost(hostname) {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (!host) return true;
	if (host === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return true;
	if (host.startsWith("[")) return !isPublicIPv6(host.slice(1, -1));
	const v4 = parseIPv4(host);
	if (v4) return !isPublicIPv4(v4);
	return !host.includes("."); // single-label names only mean something on a LAN
}

function parseIPv4(s) {
	const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return null;
	const parts = m.slice(1).map(Number);
	return parts.every((n) => n <= 255) ? parts : null;
}

function isPublicIPv4([a, b, c]) {
	if (a === 0 || a === 10 || a === 127) return false; // "this" network, private, loopback
	if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
	if (a === 169 && b === 254) return false; // link-local (incl. cloud metadata)
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 168) return false;
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
	if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
	if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false;
	if (a >= 224) return false; // multicast, reserved, broadcast
	return true;
}

function parseIPv6(s) {
	s = s.split("%")[0];
	const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
	if (dotted) {
		const v4 = parseIPv4(dotted[2]);
		if (!v4) return null;
		s = dotted[1] + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
	}
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	let parts = head;
	if (halves.length === 2) {
		const tail = halves[1] ? halves[1].split(":") : [];
		const fill = 8 - head.length - tail.length;
		if (fill < 1) return null;
		parts = [...head, ...Array(fill).fill("0"), ...tail];
	}
	if (parts.length !== 8 || !parts.every((x) => /^[0-9a-f]{1,4}$/i.test(x))) return null;
	return parts.map((x) => parseInt(x, 16));
}

// Allow-list: only global unicast (2000::/3), minus documentation and 6to4.
// IPv4-mapped and NAT64 addresses are judged by the IPv4 address inside.
function isPublicIPv6(s) {
	const h = parseIPv6(s);
	if (!h) return false;
	const inner = [h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255];
	if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return isPublicIPv4(inner);
	if (h[0] === 0x64 && h[1] === 0xff9b) return isPublicIPv4(inner);
	if ((h[0] & 0xe000) !== 0x2000) return false;
	if (h[0] === 0x2001 && h[1] === 0x0db8) return false;
	if (h[0] === 0x2002) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Tags. Feeds and books each have their own set, so a book tag never shows
// among the feed tags or the other way round. A feed or book can carry any
// number; names are unique ignoring case and list A-Z. Deleting a tag only
// takes it off what carried it.

const TAGS = {
	feeds: { table: "tags", links: "feed_tags", col: "feed_id" },
	books: { table: "book_tags", links: "book_tag_links", col: "book_id" },
};

async function listTags(env, t) {
	const { results } = await env.DB.prepare(`SELECT * FROM ${t.table} ORDER BY lower(name), id`).all();
	return json({ tags: results });
}

// Adding a name that's already taken just returns that tag, so "New tag…"
// with an existing name still does what was meant.
async function addTag(request, env, t) {
	const body = await readJSON(request);
	const name = tagName(body.name);
	const existing = await env.DB.prepare(`SELECT * FROM ${t.table} WHERE name = ?`).bind(name).first();
	if (existing) return json({ tag: existing, existing: true });
	const tag = await env.DB.prepare(`INSERT INTO ${t.table} (name, created_at) VALUES (?, ?) RETURNING *`)
		.bind(name, Date.now())
		.first();
	return json({ tag }, 201);
}

async function updateTag(request, env, t, id) {
	const body = await readJSON(request);
	const name = tagName(body.name);
	const dup = await env.DB.prepare(`SELECT id FROM ${t.table} WHERE name = ? AND id != ?`).bind(name, id).first();
	if (dup) throw new HttpError(409, `There's already a tag called "${name}"`);
	const tag = await env.DB.prepare(`UPDATE ${t.table} SET name = ? WHERE id = ? RETURNING *`).bind(name, id).first();
	if (!tag) throw new HttpError(404, "No such tag");
	return json({ tag });
}

async function deleteTag(env, t, id) {
	const [, del] = await env.DB.batch([
		env.DB.prepare(`DELETE FROM ${t.links} WHERE tag_id = ?`).bind(id),
		env.DB.prepare(`DELETE FROM ${t.table} WHERE id = ?`).bind(id),
	]);
	if (!del.meta.changes) throw new HttpError(404, "No such tag");
	return json({ ok: true });
}

function tagName(v) {
	const name = str(v, 80);
	if (!name) throw new HttpError(400, "Tag name is required");
	return name;
}

// A feed's (or book's) whole set of tags: an array of tag ids, each one checked.
async function tagRefs(env, value, t = TAGS.feeds) {
	if (!Array.isArray(value)) throw new HttpError(400, "tags must be an array of tag ids");
	const ids = [...new Set(value.map(toId))];
	if (!ids.length) return ids;
	const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t.table} WHERE id IN (SELECT value FROM json_each(?))`)
		.bind(JSON.stringify(ids))
		.first();
	if (row.n !== ids.length) throw new HttpError(400, "No such tag");
	return ids;
}

function setFeedTags(env, feedId, ids) { return setTags(env, TAGS.feeds, feedId, ids); }
function setTags(env, t, ownerId, ids) {
	return env.DB.batch([
		env.DB.prepare(`DELETE FROM ${t.links} WHERE ${t.col} = ?`).bind(ownerId),
		...ids.map((tag) => env.DB.prepare(`INSERT INTO ${t.links} (${t.col}, tag_id) VALUES (?, ?)`).bind(ownerId, tag)),
	]);
}

// ---------------------------------------------------------------------------
// Feeds

async function listFeeds(env) {
	const { results } = await env.DB.prepare(
		`SELECT f.*, (SELECT COUNT(DISTINCT COALESCE(i.story_id, i.id)) FROM items i WHERE i.feed_id = f.id AND i.read = 0 AND i.media_url IS NULL) AS unread,
			(SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id AND ${VIEWS.podcasts}) AS episodes,
			(SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id AND ${VIEWS.podcasts} AND i.read = 0) AS unread_episodes,
			(SELECT MAX(COALESCE(i.published_at, i.created_at)) FROM items i WHERE i.feed_id = f.id AND ${VIEWS.podcasts}) AS latest_episode,
			(SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id AND ${VIEWS.videos}) AS videos,
			(SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id AND ${VIEWS.videos} AND i.read = 0) AS unread_videos,
			(SELECT MAX(COALESCE(i.published_at, i.created_at)) FROM items i WHERE i.feed_id = f.id AND ${VIEWS.videos}) AS latest_video,
			(SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id AND i.media_url IS NULL) AS articles,
			(SELECT json_group_array(t.tag_id) FROM feed_tags t WHERE t.feed_id = f.id) AS tags
		FROM feeds f ORDER BY lower(f.title), f.id`,
	).all();
	for (const f of results) f.tags = JSON.parse(f.tags || "[]");
	return json({ feeds: results });
}

async function addFeed(request, env) {
	const body = await readJSON(request);
	const url = httpUrl(body.url);
	if (!url) throw new HttpError(400, "url must be an http(s) URL");
	const mode = body.mode === "scrape" ? "scrape" : body.mode === "feed" ? "feed" : null;
	if (!mode) throw new HttpError(400, "mode must be feed or scrape");
	const feedUrl = mode === "feed" ? httpUrl(body.feed_url) : null;
	if (mode === "feed" && !feedUrl) throw new HttpError(400, "feed_url must be an http(s) URL");
	const siteUrl = httpUrl(body.site_url) || url;
	const title = str(body.title, 300) || new URL(siteUrl).hostname;
	const tagIds = body.tags == null ? [] : await tagRefs(env, body.tags);

	// Adding the same feed (or page) twice just returns the one already there.
	const existing = await env.DB.prepare("SELECT * FROM feeds WHERE COALESCE(feed_url, url) = ?")
		.bind(feedUrl || url)
		.first();
	if (existing) return json({ feed: existing, existing: true });

	const feed = await env.DB.prepare(
		`INSERT INTO feeds (url, feed_url, mode, title, site_url, created_at)
		VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
	)
		.bind(url, feedUrl, mode, title, siteUrl, Date.now())
		.first();
	if (tagIds.length) await setFeedTags(env, feed.id, tagIds);
	feed.tags = tagIds;
	return json({ feed }, 201);
}

async function updateFeed(request, env, id) {
	const body = await readJSON(request);
	const sets = [];
	const params = [];
	if (body.title !== undefined) {
		const title = str(body.title, 300);
		if (!title) throw new HttpError(400, "title can't be empty");
		sets.push("title = ?");
		params.push(title);
	}
	if (body.feed_url !== undefined) {
		const feedUrl = body.feed_url === null ? null : httpUrl(body.feed_url);
		if (body.feed_url !== null && !feedUrl) throw new HttpError(400, "feed_url must be an http(s) URL");
		sets.push("feed_url = ?");
		params.push(feedUrl);
	}
	if (body.mode !== undefined) {
		if (body.mode !== "feed" && body.mode !== "scrape") throw new HttpError(400, "mode must be feed or scrape");
		sets.push("mode = ?");
		params.push(body.mode);
	}
	if (body.site_url !== undefined) {
		const siteUrl = httpUrl(body.site_url);
		if (!siteUrl) throw new HttpError(400, "site_url must be an http(s) URL");
		sets.push("site_url = ?");
		params.push(siteUrl);
	}
	const tagIds = body.tags === undefined ? null : await tagRefs(env, body.tags);
	if (!sets.length && !tagIds) throw new HttpError(400, "Nothing to change");
	const feed = sets.length
		? await env.DB.prepare(`UPDATE feeds SET ${sets.join(", ")} WHERE id = ? RETURNING *`).bind(...params, id).first()
		: await env.DB.prepare("SELECT * FROM feeds WHERE id = ?").bind(id).first();
	if (!feed) throw new HttpError(404, "No such feed");
	if (tagIds) await setFeedTags(env, id, tagIds);
	if (feed.mode === "feed" && !feed.feed_url) {
		await env.DB.prepare("UPDATE feeds SET mode = 'scrape' WHERE id = ?").bind(id).run();
		feed.mode = "scrape";
	}
	return json({ feed });
}

// Removing a newsletter's feed also blocks its sender, or the next issue
// would just bring it back.
async function deleteFeed(env, id) {
	const [, , del] = await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO email_blocked (address, created_at) SELECT email, ? FROM feeds WHERE id = ? AND email IS NOT NULL",
		).bind(Date.now(), id),
		env.DB.prepare("DELETE FROM items WHERE feed_id = ?").bind(id),
		env.DB.prepare("DELETE FROM feeds WHERE id = ?").bind(id),
	]);
	if (!del.meta.changes) throw new HttpError(404, "No such feed");
	return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Items

const ITEM_LIST_COLUMNS = `i.id, i.feed_id, f.title AS feed_title, i.title, i.link, i.author,
	i.published_at, i.created_at, i.read, i.saved, i.content IS NOT NULL AS has_content,
	i.media_url, i.media_type, i.media_pos, i.media_len, f.image_url AS feed_image,
	COALESCE(i.published_at, i.created_at) AS sort_at`;

async function listItems(env, url) {
	const sp = url.searchParams;
	const view = sp.get("view") || "unread";
	if (!VIEWS[view]) throw new HttpError(400, "view must be unread, saved, all, podcasts, or videos");
	const where = [VIEWS[view]];
	const params = [];
	// Podcast episodes and videos live in their own tabs (and their own feed), not in Unread or All.
	if ((view === "unread" || view === "all") && !sp.get("feed")) where.push("i.media_url IS NULL");
	if (sp.get("feed")) {
		where.push("i.feed_id = ?");
		params.push(toId(sp.get("feed")));
	}
	const tag = sp.get("tag");
	if (tag === "0") where.push("i.feed_id NOT IN (SELECT feed_id FROM feed_tags)");
	else if (tag) {
		where.push("i.feed_id IN (SELECT feed_id FROM feed_tags WHERE tag_id = ?)");
		params.push(toId(tag));
	}
	// Cursor is "<sort_at>_<id>" of the last item on the previous page.
	const before = sp.get("before");
	if (before) {
		const m = before.match(/^(\d+)_(\d+)$/);
		if (!m) throw new HttpError(400, "Bad before cursor");
		where.push(
			"(COALESCE(i.published_at, i.created_at) < ? OR (COALESCE(i.published_at, i.created_at) = ? AND i.id < ?))",
		);
		params.push(Number(m[1]), Number(m[1]), Number(m[2]));
	}
	const limit = clampInt(sp.get("limit"), 1, 200, 50);
	// Unread and All show each story once: its newest item that fits the
	// view, with the story's other items under it (related).
	const grouped = view === "unread" || view === "all";
	if (!grouped) {
		// Episodes carry the start of their show notes, for the list.
		const media = view === "podcasts" || view === "videos";
		const { results } = await env.DB.prepare(
			`SELECT ${ITEM_LIST_COLUMNS}${media ? ", substr(i.content, 1, 6000) AS notes" : ""} FROM items i JOIN feeds f ON f.id = i.feed_id
			WHERE ${where.join(" AND ")}
			ORDER BY COALESCE(i.published_at, i.created_at) DESC, i.id DESC LIMIT ?`,
		)
			.bind(...params, limit + 1)
			.all();
		if (media) for (const it of results) it.notes = notesPreview(it.notes);
		return itemPage(results, limit);
	}
	const cursor = before ? where.pop() : null;
	const { results } = await env.DB.prepare(
		`SELECT * FROM (
			SELECT ${ITEM_LIST_COLUMNS}, COALESCE(i.story_id, i.id) AS story,
				ROW_NUMBER() OVER (PARTITION BY COALESCE(i.story_id, i.id)
					ORDER BY COALESCE(i.published_at, i.created_at) DESC, i.id DESC) AS rn
			FROM items i JOIN feeds f ON f.id = i.feed_id
			WHERE ${where.join(" AND ")}
		) i WHERE rn = 1${cursor ? " AND " + cursor.replaceAll("COALESCE(i.published_at, i.created_at)", "i.sort_at") : ""}
		ORDER BY i.sort_at DESC, i.id DESC LIMIT ?`,
	)
		.bind(...params, limit + 1)
		.all();
	const stories = results.map((it) => it.story);
	if (stories.length) {
		const { results: rel } = await env.DB.prepare(
			`SELECT id, title, read, saved, story_id AS story FROM items
			WHERE story_id IN (SELECT value FROM json_each(?)) AND media_url IS NULL
			ORDER BY COALESCE(published_at, created_at) DESC, id DESC`,
		)
			.bind(JSON.stringify(stories))
			.all();
		const byStory = new Map();
		for (const r of rel) {
			if (!byStory.has(r.story)) byStory.set(r.story, []);
			byStory.get(r.story).push(r);
		}
		for (const it of results) it.related = (byStory.get(it.story) || []).filter((r) => r.id !== it.id).map(({ story, ...r }) => r);
	}
	for (const it of results) delete it.rn;
	return itemPage(results, limit);
}

// Show notes as a few hundred characters of plain text: tags dropped,
// paragraphs run together, the common entities turned back into characters.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
	rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
function notesPreview(html, max = 600) {
	if (!html) return null;
	const text = html
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<\/?(p|br|div|li|ul|ol|h\d|blockquote|tr|td)\b[^>]*>/gi, " ")
		.replace(/<[^>]*>?/g, "")
		.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e) => {
			if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
			const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
			return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
		})
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return null;
	if (text.length <= max) return text;
	const cut = text.slice(0, max), space = cut.lastIndexOf(" ");
	return (space > max * 0.7 ? cut.slice(0, space) : cut) + "…";
}

// The cards atop Unread and All. Nothing records when an episode was last
// played, so it's the newest one part-way through (the page prefers the one
// last played on this device).
async function continueCards(env) {
	const [episode, book, requests] = await Promise.all([
		env.DB.prepare(
			`SELECT ${ITEM_LIST_COLUMNS} FROM items i JOIN feeds f ON f.id = i.feed_id
			WHERE ${VIEWS.podcasts} AND i.media_pos > 5 AND i.media_len > 60 AND i.media_pos < i.media_len - 30
			ORDER BY COALESCE(i.published_at, i.created_at) DESC, i.id DESC LIMIT 1`,
		).first(),
		env.DB.prepare(
			`SELECT ${BOOK_COLUMNS} FROM books WHERE finished_at IS NULL AND last_opened_at IS NOT NULL AND ${NOT_AUDIOBOOK}
			ORDER BY last_opened_at DESC, id DESC LIMIT 1`,
		).first(),
		env.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE requested_at IS NOT NULL").first("n").catch(() => 0),
	]);
	return json({ episode: episode || null, book: book || null, requests: requests || 0 });
}

function itemPage(results, limit) {
	const items = results.slice(0, limit);
	const last = items[items.length - 1];
	return json({ items, next: results.length > limit ? `${last.sort_at}_${last.id}` : null });
}

async function getItem(env, id) {
	const item = await env.DB.prepare(
		`SELECT i.*, f.title AS feed_title, f.site_url, f.image_url AS feed_image FROM items i JOIN feeds f ON f.id = i.feed_id WHERE i.id = ?`,
	)
		.bind(id)
		.first();
	if (!item) throw new HttpError(404, "No such item");
	return json({ item });
}

// One feed's worth of items from a refresh. INSERT OR IGNORE on (feed_id,
// guid) means items already stored keep their read/saved state. Items are
// inserted oldest-last-in-the-list first, so undated items (scraped pages)
// still sort in the order the site shows them.
async function addItems(request, env) {
	const body = await readJSON(request);
	const feedId = toId(body.feed_id);
	if (!Array.isArray(body.items)) throw new HttpError(400, "items must be an array");
	const feed = await env.DB.prepare("SELECT id FROM feeds WHERE id = ?").bind(feedId).first();
	if (!feed) throw new HttpError(404, "No such feed");

	const now = Date.now();
	const seen = new Set();
	const clean = [];
	for (const raw of body.items.slice(0, MAX_ITEMS_PER_BATCH)) {
		const it = cleanItem(raw, now);
		if (!it || seen.has(it.guid)) continue;
		seen.add(it.guid);
		clean.push(it);
	}

	const insert = env.DB.prepare(
		`INSERT OR IGNORE INTO items (feed_id, guid, title, link, author, published_at, content, media_url, media_type, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const stmts = clean
		.slice()
		.reverse()
		.map((it) =>
			insert.bind(feedId, it.guid, it.title, it.link, it.author, it.published_at, it.content, it.media_url, it.media_type, now),
		);
	// Episodes stored before podcasts were a thing get their file now.
	const media = clean.filter((it) => it.media_url).map((it) => ({ g: it.guid, u: it.media_url, t: it.media_type }));
	if (media.length) {
		const find = "SELECT %s FROM json_each(?2) WHERE json_extract(value, '$.g') = items.guid";
		stmts.push(
			env.DB.prepare(
				`UPDATE items SET media_url = (${find.replace("%s", "json_extract(value, '$.u')")}),
				media_type = (${find.replace("%s", "json_extract(value, '$.t')")})
				WHERE feed_id = ?1 AND media_url IS NULL AND guid IN (SELECT json_extract(value, '$.g') FROM json_each(?2))`,
			).bind(feedId, JSON.stringify(media)),
		);
	}
	// Prune: unsaved items first seen over 90 days ago that the feed no longer
	// lists. (Ones it still lists would just come back as unread next time.)
	stmts.push(
		env.DB.prepare(
			`DELETE FROM items WHERE feed_id = ? AND saved = 0 AND created_at < ?
			AND guid NOT IN (SELECT value FROM json_each(?))`,
		).bind(feedId, now - PRUNE_AFTER_MS, JSON.stringify([...seen])),
	);
	// The feed's artwork (a podcast's cover), as the page found it.
	const image = httpUrl(body.image);
	stmts.push(
		image
			? env.DB.prepare("UPDATE feeds SET last_fetched_at = ?, image_url = ? WHERE id = ?").bind(now, image, feedId)
			: env.DB.prepare("UPDATE feeds SET last_fetched_at = ? WHERE id = ?").bind(now, feedId),
	);
	const results = await env.DB.batch(stmts);
	const inserted = results.slice(0, clean.length).reduce((n, r) => n + (r.meta?.changes || 0), 0);
	await groupStories(env, feedId, now);
	return json({ inserted, pruned: results[clean.length + (media.length ? 1 : 0)].meta?.changes || 0 });
}

// ---------------------------------------------------------------------------
// Stories. A site like AP posts several pieces on one story (the news, a
// live page, photos, a profile). After each refresh, the feed's items from
// the last few days are grouped by the words in their titles and link
// slugs, and each group shares items.story_id (the id of its first item),
// so the list shows it once and counts it as one. No AI: a word shared by
// only a few of the feed's recent items counts for more than one that's in
// many, and two items match when they share at least three words that add
// up to enough (STORY_MIN_SCORE). A group only takes in an item that
// matches its members on average, so one loose match can't chain two
// stories together. Only items in one feed are grouped, and never episodes
// or videos. Tuned on AP's homepage; a blog rarely has enough overlap to
// group anything.

const STORY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const STORY_MAX_ITEMS = 200;
const STORY_MIN_WORDS = 3;
const STORY_MIN_SCORE = 5;
const STORY_STOP = new Set(
	`a an and are as at be but by for from has have he her his how in into is it its of on or she so than that the their them
	they this to was were what when who why will with after about again against all also amid over says say said new more most
	not no up out off one two three first last just now then there these those our your you we us un st mr ms i my me do does
	did can could may might would should while which where here very some any other such only own same too via per vs week day
	days year years today yesterday tomorrow news latest live update updates video videos photo photos gallery explainer hub
	article january february march april june july august september october november december`.split(/\s+/),
);

function storyWords(text) {
	return (text || "")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/['\u2019]s\b/g, "")
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 1 && !/^\d+$/.test(w) && !STORY_STOP.has(w))
		.map((w) => (w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y" : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w));
}

// Title words count fully; words only in the link's slug (often a list of
// topic tags, like iran-us-israel-yemen) count half.
function storyTerms(it) {
	const terms = new Map();
	let slug = [];
	try {
		const last = new URL(it.link).pathname.split("/").filter(Boolean).pop() || "";
		slug = storyWords(last.replace(/-?[0-9a-f]{16,}$/, "").replace(/[-_]/g, " "));
	} catch {}
	if (slug.length >= 3) for (const w of slug) terms.set(w, 0.5);
	for (const w of storyWords(it.title)) terms.set(w, 1);
	return terms;
}

// Groups items ({id, title, link}); returns Map id -> story id (the group's
// smallest id), with items on their own left out.
function findStories(items) {
	const terms = items.map(storyTerms);
	const df = new Map();
	for (const t of terms) for (const w of t.keys()) df.set(w, (df.get(w) || 0) + 1);
	// Pair scores, only for pairs sharing a word (a word in every item says nothing).
	const byWord = new Map();
	terms.forEach((t, i) => {
		for (const w of t.keys()) if (df.get(w) > 1 && df.get(w) < items.length) (byWord.get(w) || byWord.set(w, []).get(w)).push(i);
	});
	const pair = new Map();
	for (const [w, list] of byWord) {
		const idf = Math.log(items.length / df.get(w));
		for (let a = 0; a < list.length; a++)
			for (let b = a + 1; b < list.length; b++) {
				const i = list[a], j = list[b], key = i * items.length + j;
				const p = pair.get(key) || { n: 0, score: 0 };
				p.n++;
				p.score += idf * Math.min(terms[i].get(w), terms[j].get(w));
				pair.set(key, p);
			}
	}
	// Average-linkage merging: groups[k] lists item indexes, and near[k]
	// maps each group linked to k to their summed score.
	const n = items.length;
	const groups = items.map((_, i) => [i]);
	const near = items.map(() => new Map());
	for (const [key, p] of pair) {
		if (p.n < STORY_MIN_WORDS) continue;
		const i = Math.floor(key / n), j = key % n;
		near[i].set(j, p.score);
		near[j].set(i, p.score);
	}
	for (;;) {
		let best = STORY_MIN_SCORE, ba = -1, bb = -1;
		near.forEach((m, a) => {
			for (const [b, sum] of m) {
				const avg = sum / (groups[a].length * groups[b].length);
				if (b > a && avg >= best) [best, ba, bb] = [avg, a, b];
			}
		});
		if (ba < 0) break;
		groups[ba] = groups[ba].concat(groups[bb]);
		groups[bb] = null;
		near[ba].delete(bb);
		for (const [c, sum] of near[bb]) {
			near[c].delete(bb);
			if (c === ba) continue;
			const total = (near[ba].get(c) || 0) + sum;
			near[ba].set(c, total);
			near[c].set(ba, total);
		}
		near[bb].clear();
	}
	const story = new Map();
	for (const g of groups) {
		if (!g || g.length < 2) continue;
		const ids = g.map((i) => items[i].id);
		const root = Math.min(...ids);
		for (const id of ids) story.set(id, root);
	}
	return story;
}

async function groupStories(env, feedId, now) {
	const { results } = await env.DB.prepare(
		`SELECT id, title, link, story_id FROM items
		WHERE feed_id = ? AND media_url IS NULL AND created_at >= ?
		ORDER BY id DESC LIMIT ?`,
	)
		.bind(feedId, now - STORY_WINDOW_MS, STORY_MAX_ITEMS)
		.all();
	if (results.length < 3) return;
	const story = findStories(results);
	const here = new Set(results.map((it) => it.id));
	const update = env.DB.prepare("UPDATE items SET story_id = ? WHERE id = ?");
	const stmts = [];
	for (const it of results) {
		const next = story.get(it.id) ?? null;
		// An item grouped with one that's since aged out of the window keeps its group.
		if (next === null && it.story_id != null && !here.has(it.story_id)) continue;
		if (next !== it.story_id) stmts.push(update.bind(next, it.id));
	}
	if (stmts.length) await env.DB.batch(stmts);
}

function cleanItem(raw, now) {
	if (!raw || typeof raw !== "object") return null;
	const link = httpUrl(raw.link);
	const guid = str(raw.guid, 2000) || link;
	if (!guid) return null;
	let published = typeof raw.published_at === "number" ? raw.published_at : Date.parse(raw.published_at ?? "");
	// Future dates would pin an item to the top forever.
	published = Number.isFinite(published) && published > 0 ? Math.min(Math.round(published), now) : null;
	let content = typeof raw.content === "string" && raw.content.trim() ? raw.content : null;
	if (content && content.length > MAX_CONTENT_CHARS) content = null;
	const mediaUrl = httpUrl(raw.media_url);
	const mediaType = mediaUrl && typeof raw.media_type === "string" && MEDIA_TYPE.test(raw.media_type) ? raw.media_type.toLowerCase() : null;
	return {
		guid, link, title: str(raw.title, 1000) || "", author: str(raw.author, 300), published_at: published, content,
		media_url: mediaUrl, media_type: mediaUrl ? mediaType || "audio/mpeg" : null,
	};
}

async function updateItem(request, env, id) {
	const body = await readJSON(request);
	const sets = [];
	const params = [];
	if (body.saved !== undefined) {
		sets.push("saved = ?");
		params.push(body.saved ? 1 : 0);
	}
	for (const key of ["media_pos", "media_len"]) {
		if (body[key] === undefined) continue;
		const v = body[key];
		if (v !== null && !(typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e6)) throw new HttpError(400, `${key} must be seconds`);
		sets.push(`${key} = ?`);
		params.push(v);
	}
	if (body.content !== undefined) {
		if (body.content !== null && typeof body.content !== "string") throw new HttpError(400, "content must be a string");
		if (body.content && body.content.length > MAX_CONTENT_CHARS) throw new HttpError(413, "content is too long");
		sets.push("content = ?");
		params.push(body.content || null);
	}
	if (!sets.length && body.read === undefined) throw new HttpError(400, "Nothing to change");
	const stmts = [];
	if (sets.length) stmts.push(env.DB.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`).bind(...params, id));
	// A story counts as one entry, so reading one of its items reads them all.
	if (body.read !== undefined)
		stmts.push(
			env.DB.prepare(
				`UPDATE items SET read = ? WHERE id = ?2 OR story_id = (SELECT story_id FROM items WHERE id = ?2)`,
			).bind(body.read ? 1 : 0, id),
		);
	const res = await env.DB.batch(stmts);
	if (!res.some((r) => r.meta.changes)) {
		if (!(await env.DB.prepare("SELECT 1 FROM items WHERE id = ?").bind(id).first())) throw new HttpError(404, "No such item");
	}
	return json({ ok: true });
}

async function markRead(request, env) {
	const body = await readJSON(request);
	if (body.ids !== undefined) {
		if (!Array.isArray(body.ids) || body.ids.length > 500) throw new HttpError(400, "ids must be a list of up to 500 item ids");
		const ids = JSON.stringify(body.ids.map(toId));
		// One bound list (D1 allows 100 parameters), and each item's whole story with it.
		const res = await env.DB.prepare(
			`UPDATE items SET read = 1 WHERE read = 0 AND (id IN (SELECT value FROM json_each(?1))
				OR story_id IN (SELECT story_id FROM items WHERE id IN (SELECT value FROM json_each(?1)) AND story_id IS NOT NULL))`,
		)
			.bind(ids)
			.run();
		return json({ marked: res.meta.changes });
	}
	let sql = "UPDATE items SET read = 1 WHERE read = 0";
	if (body.feed == null) sql += " AND media_url IS NULL";
	const params = [];
	if (body.feed != null) {
		sql += " AND feed_id = ?";
		params.push(toId(body.feed));
	} else if (body.tag === 0 || body.tag === "0") {
		sql += " AND feed_id NOT IN (SELECT feed_id FROM feed_tags)";
	} else if (body.tag != null) {
		sql += " AND feed_id IN (SELECT feed_id FROM feed_tags WHERE tag_id = ?)";
		params.push(toId(body.tag));
	}
	const res = await env.DB.prepare(sql)
		.bind(...params)
		.run();
	return json({ marked: res.meta.changes });
}

// ---------------------------------------------------------------------------
// Coverage: the same story from several feeds, compared on request. Opening
// an article asks GET /api/items/:id/coverage, which finds the best match in
// each other feed from the two days either side of it, by the same title and
// slug words as the story grouping above (plus the start of each item's
// text, at a lower weight, since two outlets rarely word a headline alike).
// No AI and nothing stored for that part.
//
// "Compare coverage" (POST) is the one step that uses AI: the page sends
// each article's full text (it already fetches and extracts articles for
// reading; feeds that only send a teaser get the page fetched), and the
// Worker asks a model for a digest: what the sources agree on, then what each
// says that the others don't. Every one of those bullets must quote its
// source word for word; a bullet whose quote isn't in that source's text is
// dropped here, never shown, and the digest says how many were. The digest
// is kept in the coverage table, so opening it again (from any of its
// articles) costs nothing; when a new source turns up, the page offers to
// compare again.
//
// The model is Llama 3.3 70B on Cloudflare Workers AI, through the AI
// binding: no other account or key, and the free 10,000 Neurons a day cover
// ten to twenty comparisons (one is roughly 500 to 1,000 Neurons).
// Its window is 24,000 tokens, so the articles share COVERAGE_AI_CHARS
// between them and a longer one is cut (and marked as an excerpt). Without
// the binding, an ANTHROPIC_API_KEY secret compares with Claude instead
// (better at this, billed by Anthropic). With neither, matching still works
// and the button says what to add.

const COVERAGE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const COVERAGE_POOL = 1500;
const COVERAGE_MAX_SOURCES = 6;
const COVERAGE_MIN_WORDS = 3;
const COVERAGE_MIN_SCORE = 6;
const COVERAGE_MAX_CHARS = 30000;
const COVERAGE_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const COVERAGE_AI_CHARS = 56000;
const COVERAGE_CLAUDE_MODEL = "claude-opus-5-5";

// Title and slug words as storyTerms has them, plus words from the start of
// the text at a quarter weight.
function coverageTerms(it) {
	const terms = storyTerms(it);
	for (const w of storyWords(notesPreview(it.excerpt, 500))) if (!terms.has(w)) terms.set(w, 0.25);
	return terms;
}

// The best match in each other feed for target (both {id, feed_id, title,
// link, excerpt}), from pool (which may include target), best first.
function findCoverage(target, pool) {
	const terms = new Map(pool.map((it) => [it.id, coverageTerms(it)]));
	if (!terms.has(target.id)) terms.set(target.id, coverageTerms(target));
	const df = new Map();
	for (const t of terms.values()) for (const w of t.keys()) df.set(w, (df.get(w) || 0) + 1);
	const n = terms.size;
	const mine = terms.get(target.id);
	const best = new Map();
	for (const it of pool) {
		if (it.feed_id === target.feed_id) continue;
		const theirs = terms.get(it.id);
		let shared = 0, score = 0;
		for (const [w, a] of mine) {
			const b = theirs.get(w);
			if (b === undefined || df.get(w) >= n) continue;
			// Title words have to carry it: a word only in both excerpts counts, but not toward the three.
			if (Math.max(a, b) >= 0.5) shared++;
			score += Math.log(n / df.get(w)) * Math.min(a, b);
		}
		if (shared < COVERAGE_MIN_WORDS || score < COVERAGE_MIN_SCORE) continue;
		const prev = best.get(it.feed_id);
		if (!prev || score > prev.score) best.set(it.feed_id, { id: it.id, score });
	}
	return [...best.values()].sort((a, b) => b.score - a.score).slice(0, COVERAGE_MAX_SOURCES - 1);
}

const COVERAGE_SOURCE_COLUMNS = `i.id, i.feed_id, i.story_id, i.read, f.title AS feed_title, i.title, i.link,
	COALESCE(i.published_at, i.created_at) AS sort_at`;

async function coverageSources(env, id) {
	const target = await env.DB.prepare(
		`SELECT id, feed_id, title, link, substr(content, 1, 3000) AS excerpt, COALESCE(published_at, created_at) AS at
		FROM items WHERE id = ? AND media_url IS NULL`,
	)
		.bind(id)
		.first();
	if (!target) throw new HttpError(404, "No such article");
	const { results: pool } = await env.DB.prepare(
		`SELECT id, feed_id, title, link, substr(content, 1, 3000) AS excerpt FROM items
		WHERE media_url IS NULL AND COALESCE(published_at, created_at) BETWEEN ? AND ?
		ORDER BY id DESC LIMIT ?`,
	)
		.bind(target.at - COVERAGE_WINDOW_MS, target.at + COVERAGE_WINDOW_MS, COVERAGE_POOL)
		.all();
	const ids = [id, ...findCoverage(target, pool).map((m) => m.id)];
	if (ids.length < 2) return [];
	const { results } = await env.DB.prepare(
		`SELECT ${COVERAGE_SOURCE_COLUMNS} FROM items i JOIN feeds f ON f.id = i.feed_id
		WHERE i.id IN (SELECT value FROM json_each(?))`,
	)
		.bind(JSON.stringify(ids))
		.all();
	return ids.map((x) => results.find((r) => r.id === x)).filter(Boolean);
}

// The newest digest that covers this item (from any of its articles).
async function storedDigest(env, id) {
	const row = await env.DB.prepare(
		`SELECT * FROM coverage WHERE EXISTS (SELECT 1 FROM json_each(coverage.item_ids) WHERE value = ?)
		ORDER BY created_at DESC, id DESC LIMIT 1`,
	)
		.bind(id)
		.first();
	if (!row) return null;
	return { ...JSON.parse(row.digest), item_ids: JSON.parse(row.item_ids), model: row.model, created_at: row.created_at };
}

async function getCoverage(env, id) {
	const [sources, digest] = await Promise.all([coverageSources(env, id), storedDigest(env, id)]);
	const covered = new Set(digest ? digest.item_ids : []);
	return json({
		sources,
		digest,
		new_sources: digest ? sources.filter((s) => !covered.has(s.id)).length : 0,
		enabled: !!(env.AI || env.ANTHROPIC_API_KEY),
	});
}

// {sources: [{id, text, partial}]} -> {digest}. The ids are the article and
// the matches GET found for it; the texts are what the page extracted, and
// partial marks one where only the feed's teaser was to be had (a paywall,
// or the page couldn't be fetched).
async function compareCoverage(request, env, id) {
	if (!env.AI && !env.ANTHROPIC_API_KEY)
		throw new HttpError(501, "Comparing needs Workers AI: add a Workers AI binding named AI to this Worker (Settings, Bindings).");
	const body = await readJSON(request);
	if (!Array.isArray(body.sources)) throw new HttpError(400, "sources must be an array");
	const sent = new Map();
	for (const s of body.sources.slice(0, COVERAGE_MAX_SOURCES)) {
		const text = typeof s?.text === "string" ? s.text.replace(/\s+\n/g, "\n").trim().slice(0, COVERAGE_MAX_CHARS) : "";
		if (text) sent.set(toId(s.id), { text, partial: s.partial === true });
	}
	if (!sent.has(id)) throw new HttpError(400, "The article itself has no text to compare");
	// Not re-matched here: saving a fetched article can change what matches,
	// and the page compares what it showed. Articles only, one per feed.
	const { results } = await env.DB.prepare(
		`SELECT ${COVERAGE_SOURCE_COLUMNS} FROM items i JOIN feeds f ON f.id = i.feed_id
		WHERE i.id IN (SELECT value FROM json_each(?)) AND i.media_url IS NULL`,
	)
		.bind(JSON.stringify([...sent.keys()]))
		.all();
	const feeds = new Set();
	const sources = [id, ...[...sent.keys()].filter((x) => x !== id)]
		.map((x) => results.find((r) => r.id === x))
		.filter((s) => s && !feeds.has(s.feed_id) && feeds.add(s.feed_id))
		.map((s) => ({ ...s, ...sent.get(s.id) }));
	if (sources.length < 2) throw new HttpError(400, "There's only one source with text to compare");
	const { answer, model } = env.AI ? await askWorkersAI(env, sources) : await askClaude(env, sources);
	const digest = checkDigest(answer, sources);
	const itemIds = sources.map((s) => s.id);
	const now = Date.now();
	// Digests go when their articles would (90 days).
	await env.DB.batch([
		env.DB.prepare("DELETE FROM coverage WHERE created_at < ?").bind(now - PRUNE_AFTER_MS),
		env.DB.prepare(`INSERT INTO coverage (item_id, item_ids, digest, model, created_at) VALUES (?, ?, ?, ?, ?)`)
			.bind(id, JSON.stringify(itemIds), JSON.stringify(digest), model, now),
	]);
	return json({ digest: { ...digest, item_ids: itemIds, model, created_at: now } });
}

const COVERAGE_SYSTEM = `You compare news coverage of one story from several outlets for a reader who wants to see where the outlets agree and where they differ. You get each outlet's article, numbered as a source.

Rules:
- Use only what the articles say. Add no background, no context from memory, and no judgment of which outlet is right.
- First decide which sources are about the same story as source 1 (the one being read). Put the others in "excluded" with a short reason, and leave them out of everything else.
- "summary": two to five sentences, as separate entries, stating only facts that at least two included sources report. List every source that reports each fact.
- "perspectives": what one source says that the others don't. Two kinds: "differs" when it contradicts or frames a shared fact differently (a different number, cause, emphasis, or a characterization the others don't make), and "only" when it reports a detail no other included source has. Write each in plain words, naming nothing but what that source says.
- Every perspective needs "quote": a passage copied character for character from that source's text, 8 to 40 words, that backs it up. Don't fix typos, change punctuation, or join pieces of separate sentences. If you can't quote it, leave the point out.
- A source marked excerpt="yes" has only part of its article. Never treat it as leaving something out, and don't write "only" points about what the others have that it lacks.
- Compare only the story itself. Ignore anything else on the page: lists or teasers of other stories ("Previously", "Related", "Read more"), newsletter or subscription pitches, ads, comments. Never make a point from them.
- Skip trivia: bylines, photo credits, "this story has been updated". Aim for the points a careful reader would want, at most four per source.
- If the included sources are effectively the same report (one outlet republishing another's wire copy), say so in "note" and keep "perspectives" short.`;

const COVERAGE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["headline", "excluded", "summary", "perspectives", "note"],
	properties: {
		headline: { type: "string", description: "A plain, neutral headline for the story." },
		excluded: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["source", "reason"],
				properties: { source: { type: "integer" }, reason: { type: "string" } },
			},
		},
		summary: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["text", "sources"],
				properties: { text: { type: "string" }, sources: { type: "array", items: { type: "integer" } } },
			},
		},
		perspectives: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["source", "kind", "text", "quote"],
				properties: {
					source: { type: "integer" },
					kind: { type: "string", enum: ["differs", "only"] },
					text: { type: "string" },
					quote: { type: "string" },
				},
			},
		},
		note: { type: "string", description: "Anything the reader should know about the comparison itself; empty if nothing." },
	},
};

// The articles as the prompt has them. max: characters per article, past
// which it's cut and marked as an excerpt like a paywalled one.
function coverageDocs(sources, max = Infinity) {
	const docs = sources
		.map((s, i) => {
			const text = s.text.length > max ? s.text.slice(0, max) : s.text;
			const partial = s.partial || text.length < s.text.length ? ' excerpt="yes"' : "";
			return `<source number="${i + 1}" outlet="${attr(s.feed_title)}"${partial}>\n<headline>${s.title}</headline>\n${text}\n</source>`;
		})
		.join("\n\n");
	return `${docs}\n\nCompare how these sources cover the story in source 1.`;
}

async function askWorkersAI(env, sources) {
	let out;
	try {
		out = await env.AI.run(COVERAGE_AI_MODEL, {
			messages: [
				{ role: "system", content: COVERAGE_SYSTEM },
				{ role: "user", content: coverageDocs(sources, Math.floor(COVERAGE_AI_CHARS / sources.length)) },
			],
			response_format: { type: "json_schema", json_schema: COVERAGE_SCHEMA },
			max_tokens: 3000,
			temperature: 0.2,
		});
	} catch (err) {
		const msg = String(err?.message || err);
		if (/neuron|limit|quota|429/i.test(msg)) throw new HttpError(429, "Today's free Workers AI allowance is used up. It resets at midnight UTC.");
		if (/JSON Mode couldn't be met/i.test(msg)) throw new HttpError(502, "The model couldn't put its answer in the right shape. Try again.");
		throw new HttpError(502, `Workers AI failed: ${msg}`);
	}
	let answer = out?.response;
	if (typeof answer === "string") {
		try {
			answer = JSON.parse(answer);
		} catch {
			throw new HttpError(502, "The model's answer wasn't readable. Try again.");
		}
	}
	if (!answer || typeof answer !== "object") throw new HttpError(502, "The model gave no answer. Try again.");
	return { answer, model: COVERAGE_AI_MODEL.replace(/^@cf\/[^/]+\//, "") };
}

function askClaude(env, sources) {
	return claudeJSON(env, { model: COVERAGE_CLAUDE_MODEL, maxTokens: 16000, effort: "medium", schema: COVERAGE_SCHEMA, system: COVERAGE_SYSTEM, user: coverageDocs(sources) })
		.then((answer) => ({ answer, model: COVERAGE_CLAUDE_MODEL }));
}

// One answer from Claude in the shape of a JSON schema (structured
// outputs), for the coverage digest and the appeal terms. -> the answer,
// parsed; an HttpError saying what went wrong otherwise.
async function claudeJSON(env, { model, maxTokens, effort, schema, system, user }) {
	let res;
	try {
		res = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": env.ANTHROPIC_API_KEY.trim(),
				"anthropic-version": "2023-06-01",
				// If a safety check declines, the API retries on another model by itself.
				"anthropic-beta": "server-side-fallback-2026-07-01",
			},
			body: JSON.stringify({
				model,
				max_tokens: maxTokens,
				fallbacks: "default",
				thinking: { type: "adaptive" },
				output_config: { effort, format: { type: "json_schema", schema } },
				system,
				messages: [{ role: "user", content: user }],
			}),
		});
	} catch (err) {
		throw new HttpError(502, `Couldn't reach the Anthropic API: ${err?.message || err}`);
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new HttpError(502, `The Anthropic API answered ${res.status}: ${data.error?.message || "no details"}`);
	if (data.stop_reason === "refusal") throw new HttpError(502, "The model declined to answer.");
	if (data.stop_reason === "max_tokens") throw new HttpError(502, "The model's answer ran too long and was cut off. Try again.");
	const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
	try {
		return JSON.parse(text);
	} catch {
		throw new HttpError(502, "The model's answer wasn't readable. Try again.");
	}
}

function attr(s) { return String(s || "").replace(/[<>"&]/g, " "); }

// Keeps only what holds up: sources that exist, summary points backed by two
// of them, and perspectives whose quote really is in that source's text.
// Source numbers become item ids, and each kept quote gets a link to the
// passage itself (a text fragment, which most browsers scroll to and mark).
function checkDigest(answer, sources) {
	const bySource = (n) => (Number.isInteger(n) && n >= 1 && n <= sources.length ? sources[n - 1] : null);
	const excluded = [];
	for (const e of Array.isArray(answer.excluded) ? answer.excluded : []) {
		const s = bySource(e?.source);
		if (s && s !== sources[0] && !excluded.some((x) => x.id === s.id)) excluded.push({ id: s.id, reason: str(e.reason, 300) || "" });
	}
	const out = new Set(excluded.map((e) => e.id));
	const included = (n) => { const s = bySource(n); return s && !out.has(s.id) ? s : null; };
	const summary = [];
	for (const p of Array.isArray(answer.summary) ? answer.summary : []) {
		const ids = [...new Set((Array.isArray(p?.sources) ? p.sources : []).map(included).filter(Boolean).map((s) => s.id))];
		const text = str(p?.text, 1000);
		if (text && ids.length >= 2) summary.push({ text, sources: ids });
	}
	const perspectives = [];
	let dropped = 0;
	for (const p of Array.isArray(answer.perspectives) ? answer.perspectives : []) {
		const s = included(p?.source);
		const text = str(p?.text, 1000), quote = str(p?.quote, 1000);
		if (!s || !text || !quote || (p.kind !== "differs" && p.kind !== "only")) { dropped++; continue; }
		const exact = findQuote(s.text, quote);
		if (!exact) { dropped++; continue; }
		perspectives.push({ source: s.id, kind: p.kind, text, quote: exact, link: s.link ? s.link.split("#")[0] + textFragment(exact) : null });
	}
	return {
		headline: str(answer.headline, 300) || sources[0].title,
		summary,
		perspectives,
		excluded,
		note: str(answer.note, 1000) || "",
		dropped,
		// Names and links as they were, so the digest reads the same after an article is pruned.
		articles: sources.map((s) => ({ id: s.id, feed_title: s.feed_title, title: s.title, link: s.link })),
		partial: sources.filter((s) => s.partial).map((s) => s.id),
	};
}

// Quotes are matched ignoring case, spacing, and curly-vs-straight quotes and
// dashes; what's returned is the source's own wording.
function foldQuote(s) {
	return s.replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[–—−]/g, "-")
		.replace(/ /g, " ").toLowerCase();
}
function findQuote(text, quote) {
	// Fold both, keeping a map from each folded, space-collapsed character back to the original.
	const map = [];
	let folded = "";
	const src = foldQuote(text);
	for (let i = 0; i < src.length; i++) {
		if (/\s/.test(src[i])) {
			if (folded.endsWith(" ") || !folded) continue;
			folded += " ";
		} else folded += src[i];
		map.push(i);
	}
	const q = foldQuote(quote).replace(/\s+/g, " ").trim().replace(/^["'….]+|["'…]+$/g, "").trim();
	if (q.split(" ").length < 4) return null;
	const at = folded.indexOf(q);
	if (at < 0) return null;
	return text.slice(map[at], map[at + q.length - 1] + 1);
}

// #:~:text=start,end for a long passage (the first and last few words), or
// the whole thing when it's short. Commas, dashes and ampersands must be escaped.
function textFragment(quote) {
	const enc = (s) => encodeURIComponent(s).replace(/-/g, "%2D").replace(/,/g, "%2C");
	const words = quote.split(/\s+/);
	if (words.length <= 10) return "#:~:text=" + enc(quote);
	return "#:~:text=" + enc(words.slice(0, 5).join(" ")) + "," + enc(words.slice(-5).join(" "));
}

// ---------------------------------------------------------------------------
// Newsletters by email. Cloudflare Email Routing hands mail for the routed
// address to email() above. Each sender (the From address) gets a feed of its
// own, with feeds.email set to its key and nothing to refresh, and each
// message becomes one of its items. The key is the From address, except for
// Patreon, which sends every creator's posts from one address: there it's
// "patreon:<creator>", one feed per creator (see patreonSource). The HTML is
// stored as sent; the page sanitizes it on open like any other article. Mail
// for a blocked key (email_blocked, filled by removing that feed) is dropped.
//
// There's no MIME library because the dashboard editor takes one file, so
// the parser below covers what newsletters send: nested multipart, base64,
// quoted-printable, charsets, and encoded-word headers.

async function receiveEmail(message, env) {
	if (message.rawSize > MAX_EMAIL_BYTES) return message.setReject("Message too large");
	const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
	const mail = parseEmail(raw);
	const from = parseAddress(mail.headers.from) || parseAddress(message.from);
	if (!from) return;
	const src = patreonSource(mail, from) || {
		key: from.address,
		title: from.name || from.address,
		url: "mailto:" + from.address,
		author: from.name,
		link: null,
	};
	const blocked = await env.DB.prepare("SELECT 1 FROM email_blocked WHERE address = ?").bind(src.key).first();
	if (blocked) return;

	const now = Date.now();
	await env.DB.prepare(
		`INSERT OR IGNORE INTO feeds (url, mode, title, email, created_at) VALUES (?, 'scrape', ?, ?, ?)`,
	)
		.bind(src.url, src.title, src.key, now)
		.run();
	const feed = await env.DB.prepare("SELECT id FROM feeds WHERE email = ?").bind(src.key).first();

	const messageId = str(headerText(mail.headers["message-id"]), 2000);
	const guid = messageId || "sha256:" + (await sha256Hex(raw));
	let published = Date.parse(mail.headers.date || "");
	published = Number.isFinite(published) && published > 0 ? Math.min(published, now) : now;
	const listPost = (mail.headers["list-post"] || "").match(/<(https?:[^>]+)>/);

	await env.DB.batch([
		env.DB.prepare(
			`INSERT OR IGNORE INTO items (feed_id, guid, title, link, author, published_at, content, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			feed.id,
			guid,
			str(headerText(mail.headers.subject), 1000) || "",
			src.link || (listPost ? httpUrl(listPost[1]) : null),
			src.author,
			published,
			emailContent(mail.html, mail.text),
			now,
		),
		// Same 90 days as feeds, minus the "still listed" part: mail is never re-listed.
		env.DB.prepare("DELETE FROM items WHERE feed_id = ? AND saved = 0 AND created_at < ?").bind(
			feed.id,
			now - PRUNE_AFTER_MS,
		),
		env.DB.prepare("UPDATE feeds SET last_fetched_at = ? WHERE id = ?").bind(now, feed.id),
	]);
}

// Patreon mail -> {key, title, url, author, link} for its creator, else null.
// It counts as Patreon when it comes from patreon.com, or, once forwarded
// (a Proton filter, say, which may put its own address in From), when the
// headers still carry Patreon's DKIM signature or unsubscribe link. The
// feed is keyed by the first www.patreon.com/<creator> link in the body, and
// named from, in order: the From name ("Jane Doe via Patreon"), the subject
// ("Jane Doe just shared ...", "New post from Jane Doe"), or that link. None
// of those -> one shared "Patreon" feed. This is from Patreon's usual formats, not a spec; add a
// pattern here if a creator's mail lands in the shared feed.
const PATREON_NOT_CREATOR =
	/^(posts?|home|c|cw|m|u|user|join|checkout|login|signup|settings|notifications|messages|membership|memberships|pledges|library|explore|search|policy|policies|legal|privacy|terms|help|about|api|file|media|apps|download|email|emails|unsubscribe|manage|account|create|creators|product|shop|collection|l|oauth2|track)$/i;

function patreonSource(mail, from) {
	const fromPatreon = /(^|\.)patreon\.com$/.test(from.address.split("@")[1] || "");
	const head = mail.head || "";
	if (
		!fromPatreon &&
		!/^dkim-signature:[^\n]*(\n[ \t][^\n]*)*\bd=(\w+\.)*patreon\.com\b/im.test(head) &&
		!/^list-unsubscribe:[^\n]*(\n[ \t][^\n]*)*patreon\.com/im.test(head)
	) {
		return null;
	}
	const body = (mail.html || "") + "\n" + (mail.text || "");
	const subject = headerText(mail.headers.subject);
	let name = null;
	if (fromPatreon && from.name) {
		const n = from.name.replace(/\s*(?:\(via Patreon\)|via Patreon|on Patreon|\|\s*Patreon)\s*$/i, "").trim();
		if (n && !/^patreon$/i.test(n)) name = n;
	}
	if (!name) {
		const m =
			subject.match(/^(.+?)\s+(?:just\s+)?(?:shared|posted|published|released|uploaded)\b/i) ||
			subject.match(/^new (?:post|update|video|audio|message) from\s+(.+?)\s*(?:[:|\-\u2013\u2014]|$)/i) ||
			subject.match(/^(.+?)\s+on Patreon\s*[:|\-\u2013\u2014]/i);
		if (m && m[1].length <= 80) name = m[1].trim();
	}
	let vanity = null;
	// www.patreon.com only: tracking hosts (click.patreon.com/ls/...) aren't creators.
	const re = /(?<![\w.-])(?:www\.)?patreon\.com\/(?:c\/)?([A-Za-z0-9_-]{2,64})(?=[\/?#"'\s<]|$)/g;
	for (let m; (m = re.exec(body)); ) {
		if (!PATREON_NOT_CREATOR.test(m[1])) {
			vanity = m[1];
			break;
		}
	}
	const post = body.match(/https:\/\/(?:www\.)?patreon\.com\/posts\/[A-Za-z0-9_-]+/);
	const title = str(name || vanity, 300) || "Patreon";
	// The creator's page name is the stable part; display names can change.
	const slug = (vanity || title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
	return {
		key: slug && title !== "Patreon" ? "patreon:" + slug : "patreon",
		title,
		url: vanity ? "https://www.patreon.com/" + vanity : "https://www.patreon.com/",
		author: name || vanity,
		link: post ? post[0] : null,
	};
}

// -> {head (top-level header block, raw), headers (top level, raw values,
// lower-case names), html, text}; html and text are the first of each found,
// attachments skipped.
function parseEmail(bytes) {
	const mail = { head: null, headers: null, html: null, text: null };
	mail.headers = walkPart(binaryString(bytes), mail, 0);
	return mail;
}

function walkPart(s, mail, depth) {
	const split = s.search(/\r?\n\r?\n/);
	const head = split < 0 ? s : s.slice(0, split);
	const body = split < 0 ? "" : s.slice(split).replace(/^\r?\n\r?\n/, "");
	if (depth === 0) mail.head = head.replace(/\r\n/g, "\n");
	const headers = {};
	for (const line of head.replace(/\r?\n(?=[ \t])/g, "").split(/\r?\n/)) {
		const i = line.indexOf(":");
		if (i <= 0) continue;
		const name = line.slice(0, i).trim().toLowerCase();
		if (!(name in headers)) headers[name] = line.slice(i + 1).trim();
	}
	const { type, params } = contentType(headers["content-type"]);
	if (type.startsWith("multipart/")) {
		if (params.boundary && depth < 10) {
			for (const part of multipartParts(body, params.boundary)) walkPart(part, mail, depth + 1);
		}
	} else if (!/^\s*attachment/i.test(headers["content-disposition"] || "")) {
		const key = type === "text/html" ? "html" : type === "text/plain" ? "text" : null;
		if (key && mail[key] == null) {
			mail[key] = decodeBytes(transferDecode(body, headers["content-transfer-encoding"]), params.charset);
		}
	}
	return headers;
}

function contentType(v) {
	const [type, ...rest] = (v || "text/plain").split(";");
	const params = {};
	for (const p of rest) {
		const m = p.match(/^\s*([^=\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]*))/);
		if (m) params[m[1].toLowerCase()] = m[2] != null ? m[2].replace(/\\(.)/g, "$1") : m[3];
	}
	return { type: type.trim().toLowerCase(), params };
}

function multipartParts(body, boundary) {
	const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp("(?:^|\\r?\\n)--" + esc + "(--)?[ \\t]*(?:\\r?\\n|$)", "g");
	const parts = [];
	let start = -1;
	let m;
	while ((m = re.exec(body))) {
		if (start >= 0) parts.push(body.slice(start, m.index));
		if (m[1]) return parts;
		start = re.lastIndex;
	}
	if (start >= 0 && start < body.length) parts.push(body.slice(start)); // no closing boundary
	return parts;
}

// Strings here hold one byte per character until decodeBytes() applies the
// charset.
function transferDecode(body, encoding) {
	const enc = (encoding || "").trim().toLowerCase();
	if (enc === "base64") return base64Bytes(body);
	if (enc === "quoted-printable") {
		return body
			.replace(/[ \t]+(?=\r?\n|$)/g, "")
			.replace(/=\r?\n/g, "")
			.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
	}
	return body;
}

function base64Bytes(s) {
	let b = s.replace(/[^A-Za-z0-9+/]/g, "");
	if (b.length % 4 === 1) b = b.slice(0, -1);
	try {
		return atob(b);
	} catch {
		return "";
	}
}

function binaryString(bytes) {
	let s = "";
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return s;
}

function decodeBytes(bin, charset) {
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	try {
		return new TextDecoder((charset || "utf-8").trim()).decode(bytes);
	} catch {
		return new TextDecoder().decode(bytes);
	}
}

// A header value -> text: raw UTF-8 allowed (RFC 6532), and =?charset?B|Q?...?=
// encoded words (RFC 2047), with the space between two of them dropped.
function headerText(v) {
	if (!v) return "";
	return decodeBytes(v, "utf-8").replace(
		/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=(?:\s+(?==\?[^?\s]+\?[BbQq]\?))?/g,
		(_, charset, enc, text) =>
			decodeBytes(
				/b/i.test(enc)
					? base64Bytes(text)
					: text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
				charset.replace(/\*.*$/, ""),
			),
	);
}

// "Joe Hill" <joe@example.com> | joe@example.com (Joe) | joe@example.com
function parseAddress(v) {
	const s = headerText(v);
	const angle = s.match(/<\s*([^<>\s@]+@[^<>\s@]+)\s*>/);
	const m = angle || s.match(/[^\s<>"(),;:]+@[^\s<>"(),;:]+/);
	if (!m) return null;
	const address = (angle ? m[1] : m[0]).toLowerCase().slice(0, 300);
	const name = angle
		? s.slice(0, angle.index).trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1")
		: (s.match(/\(([^)]*)\)/) || [])[1];
	return { address, name: str(name, 300) };
}

// The HTML part without what the sanitizer would drop anyway (newsletters
// carry big <style> blocks), else the text part as simple paragraphs.
function emailContent(html, text) {
	if (html) {
		const c = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(head|style|script)\b[\s\S]*?<\/\1\s*>/gi, "");
		if (c.trim() && c.length <= MAX_CONTENT_CHARS) return c;
	}
	if (text && text.trim()) return textToHTML(text.slice(0, MAX_CONTENT_CHARS / 2));
	return null;
}

function textToHTML(text) {
	const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	return text
		.replace(/\r\n?/g, "\n")
		.split(/\n\s*\n/)
		.filter((p) => p.trim())
		.map((p) => "<p>" + esc(p.trim()).replace(/https?:\/\/[^\s<>"]+/g, '<a href="$&">$&</a>').replace(/\n/g, "<br>") + "</p>")
		.join("\n");
}

async function sha256Hex(bytes) {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Books

async function listBooks(env) {
	const { results } = await env.DB.prepare(
		`SELECT ${BOOK_COLUMNS}, (SELECT json_group_array(t.tag_id) FROM book_tag_links t WHERE t.book_id = books.id) AS tags, r2_key
		FROM books WHERE gone_at IS NULL ORDER BY COALESCE(last_opened_at, created_at) DESC, id DESC`,
	).all();
	const covers = await coverStates(env, new Map(results.map((b) => [b.id, b.r2_key])));
	for (const b of results) {
		b.tags = JSON.parse(b.tags || "[]");
		b.cover = covers.get(b.id) || null;
	}
	for (const b of results) delete b.r2_key;
	return json({ books: results });
}

function uploadName(url) {
	const filename = (url.searchParams.get("name") || "").split(/[\\/]/).pop().trim().slice(0, 300);
	const dot = filename.lastIndexOf(".");
	const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
	if (!BOOK_TYPES[ext]) throw new HttpError(415, "Only .txt, .pdf, .cbz and .epub files");
	return { filename, ext };
}
async function uploadTagsOf(env, url) {
	const tagParam = url.searchParams.get("tag");
	return tagParam ? await tagRefs(env, [tagParam], TAGS.books) : [];
}
async function uploadBook(request, env, url) {
	const { filename, ext } = uploadName(url);
	const uploadTags = await uploadTagsOf(env, url);

	const length = Number(request.headers.get("Content-Length"));
	if (length > MAX_BOOK_BYTES) throw new HttpError(413, "File too large (95 MB max)");
	// Stream straight into R2 when the length is known; buffer otherwise.
	let body = request.body;
	if (!(length > 0)) {
		body = await request.arrayBuffer();
		if (!body.byteLength) throw new HttpError(400, "Empty file");
		if (body.byteLength > MAX_BOOK_BYTES) throw new HttpError(413, "File too large (95 MB max)");
	}

	const key = `books/${crypto.randomUUID()}.${ext}`;
	const obj = await env.BOOKS.put(key, body, { httpMetadata: { contentType: BOOK_TYPES[ext] } });
	return addBookFile(env, filename, ext, key, obj.size, uploadTags);
}

// A file over 95 MB (a Worker takes at most 100 MB a request) goes up in
// pieces, as an R2 multipart upload: started, sent a piece at a time, then
// put together and added like any other upload.
const UPLOAD_PART_BYTES = 50 * 1024 * 1024;
function uploadRef(url) {
	const key = url.searchParams.get("key") || "", uploadId = url.searchParams.get("upload_id") || "";
	if (!/^books\/[0-9a-f-]{36}\.(txt|pdf|cbz|epub)$/.test(key) || !uploadId) throw new HttpError(400, "key and upload_id are needed");
	return { key, uploadId };
}
async function startUpload(env, url) {
	const { ext } = uploadName(url);
	const key = `books/${crypto.randomUUID()}.${ext}`;
	const up = await env.BOOKS.createMultipartUpload(key, { httpMetadata: { contentType: BOOK_TYPES[ext] } });
	return json({ key, upload_id: up.uploadId, part_size: UPLOAD_PART_BYTES }, 201);
}
async function uploadPart(request, env, url) {
	const { key, uploadId } = uploadRef(url);
	const n = Number(url.searchParams.get("n"));
	if (!Number.isInteger(n) || n < 1 || n > 10000) throw new HttpError(400, "n must be a piece number from 1");
	const length = Number(request.headers.get("Content-Length"));
	if (!(length > 0) || length > UPLOAD_PART_BYTES) throw new HttpError(400, "Each piece needs a length, up to 50 MB");
	const part = await env.BOOKS.resumeMultipartUpload(key, uploadId).uploadPart(n, request.body);
	return json({ part: { partNumber: part.partNumber, etag: part.etag } });
}
async function abortUpload(env, url) {
	const { key, uploadId } = uploadRef(url);
	await env.BOOKS.resumeMultipartUpload(key, uploadId).abort().catch(() => {});
	return json({ ok: true });
}
async function finishUpload(request, env, url) {
	const { filename, ext } = uploadName(url);
	const { key, uploadId } = uploadRef(url);
	if (!key.endsWith("." + ext)) throw new HttpError(400, "That upload is for a different kind of file");
	const uploadTags = await uploadTagsOf(env, url);
	const body = await readJSON(request);
	const parts = Array.isArray(body.parts) ? body.parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag || "") })) : [];
	if (!parts.length || parts.some((p) => !Number.isInteger(p.partNumber) || !p.etag)) throw new HttpError(400, "parts: [{partNumber, etag}]");
	const obj = await env.BOOKS.resumeMultipartUpload(key, uploadId).complete(parts);
	return addBookFile(env, filename, ext, key, obj.size, uploadTags);
}

// Genre tags from a new file's own details (no looking up online, so an
// upload stays quick). Never stops the upload.
async function uploadGenres(env, book, key) {
	try {
		if (!(await addGenreTags(env, Object.assign({}, book, { r2_key: key }), { online: false })).added.length) return;
		const { results } = await env.DB.prepare("SELECT tag_id FROM book_tag_links WHERE book_id = ?").bind(book.id).all();
		book.tags = results.map((r) => r.tag_id);
	} catch (err) { console.warn("genres", book.id, err); }
}
// A new book's title, from its file name: "war_and_peace.txt" -> "war and peace".
function madeTitle(filename) {
	const dot = filename.lastIndexOf(".");
	return filename.slice(0, dot > 0 ? dot : filename.length).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim() || filename;
}
// A file now in R2 at key, as a book: a new one, or the new file of the book
// with the same file name.
async function addBookFile(env, filename, ext, key, size, uploadTags) {
	// Same file name as a book already here: that book gets the new file.
	// Its place, Finished and tags stay; a YAML header updates the details.
	// (Not one from Audiobookshelf: the sync would only put its file back.)
	const old = await env.DB.prepare("SELECT id, r2_key FROM books WHERE filename = ? COLLATE NOCASE AND abs_ebook IS NULL ORDER BY id DESC LIMIT 1")
		.bind(filename)
		.first();
	if (old) {
		try {
			const book = await env.DB.prepare(`UPDATE books SET size = ?, r2_key = ? WHERE id = ? RETURNING ${BOOK_COLUMNS}`)
				.bind(size, key, old.id)
				.first();
			await addBookTags(env, old.id, uploadTags);
			const { results } = await env.DB.prepare("SELECT tag_id FROM book_tag_links WHERE book_id = ?").bind(old.id).all();
			book.tags = results.map((r) => r.tag_id);
			if (ext === "txt") await applyFrontMatter(env, Object.assign(book, { r2_key: key })).catch(() => {});
			else {
				if (ext === "cbz") await applyComicInfo(env, Object.assign(book, { r2_key: key })).catch((err) => console.warn("comicinfo", book.id, err));
				await uploadGenres(env, book, key);
			}
			delete book.r2_key;
			await env.BOOKS.delete(old.r2_key);
			return json({ book, replaced: true });
		} catch (err) {
			await env.BOOKS.delete(key);
			throw err;
		}
	}
	const title = madeTitle(filename);
	try {
		const book = await env.DB.prepare(
			`INSERT INTO books (title, filename, type, size, r2_key, created_at)
			VALUES (?, ?, ?, ?, ?, ?) RETURNING ${BOOK_COLUMNS}`,
		)
			.bind(title, filename, storedType(ext), size, key, Date.now())
			.first();
		await addBookTags(env, book.id, uploadTags);
		book.tags = uploadTags;
		if (ext === "txt") await applyFrontMatter(env, book).catch(() => {});
		else {
			if (ext === "cbz") await applyComicInfo(env, Object.assign(book, { r2_key: key })).catch((err) => console.warn("comicinfo", book.id, err));
			delete book.r2_key;
			await uploadGenres(env, book, key);
		}
		return json({ book }, 201);
	} catch (err) {
		await env.BOOKS.delete(key);
		throw err;
	}
}

async function getBook(env, id) {
	const book = await env.DB.prepare("SELECT * FROM books WHERE id = ?").bind(id).first();
	if (!book) throw new HttpError(404, "No such book");
	return book;
}

// A book's file, or a piece of it ({offset, length}): from R2, or from
// Audiobookshelf for an ebook kept there (r2_key "absbook/<item id>/<file
// ino>/<mtime>", so a changed file gets a new key and its cover and preview
// are made again). -> {body, size, arrayBuffer()} like an R2 object, or null
// when the file is missing.
const HOME_OFFLINE = "The home server is offline just now, so this book can't open. Try again later.";
async function bookObject(env, key, range) {
	if (!key.startsWith("absbook/")) return env.BOOKS.get(key, range ? { range } : undefined);
	const [, item, ino] = key.split("/");
	let res;
	try {
		res = await absFetch(env, `/api/items/${encodeURIComponent(item)}/ebook/${encodeURIComponent(ino)}`,
			{ headers: range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {} });
	} catch (err) {
		throw err.message === ABS_OFFLINE ? new HttpError(502, HOME_OFFLINE) : err;
	}
	if (res.status === 404) {
		await res.body?.cancel();
		return null;
	}
	if (!res.ok) {
		await res.body?.cancel();
		throw new HttpError(502, `Audiobookshelf answered ${res.status}`);
	}
	// A server that ignores Range sends the whole file: keep just the piece.
	if (range && res.status !== 206) {
		const piece = new Uint8Array(await res.arrayBuffer()).slice(range.offset, range.offset + range.length);
		return { body: piece, size: piece.length, arrayBuffer: async () => piece.buffer };
	}
	return { body: res.body, size: Number(res.headers.get("Content-Length")) || 0, arrayBuffer: () => res.arrayBuffer() };
}

async function bookFile(env, id, download) {
	const book = await getBook(env, id);
	const obj = await bookObject(env, book.r2_key);
	if (!obj) throw new HttpError(404, "The file is missing from storage");
	if (!download) await env.DB.prepare("UPDATE books SET last_opened_at = ? WHERE id = ?").bind(Date.now(), id).run();
	return new Response(obj.body, {
		headers: {
			"Content-Type": BOOK_TYPES[bookType(book)],
			"Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(book.filename)}`,
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; sandbox",
		},
	});
}

// Looking a book up, as wr1t3r's book notes do: Open Library's search for the
// match, then covers from Google Books (usually the sharpest) and Open
// Library's editions. No keys needed.
const LOOKUP_UA = "reader-book-lookup/1.0 (https://github.com/librarykaiju/reader)";
async function lookupJSON(u) {
	const res = await fetch(u, { headers: { "User-Agent": LOOKUP_UA, Accept: "application/json" } });
	if (!res.ok) {
		await res.body?.cancel();
		throw new HttpError(502, `${new URL(u).hostname} answered ${res.status}`);
	}
	return res.json();
}
function looseTitle(s) {
	return String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
// Settles to fallback if fn fails or takes over ms.
function within(fn, fallback, ms) {
	return Promise.race([fn().catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);
}
async function lookupBooks(url) {
	const q = str(url.searchParams.get("q"), 300);
	if (!q) throw new HttpError(400, "q is needed");
	// As typed, then without punctuation, then folded right down: the first
	// that finds anything. An exact title match goes first.
	const plain = q.replace(/[^\p{L}\p{N}'’]+/gu, " ").replace(/\s+/g, " ").trim();
	for (const v of [...new Set([q, plain, looseTitle(q)])].filter(Boolean)) {
		const data = await lookupJSON("https://openlibrary.org/search.json?" + new URLSearchParams({
			q: v, fields: "title,author_name,first_publish_year,cover_i,key", limit: "10",
		}));
		const hits = (data.docs || []).filter((d) => /^\/works\/OL\d+W$/.test(d.key || "")).map((d) => ({
			title: String(d.title || ""),
			author: (d.author_name || []).slice(0, 3).join(", "),
			year: d.first_publish_year ? String(d.first_publish_year) : "",
			thumb: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-S.jpg` : "",
			work: d.key,
			cover_id: Number.isInteger(d.cover_i) ? d.cover_i : null,
		}));
		if (hits.length) {
			// q is often "title author", so a title the query starts with counts too.
			const want = looseTitle(q), rank = (h) => { const t = looseTitle(h.title); return t === want ? 2 : t && want.startsWith(t + " ") ? 1 : 0; };
			hits.sort((a, b) => rank(b) - rank(a));
			return json({ hits });
		}
	}
	return json({ hits: [] });
}
async function lookupCovers(url) {
	const work = url.searchParams.get("work") || "";
	if (!/^\/works\/OL\d+W$/.test(work)) throw new HttpError(400, "work is needed");
	const title = str(url.searchParams.get("title"), 300) || "", author = str(url.searchParams.get("author"), 200) || "";
	const coverId = Number(url.searchParams.get("cover_id"));
	const q = [`intitle:${title}`].concat(author ? [`inauthor:${author.split(",")[0]}`] : []).join(" ");
	const [google, editions] = await Promise.all([
		within(async () => ((await lookupJSON("https://www.googleapis.com/books/v1/volumes?" + new URLSearchParams({ q, maxResults: "5" }))).items || [])
			.map((i) => i.volumeInfo?.imageLinks?.thumbnail || i.volumeInfo?.imageLinks?.smallThumbnail).filter(Boolean)
			.map((u) => { const s = u.replace(/^http:/, "https:"); return /[?&]zoom=\d/.test(s) ? s.replace(/zoom=\d/, "zoom=3") : s + "&zoom=3"; }), [], 6000),
		within(async () => [...new Set(((await lookupJSON(`https://openlibrary.org${work}/editions.json?limit=20`)).entries || [])
			.map((e) => e.covers?.[0]).filter((c) => Number.isInteger(c) && c > 0))]
			.map((c) => `https://covers.openlibrary.org/b/id/${c}-L.jpg`), [], 6000),
	]);
	const own = Number.isInteger(coverId) && coverId > 0 ? [`https://covers.openlibrary.org/b/id/${coverId}-L.jpg`] : [];
	return json({ covers: [...new Set([...google, ...own, ...editions])].slice(0, 8) });
}
async function lookupImage(url) {
	let u;
	try { u = new URL(url.searchParams.get("url") || ""); } catch { throw new HttpError(400, "url is needed"); }
	if (u.protocol !== "https:" || !/^(covers\.openlibrary\.org|books\.google\.com|books\.googleusercontent\.com)$/.test(u.hostname)) {
		throw new HttpError(400, "Only Open Library and Google Books covers");
	}
	const res = await fetch(u, { headers: { "User-Agent": LOOKUP_UA } });
	if (!res.ok) throw new HttpError(502, `${u.hostname} answered ${res.status}`);
	const img = new Uint8Array(await res.arrayBuffer());
	const kind = img.length <= MAX_COVER_BYTES && imageType(img);
	if (!kind) throw new HttpError(502, "That cover isn't an image");
	return new Response(img, { headers: { "Content-Type": kind, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

// A piece of a book's file, so the page can draw a PDF's first page without
// downloading all of it (pdf.js asks for the pieces it needs).
async function bookPart(env, id, url) {
	const book = await getBook(env, id);
	const at = Number(url.searchParams.get("at")), len = Number(url.searchParams.get("len"));
	if (!Number.isInteger(at) || !Number.isInteger(len) || at < 0 || len < 1 || len > 4 * 1024 * 1024) throw new HttpError(400, "at and len must be whole numbers, len up to 4 MB");
	const obj = await bookObject(env, book.r2_key, { offset: at, length: len });
	if (!obj) throw new HttpError(404, "The file is missing from storage");
	return new Response(obj.body, {
		headers: { "Content-Type": "application/octet-stream", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
	});
}

const COMIC_LAYOUTS = ["pages", "scroll", "rtl"];
async function updateBook(request, env, id) {
	const body = await readJSON(request);
	const sets = [];
	const params = [];
	if (body.title !== undefined) {
		const title = str(body.title, 300);
		if (!title) throw new HttpError(400, "title can't be empty");
		sets.push("title = ?");
		params.push(title);
	}
	for (const key of ["author", "series", "volume"]) {
		if (body[key] === undefined) continue;
		sets.push(key + " = ?");
		params.push(str(body[key], 300));
	}
	if (body.layout !== undefined) {
		if (body.layout !== null && !COMIC_LAYOUTS.includes(body.layout)) throw new HttpError(400, "layout: " + COMIC_LAYOUTS.join(", ") + " or null");
		sets.push("layout = ?");
		params.push(body.layout);
	}
	if (body.position !== undefined) {
		const pos = body.position === null ? null : String(body.position);
		if (pos && pos.length > 500) throw new HttpError(400, "position is too long");
		sets.push("position = ?");
		params.push(pos);
	}
	// Marking it finished again keeps the first date; false clears it.
	if (body.finished !== undefined) {
		sets.push(body.finished ? "finished_at = COALESCE(finished_at, ?)" : "finished_at = ?");
		params.push(body.finished ? Date.now() : null);
	}
	// A downloaded book opens from this device's copy, so the file isn't
	// fetched; this keeps "opened" (and the Library order) up to date.
	if (body.opened) {
		sets.push("last_opened_at = ?");
		params.push(Date.now());
	}
	// The Record page's details as typed in Edit details: marked "edited", so
	// a lookup never replaces them. Emptied, a lookup may fill it again.
	if (["blurb", "pages", "appeal", "catalog"].some((k) => body[k] !== undefined)) {
		const cur = await env.DB.prepare("SELECT record_from, catalog FROM books WHERE id = ?").bind(id).first();
		if (!cur) throw new HttpError(404, "No such book");
		let from = {};
		try { from = JSON.parse(cur.record_from || "{}") || {}; } catch {}
		const vals = {};
		if (body.blurb !== undefined) vals.blurb = typeof body.blurb === "string" ? blurbText(body.blurb) : null;
		if (body.pages !== undefined) vals.pages = body.pages === null || body.pages === "" ? null : clampInt(body.pages, 1, 100000, null);
		if (body.appeal !== undefined) { const a = cleanAppeal(body.appeal, false); vals.appeal = a && JSON.stringify(a); }
		// catalog: the fields given replace those; an empty one is cleared (and may be looked up again).
		if (body.catalog !== undefined) {
			if (!body.catalog || typeof body.catalog !== "object") throw new HttpError(400, "catalog must be an object");
			let had = {};
			try { had = JSON.parse(cur.catalog || "{}") || {}; } catch {}
			const given = cleanCatalog(body.catalog), cat = { ...from.catalog };
			for (const k of CATALOG_FIELDS) {
				if (!(k in body.catalog)) continue;
				if (given[k]) { had[k] = given[k]; cat[k] = "edited"; } else { delete had[k]; delete cat[k]; }
			}
			from.catalog = cat;
			sets.push("catalog = ?");
			params.push(Object.keys(had).length ? JSON.stringify(had) : null);
		}
		for (const [k, v] of Object.entries(vals)) {
			sets.push(k + " = ?");
			params.push(v || null);
			if (v) from[k] = "edited";
			else delete from[k];
			if (k === "blurb") delete from.blurb_model;
		}
		sets.push("record_from = ?", "record_at = COALESCE(record_at, ?)");
		params.push(JSON.stringify(from), Date.now());
	}
	if (body.reread) {
		const book = await getBook(env, id);
		if (book.type === "txt") await applyFrontMatter(env, book);
		else if (bookType(book) === "cbz") await applyComicInfo(env, book);
	}
	const tagIds = body.tags === undefined ? null : await tagRefs(env, body.tags, TAGS.books);
	if (!sets.length && !tagIds && !body.reread) throw new HttpError(400, "Nothing to change");
	const book = sets.length
		? await env.DB.prepare(`UPDATE books SET ${sets.join(", ")} WHERE id = ? RETURNING ${BOOK_COLUMNS}`).bind(...params, id).first()
		: await env.DB.prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE id = ?`).bind(id).first();
	if (!book) throw new HttpError(404, "No such book");
	if (tagIds) await setTags(env, TAGS.books, id, tagIds);
	const { results } = await env.DB.prepare("SELECT tag_id FROM book_tag_links WHERE book_id = ?").bind(id).all();
	book.tags = results.map((r) => r.tag_id);
	return json({ book });
}

// A .txt book can start with a YAML header (front matter):
//   ---
//   title: The Fifth Season
//   author: N. K. Jemisin
//   series: The Broken Earth
//   volume: 1
//   genre: [Fantasy, Science fiction]
//   ---
// Title, author, series and volume go on the book; each genre becomes a book
// tag (made if it's new). Only these simple forms are read: key: value,
// [a, b] lists, and "- a" list lines. The page hides the header when reading.
const FRONT_MATTER = /^\uFEFF?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
function parseFrontMatter(text) {
	const m = FRONT_MATTER.exec(text);
	if (!m) return null;
	const out = {};
	let listKey = null;
	const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
	for (const line of m[1].split(/\r?\n/)) {
		if (/^\s*(#|$)/.test(line)) continue;
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && listKey) { out[listKey].push(unquote(item[1])); continue; }
		const kv = /^([A-Za-z][\w -]*?)\s*:\s*(.*)$/.exec(line);
		listKey = null;
		if (!kv) continue;
		const key = kv[1].toLowerCase(), v = kv[2].replace(/\s+#.*$/, "").trim();
		if (v === "") { out[key] = []; listKey = key; }
		else if (/^\[.*\]$/.test(v)) out[key] = v.slice(1, -1).split(",").map(unquote).filter(Boolean);
		else out[key] = unquote(v);
	}
	const one = (...keys) => {
		for (const k of keys) {
			const v = out[k];
			if (Array.isArray(v) ? v.length : v) return (Array.isArray(v) ? v.join(", ") : String(v)).slice(0, 300);
		}
		return null;
	};
	const many = (...keys) => {
		for (const k of keys) {
			const v = out[k];
			if (v) return (Array.isArray(v) ? v : String(v).split(",")).map((x) => x.trim().slice(0, 80)).filter(Boolean).slice(0, 20);
		}
		return [];
	};
	return { title: one("title"), author: one("author", "authors"), series: one("series"), volume: one("volume", "vol", "book"), genres: many("genre", "genres") };
}
async function applyFrontMatter(env, book) {
	const head = await env.BOOKS.get(book.r2_key || (await getBook(env, book.id)).r2_key, { range: { offset: 0, length: 16384 } });
	if (!head) return;
	const fm = parseFrontMatter(new TextDecoder().decode(await head.arrayBuffer()));
	if (!fm) return;
	const row = await env.DB.prepare(
		`UPDATE books SET title = COALESCE(?, title), author = ?, series = ?, volume = ? WHERE id = ? RETURNING ${BOOK_COLUMNS}`,
	).bind(fm.title, fm.author, fm.series, fm.volume, book.id).first();
	Object.assign(book, row);
	if (!fm.genres.length) return;
	const ids = await bookTagsNamed(env, fm.genres);
	await addBookTags(env, book.id, ids);
	book.tags = [...new Set([...(book.tags || []), ...ids])];
}
function addBookTags(env, bookId, ids) {
	if (!ids.length) return;
	return env.DB.batch(ids.map((t) => env.DB.prepare("INSERT OR IGNORE INTO book_tag_links (book_id, tag_id) VALUES (?, ?)").bind(bookId, t)));
}
// The ids of the book tags with these names (ignoring case), made if new.
async function bookTagsNamed(env, names) {
	const ids = [];
	for (const name of names) {
		const tag = (await env.DB.prepare("SELECT id FROM book_tags WHERE name = ?").bind(name).first())
			|| (await env.DB.prepare("INSERT INTO book_tags (name, created_at) VALUES (?, ?) RETURNING id").bind(name, Date.now()).first());
		ids.push(tag.id);
	}
	return ids;
}

// Genre tags. Subjects come from the book's own file first (an EPUB's
// dc:subject, a comic's ComicInfo.xml Genre and Tags, a PDF's Keywords),
// and, if those give nothing, from Open Library's subjects for the book.
// Raw subjects are messy ("FICTION / Fantasy / Epic", "Fiction, fantasy,
// general", "Wizards", "nyt:hardcover-fiction=2010-05-02"), so each is
// matched against this short list and only these names become tags. A
// subject from the file that's already a book tag's name counts as well.
// Tags are only ever added; any the book has stay.
const GENRES = [
	["Urban Fantasy", /urban fantasy|fantasy urban|\bparanormal\b/],
	["Science Fiction", /science fiction|\bsci ?fi\b|space opera|cyberpunk|dystopia|time travel/],
	["Fantasy", /\bfantasy\b|sword and sorcery/],
	["Horror", /\bhorror\b|ghost stories|vampire (?:fiction|stories)/],
	["Mystery", /\bmyster(?:y|ies)\b|detective (?:and mystery )?(?:fiction|stories)|crime fiction/],
	["Thriller", /\bthrillers?\b|\bsuspense\b|espionage|spy (?:fiction|stories)/],
	["Romance", /\bromance\b|love stories/],
	["Historical Fiction", /historical (?:fiction|novels?)|fiction historical/],
	["Literary Fiction", /literary fiction|fiction literary|psychological fiction/],
	["Young Adult", /young adult|juvenile fiction|\bteen\b/],
	["Children's", /children s (?:fiction|stories|books|literature)|picture books|juvenile literature/],
	["Humor", /\bhumou?r|\bcomedy\b|\bsatire\b|\bparod(?:y|ies)\b/],
	["Short Fiction", /short (?:stories|fiction)|\banthologies\b|\bnovellas?\b/],
	["Poetry", /\bpoetry\b|\bpoems\b/],
	["Drama", /\bdrama\b|\bplays\b|\btragedies\b/],
	["Classics", /\bclassics?\b|classic literature/],
	["Mythology & Folklore", /mytholog|folklore|fairy tales|\bmyths\b|\blegends\b/],
	["Comics", /\bcomics\b|comic (?:books?|strips)|graphic novels?|\bmanga\b/],
	["Superheroes", /\bsuper ?heroe?s?\b/],
	// Only for subjects that don't say fiction: "History" alone, not
	// "Fiction, history" or "World War, 1939-1945 -- Fiction".
	["History", /\bhistory\b/, true],
	["Biography & Memoir", /\bbiograph|\bautobiograph|\bmemoirs?\b/, true],
	["Philosophy", /\bphilosophy\b/, true],
	["Religion", /\breligio|\btheology\b|\bbible\b|christianity|buddhism|\bislam\b/, true],
	["Science", /^(?:science|physics|biology|chemistry|astronomy|cosmology|mathematics|evolution)\b/, true],
];
// A more exact genre stands in for the general one.
const GENRE_OVER = { "Urban Fantasy": "Fantasy" };
const FICTION_WORDS = /\bfiction\b|\bnovels?\b|\bstories\b/;
function subjectKey(s) {
	return " " + String(s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim() + " ";
}
// Subjects -> up to max genre names, the ones the most subjects point to first.
function genresOf(subjects, max) {
	const hits = new Map();
	for (const raw of subjects) {
		const s = subjectKey(raw), fiction = FICTION_WORDS.test(s);
		GENRES.forEach(([name, re, factOnly]) => {
			if (factOnly && fiction) return;
			if (re.test(factOnly ? s.trim() : s)) hits.set(name, (hits.get(name) || 0) + 1);
		});
	}
	for (const [exact, general] of Object.entries(GENRE_OVER)) if (hits.has(exact)) hits.delete(general);
	const order = GENRES.map((g) => g[0]);
	return [...hits.keys()].sort((a, b) => hits.get(b) - hits.get(a) || order.indexOf(a) - order.indexOf(b)).slice(0, max);
}

// What the file says about itself: {subjects, title, author}.
async function fileSubjects(env, book) {
	const type = bookType(book), out = { subjects: [], title: "", author: "" };
	if (type === "epub") {
		const zip = await r2Zip(env, book.r2_key, book.size);
		if (!zip) return out;
		const { opf } = await epubPackage(env, zip);
		const md = (/<(?:\w+:)?metadata\b[\s\S]*?<\/(?:\w+:)?metadata>/i.exec(opf) || [opf])[0];
		const els = (name) => [...md.matchAll(new RegExp(`<dc:${name}\\b[^>]*>([\\s\\S]*?)</dc:${name}>`, "gi"))].map((m) => xmlText(m[1])).filter(Boolean);
		out.subjects = els("subject");
		out.title = els("title")[0] || "";
		out.author = els("creator")[0] || "";
	} else if (type === "cbz") {
		const el = await comicInfo(env, book);
		if (!el) return out;
		out.subjects = [el("Genre"), el("Tags")].join(",").split(/[,;]/);
		out.title = el("Series") || el("Title");
		out.author = el("Writer").split(",")[0];
	} else if (type === "pdf") {
		// The document info and XMP are usually near the end or the start;
		// in a compressed object stream they're missed.
		const span = 256 * 1024, size = book.size || 0;
		const parts = [await r2Bytes(env, book.r2_key, 0, Math.min(size, span))];
		if (size > span) parts.push(await r2Bytes(env, book.r2_key, Math.max(span, size - span), Math.min(span, size - span)));
		const text = parts.filter(Boolean).map((b) => new TextDecoder("latin1").decode(b)).join("\n");
		const info = (key) => {
			const m = new RegExp(`/${key}\\s*(\\((?:\\\\.|[^\\\\)])*\\)|<[0-9a-fA-F\\s]*>)`).exec(text);
			return m ? pdfString(m[1]) : "";
		};
		const xmp = (/<dc:subject>([\s\S]*?)<\/dc:subject>/.exec(text) || [])[1] || "";
		// Only Keywords: /Title is also on every bookmark, so it can't be trusted here.
		out.subjects = [...info("Keywords").split(/[,;]/), ...[...xmp.matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g)].map((m) => xmlText(m[1]))];
	}
	out.subjects = out.subjects.map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s && s.length <= 120).slice(0, 60);
	return out;
}
// A comic's ComicInfo.xml, as a function from an element name to its text
// ("" when it's missing), or null when the comic has none.
async function comicInfo(env, book) {
	const zip = await r2Zip(env, book.r2_key, book.size);
	const info = zip && zip.files.find((f) => /(^|\/)comicinfo\.xml$/i.test(f.name));
	const bytes = info && await r2ZipRead(env, zip, info);
	if (!bytes) return null;
	const xml = new TextDecoder().decode(bytes);
	return (name) => xmlText((new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(xml) || [])[1] || "");
}
// A comic's series, number and title from its ComicInfo.xml, onto the book.
// Only blanks are filled, and the title only while it's still the one made
// from the file name, so nothing typed in Edit details is replaced. With no
// <Title>, the title becomes "Series #3". <Number> is the issue or volume;
// <Volume> stands in when there's no number.
async function applyComicInfo(env, book) {
	const el = await comicInfo(env, book);
	if (!el) return;
	const cut = (v) => v.slice(0, 300) || null;
	const series = cut(el("Series")), volume = cut(el("Number") || el("Volume"));
	const title = cut(el("Title")) || (series ? cut(series + (volume ? " #" + volume : "")) : null);
	const author = cut(el("Writer").split(",")[0].trim());
	if (!series && !volume && !title && !author) return;
	const row = await env.DB.prepare(
		`UPDATE books SET series = COALESCE(NULLIF(series, ''), ?), volume = COALESCE(NULLIF(volume, ''), ?), author = COALESCE(NULLIF(author, ''), ?),
		title = CASE WHEN title = ? THEN COALESCE(?, title) ELSE title END WHERE id = ? RETURNING ${BOOK_COLUMNS}`,
	).bind(series, volume, author, madeTitle(book.filename), title, book.id).first();
	if (row) Object.assign(book, row);
}
function xmlText(s) {
	return decodeXml(String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, ""))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/\s+/g, " ").trim();
}
// A PDF string, (literal) or <hex>, as text (UTF-16 when it starts FE FF).
function pdfString(raw) {
	let bytes = [];
	if (raw[0] === "<") {
		const hex = raw.slice(1, -1).replace(/\s+/g, "");
		for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2).padEnd(2, "0"), 16));
	} else {
		const s = raw.slice(1, -1), esc = { n: 10, r: 13, t: 9, b: 8, f: 12 };
		for (let i = 0; i < s.length; i++) {
			if (s[i] !== "\\") { bytes.push(s.charCodeAt(i) & 255); continue; }
			const c = s[++i];
			if (c === undefined) break;
			if (/[0-7]/.test(c)) {
				let o = c;
				while (o.length < 3 && /[0-7]/.test(s[i + 1] || "")) o += s[++i];
				bytes.push(parseInt(o, 8) & 255);
			} else if (c === "\r" || c === "\n") { if (c === "\r" && s[i + 1] === "\n") i++; }
			else bytes.push(esc[c] ?? (c.charCodeAt(0) & 255));
		}
	}
	const u8 = new Uint8Array(bytes);
	return (u8[0] === 0xfe && u8[1] === 0xff ? new TextDecoder("utf-16be").decode(u8.subarray(2)) : new TextDecoder("latin1").decode(u8)).trim();
}

// Open Library's subjects for a title (and author): only from a match whose
// title is the same, give or take a subtitle, and whose author shares a word
// with the one given, so a near miss never tags a book.
async function onlineSubjects(title, author) {
	const want = looseTitle(title);
	if (!want) return [];
	const surname = looseTitle(author.split(/,|&| and /)[0]).split(" ").pop();
	const same = (t) => { const a = looseTitle(t); return a === want || want.startsWith(a + " ") || a.startsWith(want + " "); };
	for (const q of [...new Set([[title, author].filter(Boolean).join(" "), title])]) {
		const data = await lookupJSON("https://openlibrary.org/search.json?" + new URLSearchParams({ q, fields: "title,author_name,subject", limit: "10" }));
		const hit = (data.docs || []).find((d) => same(d.title) && Array.isArray(d.subject)
			&& (!surname || (d.author_name || []).some((n) => looseTitle(n).split(" ").includes(surname))));
		if (hit) return hit.subject.slice(0, 200).map(String);
	}
	return [];
}

// POST /api/books/:id/genres {title?, author?, online?}: tags the book with
// its genres. title and author, when given, are what to look it up by
// (Edit details sends what's typed). online: false reads only the file.
async function tagGenres(request, env, id) {
	const body = await readJSON(request);
	const book = await getBook(env, id);
	const { added, from } = await addGenreTags(env, book, {
		title: str(body.title, 300), author: str(body.author, 300), online: body.online !== false,
	});
	const row = await env.DB.prepare(`SELECT ${BOOK_COLUMNS} FROM books WHERE id = ?`).bind(id).first();
	const { results } = await env.DB.prepare("SELECT tag_id FROM book_tag_links WHERE book_id = ?").bind(id).all();
	row.tags = results.map((r) => r.tag_id);
	return json({ book: row, added, from });
}
// book: a books row (with r2_key). -> {added: [tag names], from: "file" | "online" | ""}
async function addGenreTags(env, book, opts) {
	let file = { subjects: [], title: "", author: "" };
	if (book.type !== "txt") {
		try { file = await fileSubjects(env, book); } catch (err) { console.warn("subjects", book.id, err); }
	}
	let names = genresOf(file.subjects, 5), from = "file";
	if (file.subjects.length) {
		const { results } = await env.DB.prepare("SELECT name FROM book_tags WHERE name IN (SELECT value FROM json_each(?))")
			.bind(JSON.stringify(file.subjects)).all();
		names = [...new Set([...names, ...results.map((r) => r.name)])];
	}
	if (!names.length && opts.online) {
		// A title still made from the file name is a poor search; the file's own is better.
		const title = opts.title || (book.title === madeTitle(book.filename) && file.title) || book.title;
		const author = opts.author || book.author || file.author || "";
		let subjects;
		try { subjects = await onlineSubjects(title, author); } catch (err) {
			throw err instanceof HttpError ? err : new HttpError(502, "Couldn't reach Open Library");
		}
		names = genresOf(subjects, 3);
		from = "online";
	}
	// Every comic is a comic, whatever else it is.
	if (bookType(book) === "cbz" && !names.some((n) => n.toLowerCase() === "comics")) names.unshift("Comics");
	if (!names.length) return { added: [], from: "" };
	const ids = await bookTagsNamed(env, names);
	const { results } = await env.DB.prepare("SELECT tag_id FROM book_tag_links WHERE book_id = ?").bind(book.id).all();
	const had = new Set(results.map((r) => r.tag_id));
	await addBookTags(env, book.id, ids);
	return { added: names.filter((_, i) => !had.has(ids[i])), from };
}

async function deleteBook(env, id) {
	const book = await getBook(env, id);
	// The next sync would only bring it back.
	if (book.abs_id) throw new HttpError(409, "Audiobooks come from Audiobookshelf. Remove it there and it leaves Reader at the next sync.");
	if (book.abs_ebook) throw new HttpError(409, "This book comes from Audiobookshelf. Remove it there and it leaves Reader at the next sync.");
	await env.BOOKS.delete([book.r2_key, coverKey(id), previewKey(id)]);
	await env.DB.prepare("DELETE FROM books WHERE id = ?").bind(id).run();
	return json({ ok: true });
}

// Covers, kept in R2 as covers/<book id>, each tagged with the file it came
// from (customMetadata.src = the book's r2_key), so a re-uploaded file is
// looked at afresh. An EPUB's cover (from its package file) or a comic's
// first page is found here the first time it's asked for, reading only the
// zip's table of contents and that one image from R2. A PDF's is drawn by
// the page from its first page and sent up. Finding nothing leaves an empty
// object, so the file isn't searched again. The Library list says which
// books have one (cover: "yes"), have none ("none"), or haven't been looked
// at (null).
const MAX_COVER_BYTES = 8 * 1024 * 1024;
function coverKey(id) { return `covers/${id}`; }
// books: id -> r2_key.
async function coverStates(env, books) {
	const out = new Map();
	let cursor;
	do {
		const page = await env.BOOKS.list({ prefix: "covers/", cursor, include: ["customMetadata"] });
		for (const o of page.objects) {
			const id = Number(o.key.slice(7));
			if (books.get(id) === o.customMetadata?.src) out.set(id, o.size > 0 ? "yes" : "none");
		}
		cursor = page.truncated ? page.cursor : null;
	} while (cursor);
	return out;
}
function imageType(u8) {
	if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return "image/jpeg";
	if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return "image/png";
	if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return "image/gif";
	if (u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50 && u8[0] === 0x52) return "image/webp";
	return null;
}
function coverResponse(bytes, type) {
	return new Response(bytes, {
		headers: {
			"Content-Type": type,
			"Cache-Control": "private, max-age=3600",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; sandbox",
		},
	});
}
async function bookCover(env, id) {
	const book = await getBook(env, id);
	const stored = await env.BOOKS.get(coverKey(id));
	if (stored && stored.customMetadata?.src === book.r2_key) {
		if (!stored.size) throw new HttpError(404, "No cover");
		return coverResponse(stored.body, stored.customMetadata.type || "image/jpeg");
	}
	if (stored) await stored.arrayBuffer().catch(() => {});
	const type = bookType(book);
	if (type !== "epub" && type !== "cbz" && type !== "audiobook" && !book.abs_ebook) throw new HttpError(404, "No cover");
	if (type === "audiobook" || book.abs_ebook) {
		const got = await absCover(env, book);
		if (!got) throw new HttpError(404, "No cover");
		return coverResponse(got.img, got.kind);
	}
	let img = null;
	try {
		img = await findZipCover(env, book.r2_key, book.size, type);
	} catch (err) {
		console.warn("cover", id, err);
	}
	const kind = img && imageType(img);
	await env.BOOKS.put(coverKey(id), kind ? img : new Uint8Array(0), { customMetadata: { src: book.r2_key, type: kind || "" } });
	if (!kind) throw new HttpError(404, "No cover");
	return coverResponse(img, kind);
}
async function putBookCover(request, env, id) {
	const book = await getBook(env, id);
	const img = new Uint8Array(await request.arrayBuffer());
	if (img.length > MAX_COVER_BYTES) throw new HttpError(413, "Cover too large");
	const kind = imageType(img);
	if (!kind || kind === "image/gif") throw new HttpError(415, "A cover must be a JPEG, PNG or WebP");
	await env.BOOKS.put(coverKey(id), img, { customMetadata: { src: book.r2_key, type: kind } });
	return json({ ok: true });
}

async function deleteBookCover(env, id) {
	await getBook(env, id);
	await env.BOOKS.delete(coverKey(id));
	return json({ ok: true });
}

// Reading a zip in R2 a piece at a time: its table of contents from the
// end of the file, then just the entries wanted.
async function r2Bytes(env, key, offset, length) {
	const obj = await bookObject(env, key, { offset, length });
	return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}
async function r2Zip(env, key, size) {
	const tailLen = Math.min(size, 22 + 65535 + 20);
	const tail = await r2Bytes(env, key, size - tailLen, tailLen);
	if (!tail) return null;
	const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	let end = -1;
	for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
	if (end < 0) return null;
	let count = dv.getUint16(end + 10, true), cdSize = dv.getUint32(end + 12, true), cdAt = dv.getUint32(end + 16, true);
	if ((count === 0xffff || cdAt === 0xffffffff) && end >= 20 && dv.getUint32(end - 20, true) === 0x07064b50) {
		const z = await r2Bytes(env, key, Number(dv.getBigUint64(end - 12, true)), 56);
		const zv = new DataView(z.buffer, z.byteOffset, z.byteLength);
		count = Number(zv.getBigUint64(32, true));
		cdSize = Number(zv.getBigUint64(40, true));
		cdAt = Number(zv.getBigUint64(48, true));
	}
	if (cdSize > 8 * 1024 * 1024) return null;
	const cd = await r2Bytes(env, key, cdAt, cdSize);
	const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength), names = new TextDecoder(), files = [];
	for (let at = 0, n = 0; n < count && at + 46 <= cd.length && cv.getUint32(at, true) === 0x02014b50; n++) {
		const flags = cv.getUint16(at + 8, true), method = cv.getUint16(at + 10, true);
		let csize = cv.getUint32(at + 20, true), usize = cv.getUint32(at + 24, true), local = cv.getUint32(at + 42, true);
		const nl = cv.getUint16(at + 28, true), xl = cv.getUint16(at + 30, true), cl = cv.getUint16(at + 32, true);
		const name = names.decode(cd.subarray(at + 46, at + 46 + nl));
		for (let x = at + 46 + nl; x + 4 <= at + 46 + nl + xl; ) {
			const tag = cv.getUint16(x, true), len = cv.getUint16(x + 2, true);
			let v = x + 4;
			if (tag === 1) {
				if (usize === 0xffffffff) { usize = Number(cv.getBigUint64(v, true)); v += 8; }
				if (csize === 0xffffffff) { csize = Number(cv.getBigUint64(v, true)); v += 8; }
				if (local === 0xffffffff) local = Number(cv.getBigUint64(v, true));
			}
			x += 4 + len;
		}
		at += 46 + nl + xl + cl;
		if (!/\/$/.test(name)) files.push({ name, flags, method, csize, usize, local });
	}
	return { key, files };
}
async function r2ZipRead(env, zip, e) {
	if (!e || e.flags & 1 || e.usize > MAX_COVER_BYTES || (e.method !== 0 && e.method !== 8)) return null;
	const head = await r2Bytes(env, zip.key, e.local, 30);
	if (!head || new DataView(head.buffer).getUint32(0, true) !== 0x04034b50) return null;
	const skip = 30 + (head[26] | (head[27] << 8)) + (head[28] | (head[29] << 8));
	const data = await r2Bytes(env, zip.key, e.local + skip, e.csize);
	if (e.method === 0) return data;
	return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
}
const COVER_IMAGE = /\.(jpe?g|png|gif|webp)$/i;
async function findZipCover(env, key, size, type) {
	const zip = await r2Zip(env, key, size);
	if (!zip) return null;
	const byName = (n) => zip.files.find((f) => f.name === n) || zip.files.find((f) => f.name.toLowerCase() === n.toLowerCase());
	const images = zip.files.filter((f) => COVER_IMAGE.test(f.name) && !/(^|\/)(__MACOSX\/|\.)/.test(f.name));
	if (type === "cbz") {
		images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
		return r2ZipRead(env, zip, images[0]);
	}
	// EPUB: the package file's manifest marks the cover (EPUB 3's
	// properties="cover-image", or EPUB 2's <meta name="cover">).
	const { opf, dir } = await epubPackage(env, zip);
	const items = [...opf.matchAll(/<(?:\w+:)?item\b[^>]*>/gi)].map((m) => ({
		id: xmlAttr(m[0], "id"), href: xmlAttr(m[0], "href"), type: xmlAttr(m[0], "media-type"), props: xmlAttr(m[0], "properties"),
	}));
	const metaTag = [...opf.matchAll(/<(?:\w+:)?meta\b[^>]*>/gi)].map((m) => m[0]).find((t) => /\bname\s*=\s*["']cover["']/i.test(t));
	const metaId = metaTag && xmlAttr(metaTag, "content");
	const isImage = (it) => it && /^image\/(jpeg|png|gif|webp)$/i.test(it.type || "") && it.href;
	const pick = items.find((it) => /(^|\s)cover-image(\s|$)/.test(it.props || "") && isImage(it))
		|| items.find((it) => metaId && it.id === metaId && isImage(it))
		|| items.find((it) => isImage(it) && /cover/i.test(it.id + " " + it.href));
	if (pick) {
		const path = resolveZipPath(dir, pick.href);
		const img = await r2ZipRead(env, zip, byName(path));
		if (img) return img;
	}
	const named = images.find((f) => /(^|\/)cover[^/]*$/i.test(f.name));
	return named ? r2ZipRead(env, zip, named) : null;
}
// An EPUB's package file (its details and manifest), which container.xml names.
async function epubPackage(env, zip) {
	const text = async (n) => {
		const e = zip.files.find((f) => f.name === n) || zip.files.find((f) => f.name.toLowerCase() === n.toLowerCase());
		const b = await r2ZipRead(env, zip, e);
		return b ? new TextDecoder().decode(b) : "";
	};
	const container = await text("META-INF/container.xml");
	const opfPath = decodeXml((/<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)/i.exec(container) || [])[1] || "");
	const opf = opfPath ? await text(opfPath) : "";
	return { opf, dir: opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "" };
}
function decodeXml(s) {
	return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e]);
}
function xmlAttr(tag, name) {
	const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
	return m ? decodeXml(m[1] ?? m[2]) : null;
}
function resolveZipPath(dir, href) {
	let path = href.split("#")[0];
	try { path = decodeURIComponent(path); } catch {}
	const out = [];
	for (const part of (dir + path).split("/")) {
		if (part === "..") out.pop();
		else if (part && part !== ".") out.push(part);
	}
	return out.join("/");
}

// Highlights in .txt and .epub books (migration 0007). Positions count
// characters in the text after any YAML header (an EPUB: in its text, as the
// page lays it out); the page does the matching, the server only keeps them.
const HIGHLIGHT_COLUMNS = "id, book_id, start_pos, end_pos, text, note, created_at, updated_at";
const MAX_HIGHLIGHT_CHARS = 20000;
const MAX_NOTE_CHARS = 10000;

function highlightSpan(body) {
	const a = body.start_pos, b = body.end_pos;
	if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b <= a) throw new HttpError(400, "start_pos and end_pos must be positions, start before end");
	return [a, b];
}
function noteOf(v) {
	if (v === null || v === undefined) return null;
	if (typeof v !== "string") throw new HttpError(400, "note must be text");
	if (v.length > MAX_NOTE_CHARS) throw new HttpError(413, "That note is too long");
	return v.trim() || null;
}

async function listHighlights(env, bookId) {
	const { results } = await env.DB.prepare(
		`SELECT ${HIGHLIGHT_COLUMNS} FROM highlights WHERE book_id = ? ORDER BY start_pos, id`,
	)
		.bind(bookId)
		.all();
	return json({ highlights: results });
}

async function addHighlight(request, env, bookId) {
	const body = await readJSON(request);
	const [a, b] = highlightSpan(body);
	if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "text is needed");
	if (body.text.length > MAX_HIGHLIGHT_CHARS) throw new HttpError(413, "That highlight is too long");
	const book = await getBook(env, bookId);
	if (/\.(pdf|cbz)$/i.test(book.filename)) throw new HttpError(400, "Highlights are for .txt and .epub books");
	const now = Date.now();
	const highlight = await env.DB.prepare(
		`INSERT INTO highlights (book_id, start_pos, end_pos, text, note, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${HIGHLIGHT_COLUMNS}`,
	)
		.bind(bookId, a, b, body.text, noteOf(body.note), now, now)
		.first();
	return json({ highlight });
}

async function updateHighlight(request, env, id) {
	const body = await readJSON(request);
	const sets = [];
	const params = [];
	if (body.note !== undefined) {
		sets.push("note = ?");
		params.push(noteOf(body.note));
	}
	if (body.start_pos !== undefined || body.end_pos !== undefined) {
		sets.push("start_pos = ?", "end_pos = ?");
		params.push(...highlightSpan(body));
	}
	if (!sets.length) throw new HttpError(400, "Nothing to change");
	const highlight = await env.DB.prepare(
		`UPDATE highlights SET ${sets.join(", ")}, updated_at = ? WHERE id = ? RETURNING ${HIGHLIGHT_COLUMNS}`,
	)
		.bind(...params, Date.now(), id)
		.first();
	if (!highlight) throw new HttpError(404, "No such highlight");
	return json({ highlight });
}

async function deleteHighlight(env, id) {
	const del = await env.DB.prepare("DELETE FROM highlights WHERE id = ?").bind(id).run();
	if (!del.meta.changes) throw new HttpError(404, "No such highlight");
	return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Family library. Family members browse the Library and download books;
// nothing else of the owner's (feeds, places, highlights, Edit details) is
// open to them. Each person has an invite link, /library#invite=<code>: the
// code works once and runs out after 7 days unused. Opening it trades the
// code for the person's own token, which the Worker sets as a cookie
// (HttpOnly, a year, renewed on each visit) rather than leaving it to the
// page: Safari deletes storage a page's script wrote after 7 days without a
// visit, and family may come by once a month. Only SHA-256 hashes of codes
// and tokens are stored. A book tagged "Hide from family" stays out of it.

const FAMILY_COOKIE = "reader_family";
const INVITE_DAYS = 7;
const FAMILY_COOKIE_DAYS = 365;
const HIDE_TAG = "Hide from family";

function randomToken() {
	return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function hashSecret(s) {
	return sha256Hex(new TextEncoder().encode(s));
}
function cookieValue(request, name) {
	for (const part of (request.headers.get("Cookie") || "").split(";")) {
		const eq = part.indexOf("=");
		if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return null;
}
function familyCookie(token) {
	return `${FAMILY_COOKIE}=${token}; Path=/; Max-Age=${FAMILY_COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

async function familyPerson(request, env) {
	const token = cookieValue(request, FAMILY_COOKIE);
	if (!token || !/^[\w-]{20,100}$/.test(token)) return null;
	const person = await env.DB.prepare("SELECT id, name, last_seen_at FROM people WHERE token_hash = ?").bind(await hashSecret(token)).first();
	if (!person) return null;
	const now = Date.now();
	if (!person.last_seen_at || now - person.last_seen_at > 5 * 60 * 1000) {
		await env.DB.prepare("UPDATE people SET last_seen_at = ? WHERE id = ?").bind(now, person.id).run();
		person.last_seen_at = now;
	}
	person.token = token;
	return person;
}

async function redeemInvite(request, env) {
	const code = str((await readJSON(request)).code, 100);
	if (!code) throw new HttpError(400, "No invite code");
	const token = randomToken(), now = Date.now();
	// One statement, so a code can't be used twice even by two devices at once.
	const person = await env.DB.prepare(
		`UPDATE people SET token_hash = ?, invite_hash = NULL, invite_expires_at = NULL, last_seen_at = ?
		WHERE invite_hash = ? AND invite_expires_at > ? RETURNING name`,
	).bind(await hashSecret(token), now, await hashSecret(code), now).first();
	if (!person) throw new HttpError(410, "This link has already been used or has run out");
	const res = json({ name: person.name });
	res.headers.set("Set-Cookie", familyCookie(token));
	return res;
}

async function familyApi(request, env, url, who) {
	const m = request.method;
	const p = url.pathname;
	if (m !== "GET") return null;
	if (p === "/api/family/me") {
		const today = who.person ? await downloadedToday(env, who.person.id) : null;
		const res = json({ name: who.person ? who.person.name : null, owner: str(env.OWNER_NAME, 60),
			left: today && Math.max(0, DOWNLOADS_PER_DAY - today.books.length), today: today && today.books,
			audio_left: today && Math.max(0, AUDIOBOOKS_PER_DAY - today.audio.length), audio_today: today && today.audio });
		if (who.person) res.headers.set("Set-Cookie", familyCookie(who.person.token));
		return res;
	}
	if (p === "/api/family/books") return familyBooks(env);
	const record = p.match(/^\/api\/family\/books\/(\d+)$/);
	if (record) return familyRecord(env, toId(record[1]));
	const cover = p.match(/^\/api\/family\/books\/(\d+)\/cover$/);
	if (cover) {
		await familyBook(env, toId(cover[1]));
		return bookCover(env, toId(cover[1]));
	}
	const file = p.match(/^\/api\/family\/books\/(\d+)\/file$/);
	if (file) return familyDownload(env, toId(file[1]), who.person);
	const preview = p.match(/^\/api\/family\/books\/(\d+)\/preview$/);
	if (preview) return familyPreview(env, toId(preview[1]), url);
	const page = p.match(/^\/api\/family\/books\/(\d+)\/preview\/page\/(\d+)$/);
	if (page) return previewComicPage(env, toId(page[1]), Number(page[2]));
	const part = p.match(/^\/api\/family\/books\/(\d+)\/preview\/part$/);
	if (part) return previewPart(env, toId(part[1]), url);
	const audio = p.match(/^\/api\/family\/books\/(\d+)\/audio\/(\d+)$/);
	if (audio) return audioFile(request, env, toId(audio[1]), Number(audio[2]));
	return null;
}

const NOT_HIDDEN = `NOT EXISTS (SELECT 1 FROM book_tag_links l JOIN book_tags t ON t.id = l.tag_id
	WHERE l.book_id = books.id AND t.name = '${HIDE_TAG}' COLLATE NOCASE)`;

async function familyBooks(env) {
	const { results } = await env.DB.prepare(
		`SELECT id, title, ${BOOK_TYPE} AS type, size, created_at, author, series, volume, narrator, duration, r2_key,
			(SELECT json_group_array(t.name) FROM book_tag_links l JOIN book_tags t ON t.id = l.tag_id WHERE l.book_id = books.id) AS tags
		FROM books WHERE ${NOT_HIDDEN} AND gone_at IS NULL ORDER BY created_at DESC, id DESC`,
	).all();
	const covers = await coverStates(env, new Map(results.map((b) => [b.id, b.r2_key])));
	for (const b of results) {
		b.tags = JSON.parse(b.tags || "[]");
		b.cover = covers.get(b.id) || null;
		delete b.r2_key;
		if (b.type !== "audiobook") { delete b.narrator; delete b.duration; }
	}
	return json({ books: results });
}

// A hidden book answers as if it weren't there.
async function familyBook(env, id) {
	const book = await env.DB.prepare(`SELECT * FROM books WHERE id = ? AND ${NOT_HIDDEN} AND gone_at IS NULL`).bind(id).first();
	if (!book) throw new HttpError(404, "No such book");
	return book;
}

// "Title - Author.epub", with nothing a file system would refuse.
function downloadName(book) {
	const ext = bookType(book);
	const base = [book.title, book.author].filter(Boolean).join(" - ").replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
	return (base || "Book") + "." + ext;
}

// 10 different books a person in any 24 hours, so the library's connection
// isn't swamped, and 2 audiobooks on top: one is 300 MB to 1 GB, sent from
// the home server over its upload. Taking a book again within the day
// doesn't count twice. The owner has no limit.
const DOWNLOADS_PER_DAY = 10;
const AUDIOBOOKS_PER_DAY = 2;
// -> {books: [ids], audio: [ids]}
async function downloadedToday(env, personId) {
	const { results } = await env.DB.prepare(
		`SELECT DISTINCT d.book_id, b.filename LIKE '%.audiobook' AS audio FROM downloads d JOIN books b ON b.id = d.book_id
		WHERE d.person_id = ? AND d.at > ?`,
	).bind(personId, Date.now() - 86400000).all();
	return { books: results.filter((r) => !r.audio).map((r) => r.book_id), audio: results.filter((r) => r.audio).map((r) => r.book_id) };
}
function limitPage(audio) {
	const n = audio ? AUDIOBOOKS_PER_DAY : DOWNLOADS_PER_DAY, what = audio ? "audiobooks" : "books";
	const why = audio ? `Audiobooks are big, so each card gets ${n} a day on top of the ${DOWNLOADS_PER_DAY} books. You can still listen to any of them on the page.`
		: `Each card gets ${n} downloads a day, so the library's internet holds up.`;
	return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Come back tomorrow</title>
<body style="font: 18px/1.5 Georgia, serif; background: #f4ecd8; color: #3b2f22; max-width: 32em; margin: 0 auto; padding: 48px 20px">
<h1 style="font-size: 26px">That's today's ${n} ${what}</h1>
<p>${why} Come back tomorrow for more.</p>
<p><a href="/library" style="color: #8b2e1f">Back to the library</a></p>`, {
		status: 429,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" },
	});
}

async function familyDownload(env, id, person) {
	const book = await familyBook(env, id);
	const audio = bookType(book) === "audiobook";
	if (person) {
		const today = await downloadedToday(env, person.id), taken = audio ? today.audio : today.books;
		if (!taken.includes(id) && taken.length >= (audio ? AUDIOBOOKS_PER_DAY : DOWNLOADS_PER_DAY)) return limitPage(audio);
	}
	if (audio) return audiobookDownload(env, book, person);
	const obj = await bookObject(env, book.r2_key);
	if (!obj) throw new HttpError(404, "The file is missing from storage");
	if (person) await env.DB.prepare("INSERT INTO downloads (person_id, book_id, at) VALUES (?, ?, ?)").bind(person.id, id, Date.now()).run();
	const name = downloadName(book);
	return new Response(obj.body, {
		headers: {
			"Content-Type": BOOK_TYPES[bookType(book)],
			"Content-Length": String(obj.size || book.size),
			"Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; sandbox",
		},
	});
}

// Audiobooks: from Audiobookshelf (ABS) on the home server, which keeps the
// files and has already read their details and chapters. Reader is the
// catalog: each audiobook is a books row (type 'pdf', named
// "<title>.audiobook", r2_key "abs/<item id>", migration 0017) that family
// browse, look up and download like any other book, while the audio itself
// comes from ABS when someone plays or downloads it.
//   * Reaching ABS: through a Cloudflare Tunnel at ABS_URL, behind a
//     Cloudflare Access service token (CF_ACCESS_CLIENT_ID and _SECRET), with
//     an API key (ABS_TOKEN) for a read-only ABS user. ABS itself is never
//     public, and family never get ABS accounts.
//   * Sync (the cron, or POST /api/audiobooks/sync): lists every ABS book
//     library and adds or updates a row per audiobook, then fetches the next
//     40 covers not kept in R2 yet. One that's gone from
//     ABS is hidden (gone_at), and comes back if it returns. Its files and
//     chapters (abs_media) are fetched the first time someone plays or
//     downloads it, and again after ABS changes it.
//   * Playing: /api/family/books/:id/audio/:n streams file n with ranged
//     reads, so the player can seek. It isn't a download and isn't counted.
//   * Downloading: one file goes out as it is (an .m4b, usually); a book in
//     several files goes out as the zip ABS makes. 2 a day per person.
//   * When the server, the tunnel or the home internet is down, the library
//     still browses (it's all in D1) and playing says the server is offline.
//   * Ebooks: an ABS item's ebook (EPUB, PDF or CBZ) is a books row of its
//     own (abs_ebook = the item id, migration 0019), read through bookObject
//     like a book in R2, so the app's library and the family library open,
//     preview and download it as they do the others. An item with an
//     audiobook and an ebook is two rows, which both libraries show as one
//     book in both formats. MOBI, AZW3 and CBR are left out.
function absOn(env) { return !!(env.ABS_URL && env.ABS_TOKEN); }
const ABS_OFFLINE = "The home server is offline just now, so audiobooks can't play. Try again later.";
const ABS_PAGE = 200;

async function absFetch(env, path, init = {}) {
	if (!absOn(env)) throw new HttpError(503, "Audiobooks aren't set up (ABS_URL and ABS_TOKEN)");
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${env.ABS_TOKEN}`);
	if (env.CF_ACCESS_CLIENT_ID) {
		headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
		headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET || "");
	}
	let res;
	try {
		res = await fetch(env.ABS_URL.replace(/\/+$/, "") + path, { ...init, headers, redirect: "manual" });
	} catch (err) {
		console.warn("abs", path, err);
		throw new HttpError(502, ABS_OFFLINE);
	}
	// Access sends anyone without the service token to its sign-in page.
	if (res.status >= 300 && res.status < 400) {
		await res.body?.cancel();
		throw new HttpError(502, "Cloudflare Access turned Reader away from Audiobookshelf (check the service token)");
	}
	if (res.status === 401 || res.status === 403) {
		await res.body?.cancel();
		throw new HttpError(502, "Audiobookshelf turned down Reader's API key (ABS_TOKEN)");
	}
	// 502-504 and 530 are Cloudflare's: the tunnel or the server is down.
	if (res.status >= 500) {
		await res.body?.cancel();
		throw new HttpError(502, ABS_OFFLINE);
	}
	return res;
}
async function absJSON(env, path) {
	const res = await absFetch(env, path);
	if (!res.ok) {
		await res.body?.cancel();
		throw new HttpError(res.status === 404 ? 404 : 502, res.status === 404 ? "Audiobookshelf no longer has this audiobook" : `Audiobookshelf answered ${res.status}`);
	}
	return res.json();
}

// "Mistborn #1" -> ["Mistborn", "1"]; several series ("A #1, B #3"): the first.
function absSeries(name) {
	const first = String(name || "").split(/,\s+(?=[^,]*#)/)[0].trim();
	const m = /^(.*?)\s+#\s*([\d.]+\S*)$/.exec(first);
	return m ? [m[1].trim(), m[2]] : [first || null, null];
}

// -> {added, updated, gone, total}
async function absSync(env) {
	const { libraries = [] } = await absJSON(env, "/api/libraries");
	const items = [], ebooks = [];
	for (const lib of libraries) {
		if (lib.mediaType && lib.mediaType !== "book") continue;
		for (let page = 0; ; page++) {
			const d = await absJSON(env, `/api/libraries/${encodeURIComponent(lib.id)}/items?minified=1&limit=${ABS_PAGE}&page=${page}`);
			const got = d.results || [];
			items.push(...got);
			if (got.length < ABS_PAGE || (page + 1) * ABS_PAGE >= (d.total || 0)) break;
		}
	}
	const { results } = await env.DB.prepare("SELECT id, abs_id, abs_updated, gone_at FROM books WHERE abs_id IS NOT NULL").all();
	const have = new Map(results.map((r) => [r.abs_id, r]));
	const seen = new Set(), stmts = [], now = Date.now();
	let added = 0, updated = 0;
	for (const it of items) {
		const media = it.media || {}, md = media.metadata || {};
		if (it.id && !it.isMissing && !it.isInvalid && ABS_EBOOKS.includes(String(media.ebookFormat || "").toLowerCase())) ebooks.push(it);
		// Ebook-only items, and ones ABS can't find on disk, aren't audiobooks here.
		if (!it.id || it.isMissing || it.isInvalid || !(media.duration > 0)) continue;
		seen.add(it.id);
		const title = str(md.title, 300) || "Untitled";
		const [series, volume] = absSeries(md.seriesName);
		const vals = [title, `${title.replace(/[\\/]/g, " ")}.audiobook`, Math.max(0, Math.round(it.size || media.size || 0)),
			str(md.authorName, 300), str(series, 300), str(volume, 20), str(md.narratorName, 300), Math.round(media.duration), it.updatedAt || now];
		const row = have.get(it.id);
		if (!row) {
			stmts.push(env.DB.prepare(
				`INSERT INTO books (title, filename, type, size, r2_key, created_at, author, series, volume, narrator, duration, abs_updated, abs_id)
				VALUES (?1, ?2, 'pdf', ?3, ?10, ?11, ?4, ?5, ?6, ?7, ?8, ?9, ?12)`,
			).bind(...vals, `abs/${it.id}`, it.addedAt || now, it.id));
			added++;
		} else if (row.abs_updated !== vals[8] || row.gone_at) {
			stmts.push(env.DB.prepare(
				`UPDATE books SET title = ?1, filename = ?2, size = ?3, author = ?4, series = ?5, volume = ?6, narrator = ?7, duration = ?8,
				abs_updated = ?9, abs_media = NULL, gone_at = NULL WHERE id = ?10`,
			).bind(...vals, row.id));
			updated++;
		}
	}
	let gone = 0;
	for (const r of results) {
		if (seen.has(r.abs_id) || r.gone_at) continue;
		stmts.push(env.DB.prepare("UPDATE books SET gone_at = ? WHERE id = ?").bind(now, r.id));
		gone++;
	}
	for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
	return { added, updated, gone, total: seen.size, ebooks: await absSyncEbooks(env, ebooks) };
}

// The ebooks among ABS's items -> {added, updated, gone, total, waiting}. The
// listing doesn't give the ebook file's size, which reading a zip needs, so
// each new or changed one is looked up, up to ABS_EBOOK_LOOKUPS a sync; the
// rest wait for the next (waiting).
const ABS_EBOOKS = ["epub", "pdf", "cbz"], ABS_EBOOK_LOOKUPS = 100;
async function absSyncEbooks(env, items) {
	const { results } = await env.DB.prepare("SELECT id, abs_ebook, abs_updated, gone_at FROM books WHERE abs_ebook IS NOT NULL").all();
	const have = new Map(results.map((r) => [r.abs_ebook, r]));
	const seen = new Set(), stmts = [], now = Date.now();
	let added = 0, updated = 0, waiting = 0, lookups = 0;
	for (const it of items) {
		seen.add(it.id);
		const row = have.get(it.id), changed = it.updatedAt || now;
		if (row && row.abs_updated === changed && !row.gone_at) continue;
		if (lookups >= ABS_EBOOK_LOOKUPS) { waiting++; continue; }
		lookups++;
		const full = await absJSON(env, `/api/items/${encodeURIComponent(it.id)}`).catch((err) => { console.warn("abs ebook", it.id, err); return null; });
		const file = full?.media?.ebookFile, ext = String(file?.ebookFormat || "").toLowerCase();
		if (!file?.ino || !(file.metadata?.size > 0) || !ABS_EBOOKS.includes(ext)) continue;
		// The listing's details: a looked-up item lists its authors and series another way.
		const md = it.media?.metadata || {};
		const title = str(md.title, 300) || "Untitled";
		const [series, volume] = absSeries(md.seriesName);
		const key = `absbook/${it.id}/${file.ino}/${Math.round(file.metadata.mtimeMs || 0)}`;
		const vals = [title, `${title.replace(/[\\/]/g, " ")}.${ext}`, file.metadata.size, str(md.authorName, 300), str(series, 300), str(volume, 20), key, changed];
		if (!row) {
			stmts.push(env.DB.prepare(
				`INSERT INTO books (title, filename, type, size, author, series, volume, r2_key, abs_updated, created_at, abs_ebook)
				VALUES (?1, ?2, 'pdf', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
			).bind(...vals, it.addedAt || now, it.id));
			added++;
		} else {
			stmts.push(env.DB.prepare(
				`UPDATE books SET title = ?1, filename = ?2, size = ?3, author = ?4, series = ?5, volume = ?6, r2_key = ?7,
				abs_updated = ?8, gone_at = NULL WHERE id = ?9`,
			).bind(...vals, row.id));
			updated++;
		}
	}
	let gone = 0;
	for (const r of results) {
		if (seen.has(r.abs_ebook) || r.gone_at) continue;
		stmts.push(env.DB.prepare("UPDATE books SET gone_at = ? WHERE id = ?").bind(now, r.id));
		gone++;
	}
	for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
	return { added, updated, gone, total: seen.size, waiting };
}

// An audiobook's files and chapters, from ABS the first time:
// {files: [{ino, size, duration, mime, ext, name}], chapters: [{start, title}],
// looked: "audible" | "none" (one file with no chapters: what audibleChapters found)}.
async function absMedia(env, book) {
	try {
		const kept = JSON.parse(book.abs_media || "null");
		// One kept from before the Audible lookup, with nothing to pick from, is fetched again.
		if (kept && (kept.chapters.length > 1 || kept.files.length > 1 || kept.looked)) return fileChapters(kept);
	} catch {}
	const item = await absJSON(env, `/api/items/${encodeURIComponent(book.abs_id)}?expanded=1`);
	const files = (item.media?.audioFiles || [])
		.filter((f) => !f.exclude && !f.invalid && f.ino)
		.sort((a, b) => (a.index || 0) - (b.index || 0))
		.map((f) => ({
			ino: String(f.ino), size: f.metadata?.size || 0, duration: f.duration || 0,
			mime: MEDIA_TYPE.test(f.mimeType || "") ? f.mimeType : "audio/mpeg", ext: String(f.metadata?.ext || "").replace(/[^\w]/g, "").slice(0, 8),
			name: str(String(f.metadata?.filename || "").replace(/\.\w{1,8}$/, ""), 200) || "",
		}));
	if (!files.length) throw new HttpError(404, "Audiobookshelf has no audio for this book");
	const chapters = (item.media?.chapters || [])
		.map((c) => ({ start: Math.max(0, Number(c.start) || 0), title: str(String(c.title ?? ""), 200) || "" }))
		.sort((a, b) => a.start - b.start);
	const media = { files, chapters };
	// A single file with no chapters in it (an .m4b without chapter marks): Audible's, when they fit.
	if (chapters.length < 2 && files.length === 1) {
		const found = await audibleChapters(item.media?.metadata || {}, files[0].duration);
		// A failed lookup (Audible unreachable) isn't kept, so the next play tries again.
		if (found) {
			media.looked = found.length ? "audible" : "none";
			if (found.length) media.chapters = found;
		}
	}
	await env.DB.prepare("UPDATE books SET abs_media = ? WHERE id = ?").bind(JSON.stringify(media), book.id).run();
	return fileChapters(media);
}

// Chapters from Audible (through Audnexus, as ABS's own "Lookup" does) for a
// file that has none: by the book's ASIN in ABS, or else the Audible release
// of its title and author that runs as long as the file. Taken only when the
// lengths agree, as they are or with Audible's intro and outro cut from the
// file, since chapters from another recording would land in the wrong places.
// -> [{start, title}], [] when nothing fits, or null when a lookup failed.
async function audibleChapters(meta, duration) {
	const get = async (url) => {
		const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
		return res.json();
	};
	const fits = (sec) => Math.abs(sec - duration) <= Math.max(30, duration * 0.002);
	try {
		const asins = [];
		if (/^[A-Z0-9]{10}$/i.test(meta.asin || "")) asins.push(meta.asin.toUpperCase());
		else if (meta.title) {
			const q = new URLSearchParams({ title: meta.title, num_results: "10", products_sort_by: "Relevance", response_groups: "product_attrs" });
			const author = String(meta.authorName || "").split(",")[0].trim();
			if (author) q.set("author", author);
			const found = await get(`https://api.audible.com/1.0/catalog/products?${q}`);
			for (const p of found?.products || []) {
				// The catalog gives whole minutes; Audnexus's exact length is checked below.
				if (p.asin && Math.abs((p.runtime_length_min || 0) * 60 - duration) <= 180) asins.push(p.asin);
			}
		}
		for (const asin of asins.slice(0, 3)) {
			const d = await get(`https://api.audnex.us/books/${asin}/chapters?region=us`);
			const list = (d?.chapters || []).filter((c) => Number.isFinite(c.startOffsetMs));
			if (list.length < 2) continue;
			const runtime = (d.runtimeLengthMs || 0) / 1000, intro = (d.brandIntroDurationMs || 0) / 1000, outro = (d.brandOutroDurationMs || 0) / 1000;
			let shift = 0;
			if (!fits(runtime)) {
				if (!(intro + outro) || !fits(runtime - intro - outro)) continue;
				shift = intro;
			}
			return list
				.map((c) => ({ start: Math.max(0, c.startOffsetMs / 1000 - shift), title: str(String(c.title ?? ""), 200) || "" }))
				.filter((c) => c.start < duration)
				.sort((a, b) => a.start - b.start);
		}
		return [];
	} catch {
		return null;
	}
}
// A book in several files with no chapters of its own: a chapter per file,
// named for the file ("03 - The Well" -> "The Well"), or Part n.
function fileChapters(media) {
	if ((media.chapters || []).length > 1 || media.files.length < 2) return media;
	let start = 0;
	const chapters = media.files.map((f, n) => {
		const c = { start, title: String(f.name || "").replace(/^\s*(?:track|part|disc|cd)?\s*\d+\s*[-_.):]*\s*/i, "").trim() || `Part ${n + 1}` };
		start += f.duration || 0;
		return c;
	});
	return { ...media, chapters };
}

// An audiobook's cover from Audiobookshelf, 600 px wide (an original can be
// a few MB), kept in R2 like the others so the home server is asked once.
// -> {img, kind}, or null when it has none.
async function absCover(env, book) {
	const res = await absFetch(env, `/api/items/${encodeURIComponent(book.abs_id || book.abs_ebook)}/cover?format=jpeg&width=600`);
	let img = null;
	if (res.ok && Number(res.headers.get("Content-Length") || 0) <= MAX_COVER_BYTES) img = new Uint8Array(await res.arrayBuffer());
	else await res.body?.cancel();
	const kind = img && imageType(img);
	await env.BOOKS.put(coverKey(book.id), kind ? img : new Uint8Array(0), { customMetadata: { src: book.r2_key, type: kind || "" } });
	return kind ? { img, kind } : null;
}

// Covers are fetched ahead, a batch each sync (newest first), so browsing
// /library never waits on the home server: hundreds of first-time covers
// at once tie up the Worker and the home upload, and slow the app with them.
// -> how many were fetched.
const ABS_COVERS_PER_RUN = 40;
async function absWarmCovers(env) {
	const { results } = await env.DB.prepare(
		"SELECT id, r2_key, abs_id, abs_ebook FROM books WHERE (abs_id IS NOT NULL OR abs_ebook IS NOT NULL) AND gone_at IS NULL ORDER BY created_at DESC, id DESC",
	).all();
	const have = await coverStates(env, new Map(results.map((b) => [b.id, b.r2_key])));
	let n = 0;
	for (const b of results) {
		if (have.has(b.id)) continue;
		if (n >= ABS_COVERS_PER_RUN) break;
		await absCover(env, b);
		n++;
	}
	return n;
}

const AUDIO_PASS = ["Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"];
async function audioFile(request, env, id, n) {
	return audioStream(request, env, await familyBook(env, id), n);
}
async function audioStream(request, env, book, n) {
	const id = book.id;
	if (bookType(book) !== "audiobook") throw new HttpError(404, "Not an audiobook");
	const file = (await absMedia(env, book)).files[n];
	if (!file) throw new HttpError(404, "No such file");
	const range = request.headers.get("Range");
	const res = await absFetch(env, `/api/items/${encodeURIComponent(book.abs_id)}/file/${encodeURIComponent(file.ino)}`, { headers: range ? { Range: range } : {} });
	if (!res.ok) {
		await res.body?.cancel();
		// ABS changed under us: look its files up again next time.
		if (res.status === 404) await env.DB.prepare("UPDATE books SET abs_media = NULL WHERE id = ?").bind(id).run();
		throw new HttpError(res.status === 416 ? 416 : 502, `Audiobookshelf answered ${res.status}`);
	}
	const headers = new Headers({ "Content-Type": file.mime, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
	for (const k of AUDIO_PASS) if (res.headers.get(k)) headers.set(k, res.headers.get(k));
	return new Response(res.body, { status: res.status, headers });
}

// The owner's app plays audiobooks in its player bar, from /listen/ addresses
// signed with READER_TOKEN: an <audio> element can't send the Bearer token,
// and the token itself never goes in an address. One lasts LISTEN_HOURS, and
// the page asks for fresh ones when they're about to run out.
const LISTEN_HOURS = 12;
function listenSig(env, id, exp) {
	return sign(env, `listen:${id}:${exp}`);
}
async function sign(env, text) {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", enc.encode(env.READER_TOKEN.trim()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
	return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}
// Whether an address's s= is the signature it should have, and it hasn't run out.
async function signedOk(env, url, text) {
	const exp = Number(url.searchParams.get("e")), given = url.searchParams.get("s") || "";
	if (!env.READER_TOKEN || !(exp > Date.now())) return false;
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(given)),
		crypto.subtle.digest("SHA-256", enc.encode(await sign(env, text(exp)))),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}
async function listenParts(env, id) {
	const book = await getBook(env, id);
	if (bookType(book) !== "audiobook" || book.gone_at) throw new HttpError(404, "Not an audiobook");
	const media = await absMedia(env, book), exp = Date.now() + LISTEN_HOURS * 3600 * 1000, s = await listenSig(env, id, exp);
	return json({
		duration: book.duration, chapters: media.chapters, expires: exp,
		files: media.files.map((f, n) => ({ duration: f.duration, url: `/listen/${id}/${n}?e=${exp}&s=${s}` })),
		download: `/listen/${id}/file?e=${exp}&s=${s}`,
	});
}
async function listenFile(request, env, url, id, n) {
	if (!(await signedOk(env, url, (exp) => `listen:${id}:${exp}`))) throw new HttpError(403, "This address has run out");
	const book = await getBook(env, id);
	if (book.gone_at) throw new HttpError(404, "Audiobookshelf no longer has this audiobook");
	return n === "file" ? audiobookDownload(env, book, null) : audioStream(request, env, book, Number(n));
}
// A podcast episode for the player bar with voice boost on: Web Audio only
// hears files from this site, so it streams through here, from an address
// signed as /listen/'s are (an <audio> can't send the token).
async function mediaListen(env, raw) {
	if (!raw) throw new HttpError(400, "No url");
	const exp = Date.now() + LISTEN_HOURS * 3600 * 1000, s = await sign(env, `media:${raw}:${exp}`);
	return json({ url: `/media?u=${encodeURIComponent(raw)}&e=${exp}&s=${s}`, expires: exp });
}
async function mediaFile(request, env, url) {
	const raw = url.searchParams.get("u") || "";
	if (!(await signedOk(env, url, (exp) => `media:${raw}:${exp}`))) throw new HttpError(403, "This address has run out");
	return proxyMedia(raw, env, request.headers.get("Range"));
}
function errorJSON(err) {
	return json({ error: String(err?.message || err) }, err instanceof HttpError ? err.status : 500);
}

async function audiobookDownload(env, book, person) {
	const media = await absMedia(env, book);
	const one = media.files.length === 1 ? media.files[0] : null;
	const res = await absFetch(env, `/api/items/${encodeURIComponent(book.abs_id)}` + (one ? `/file/${encodeURIComponent(one.ino)}` : "/download"));
	if (!res.ok) {
		await res.body?.cancel();
		throw new HttpError(502, `Audiobookshelf answered ${res.status}`);
	}
	if (person) await env.DB.prepare("INSERT INTO downloads (person_id, book_id, at) VALUES (?, ?, ?)").bind(person.id, book.id, Date.now()).run();
	const name = downloadName(book).replace(/\.audiobook$/, "." + (one ? one.ext || "m4b" : "zip"));
	const headers = new Headers({
		"Content-Type": one ? one.mime : "application/zip",
		"Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
		"Cache-Control": "private, no-store",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'; sandbox",
	});
	if (res.headers.get("Content-Length")) headers.set("Content-Length", res.headers.get("Content-Length"));
	return new Response(res.body, { headers });
}

// Reading online: the whole book read in the page, as a whole audiobook can
// be listened to. It isn't a download, so it doesn't count toward the 10 a day.
//   EPUB and .txt: the text as paragraphs, a piece at a time (whole
//     chapters of an EPUB up to about 30 pages, about that much of a text
//     file), the next asked for as the reader gets near the end of what's
//     there. The page lays it out; none of the book's own markup, styles or
//     images reach it.
//   Comics: every page, one image each.
//   PDF: pdf.js draws the pages from the pieces of the file it asks for.
// The pinned pdf.js: the family page's reading, the app's reader (PDFJS and
// PDFJS_DATA there) and the service worker all take it from here.
const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/";
const PDFJS_DATA_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/";
const READ_PIECE_PAGES = 30;
const READ_PIECE_CHAPTERS = 40;
const READ_PIECE_BYTES = 96 * 1024;

function wordCount(s) {
	const m = s.match(/\S+/g);
	return m ? m.length : 0;
}

async function familyPreview(env, id, url) {
	const book = await familyBook(env, id);
	const type = bookType(book);
	if (type === "audiobook") {
		const media = await absMedia(env, book);
		return json({ type, files: media.files.map((f) => ({ duration: f.duration })), chapters: media.chapters, duration: book.duration });
	}
	const at = Math.max(0, Math.floor(Number(url.searchParams.get("at"))) || 0);
	if (type === "epub") return json({ type, ...(await epubPiece(env, book, at)) });
	if (type === "txt") return json({ type, ...(await txtPiece(env, book, at)) });
	if (type === "cbz") {
		const total = (await comicImages(env, book)).length;
		if (!total) throw new HttpError(422, "This comic has no pages to show");
		return json({ type, pages: total });
	}
	return json({ type, size: book.size });
}

// A chapter's XHTML -> [{k: "p" | "h" | "q", r: [[text, ""|"i"|"b"|"ib"], ...]}]:
// headings, paragraphs and quotations with their italics and bold, and
// nothing else (no attributes, links, images or styles).
const PREVIEW_BLOCK = /^(p|div|h[1-6]|li|blockquote|section|article|aside|header|footer|figure|figcaption|dt|dd|tr|pre|hr|table|ul|ol|dl|nav|body)$/;
function htmlBlocks(html) {
	const body = (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html) || [null, html])[1]
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|svg|math|head|title|noscript)\b[\s\S]*?<\/\1\s*>/gi, "");
	const blocks = [];
	let cur = { k: "p", r: [] }, em = 0, strong = 0, quote = 0, heading = 0;
	const flush = () => {
		const r = cur.r;
		if (r.length) {
			r[0][0] = r[0][0].replace(/^\s+/, "");
			r[r.length - 1][0] = r[r.length - 1][0].replace(/\s+$/, "");
			const text = r.map((x) => x[0]).join("");
			if (text.trim()) blocks.push({ k: cur.k, r: r.filter((x) => x[0]) });
		}
		cur = { k: heading ? "h" : quote ? "q" : "p", r: [] };
	};
	const add = (text) => {
		const style = (em > 0 ? "i" : "") + (strong > 0 ? "b" : "");
		const last = cur.r[cur.r.length - 1];
		if (last && last[1] === style) last[0] += text;
		else cur.r.push([text, style]);
	};
	for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*>|([^<]+)/g)) {
		if (m[3] !== undefined) {
			const text = htmlEntities(m[3]).replace(/\s+/g, " ");
			if (text) add(text);
			continue;
		}
		const close = m[1] === "/", tag = m[2].toLowerCase().replace(/^\w+:/, "");
		if (tag === "br") { add("\n"); continue; }
		if (tag === "i" || tag === "em" || tag === "cite") { em += close ? -1 : 1; continue; }
		if (tag === "b" || tag === "strong") { strong += close ? -1 : 1; continue; }
		if (!PREVIEW_BLOCK.test(tag) && !/^h[1-6]$/.test(tag)) continue;
		if (/^h[1-6]$/.test(tag)) heading = Math.max(0, heading + (close ? -1 : 1));
		if (tag === "blockquote") quote = Math.max(0, quote + (close ? -1 : 1));
		flush();
	}
	flush();
	return blocks;
}
// An EPUB from chapter at (in the spine): whole chapters until about 30
// pages, each after the first starting after a break.
async function epubPiece(env, book, at) {
	const zip = await r2Zip(env, book.r2_key, book.size);
	if (!zip) throw new HttpError(422, "This EPUB can't be read");
	const { opf, dir } = await epubPackage(env, zip);
	const byName = (n) => zip.files.find((f) => f.name === n) || zip.files.find((f) => f.name.toLowerCase() === n.toLowerCase());
	const hrefs = {};
	for (const m of opf.matchAll(/<(?:\w+:)?item\b[^>]*>/gi)) {
		const id = xmlAttr(m[0], "id"), href = xmlAttr(m[0], "href");
		if (id && href) hrefs[id] = href;
	}
	const spine = [...opf.matchAll(/<(?:\w+:)?itemref\b[^>]*>/gi)]
		.filter((m) => xmlAttr(m[0], "linear") !== "no")
		.map((m) => hrefs[xmlAttr(m[0], "idref")]).filter(Boolean)
		.map((href) => byName(resolveZipPath(dir, href))).filter(Boolean);
	const blocks = [];
	let words = 0, i = at;
	for (; i < spine.length && i < at + READ_PIECE_CHAPTERS && words < READ_PIECE_PAGES * WORDS_PER_PAGE; i++) {
		const data = await r2ZipRead(env, zip, spine[i]);
		if (!data) continue;
		const chapter = htmlBlocks(new TextDecoder().decode(data));
		if (!chapter.length) continue;
		if (blocks.length) blocks.push({ k: "hr", r: [] });
		blocks.push(...chapter);
		words += wordCount(chapter.map((b) => b.r.map((x) => x[0]).join("")).join(" "));
	}
	if (!at && !blocks.length && i >= spine.length) throw new HttpError(422, "This EPUB has no text to show");
	return { blocks, at, next: i < spine.length ? i : null };
}

// A text file from byte at: about 30 pages, up to the last paragraph break
// in them so the next piece starts on a new paragraph (and never inside a
// character).
async function txtPiece(env, book, at) {
	const size = book.size || 0;
	if (at >= size) {
		if (!at) throw new HttpError(422, "This file has no text to show");
		return { blocks: [], at, next: null };
	}
	const raw = await r2Bytes(env, book.r2_key, at, Math.min(READ_PIECE_BYTES, size - at));
	if (!raw) throw new HttpError(404, "The file is missing from storage");
	let end = raw.length;
	if (at + end < size) {
		const brk = (from) => {
			for (let j = from; j > 0; j--) if (raw[j] === 10 && (raw[j - 1] === 10 || (raw[j - 1] === 13 && raw[j - 2] === 10))) return j + 1;
			return 0;
		};
		end = brk(end - 1) || raw.lastIndexOf(10) + 1 || raw.lastIndexOf(32) + 1 || end - 1;
		while (end < raw.length && end > 0 && (raw[end] & 0xc0) === 0x80) end--;
	}
	let text = new TextDecoder().decode(raw.subarray(0, end)).replace(/\r\n?/g, "\n");
	// A YAML header (title, author...) isn't part of the book.
	if (!at) text = text.replace(/^\uFEFF/, "").replace(/^---\n[\s\S]*?\n---\n/, "");
	const blocks = text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim()).filter(Boolean)
		.map((p) => ({ k: "p", r: [[p, ""]] }));
	return { blocks, at, next: at + end < size ? at + end : null };
}

// Where previews kept a PDF cut to its first pages (previews/<book id>);
// deleting a book still clears any left there.
function previewKey(id) { return `previews/${id}`; }

const latin1 = (b) => new TextDecoder("latin1").decode(b);

// A comic's page images in reading order (as the reader sorts them).
async function comicImages(env, book) {
	const zip = await r2Zip(env, book.r2_key, book.size);
	if (!zip) return [];
	const pages = zip.files.filter((f) => COVER_IMAGE.test(f.name) && !/(^|\/)(__MACOSX\/|\.)/.test(f.name));
	pages.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
	pages.zip = zip;
	return pages;
}
async function previewComicPage(env, id, n) {
	const book = await familyBook(env, id);
	if (bookType(book) !== "cbz") throw new HttpError(404, "Not a comic");
	const pages = await comicImages(env, book);
	if (!Number.isInteger(n) || n < 0 || n >= pages.length) throw new HttpError(404, "That page isn't in this comic");
	const img = await r2ZipRead(env, pages.zip, pages[n]);
	const kind = img && imageType(img);
	if (!kind) throw new HttpError(422, "That page can't be shown");
	const res = coverResponse(img, kind);
	res.headers.set("Cache-Control", "private, max-age=86400");
	return res;
}

// A piece of a PDF for pdf.js. The pieces can be kept by the browser for a
// day, so opening the book again reads them from there.
async function previewPart(env, id, url) {
	const book = await familyBook(env, id);
	if (bookType(book) !== "pdf") throw new HttpError(404, "Not a PDF");
	const at = Number(url.searchParams.get("at")), want = Number(url.searchParams.get("len"));
	if (!Number.isInteger(at) || !Number.isInteger(want) || at < 0 || want < 1 || want > 4 * 1024 * 1024 || at >= book.size) {
		throw new HttpError(400, "at and len must be whole numbers inside the file, len up to 4 MB");
	}
	const obj = await bookObject(env, book.r2_key, { offset: at, length: Math.min(want, book.size - at) });
	if (!obj) throw new HttpError(404, "The file is missing from storage");
	return new Response(obj.body, {
		headers: { "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
	});
}

// Book records: what the family library's Record page shows about a book
// before it's downloaded. The jacket copy (blurb) and page count come from
// the file first (an EPUB's dc:description, a comic's ComicInfo.xml Summary
// and its pages), then Open Library, then Google Books, matched the way the
// genre tags are (same title, an author sharing a word). With no page count
// anywhere, the text's length gives an estimate ("About 320 pages").
//
// Appeal terms are the readers' advisory kind a librarian uses (Joyce
// Saricks' appeal factors, as NoveList has them): pacing, tone, writing
// style, characters and storyline. No free catalog has them, so a model
// picks them from the fixed lists below, from what it knows of the book and
// the blurb: Claude when ANTHROPIC_API_KEY is set (it knows far more books),
// else Workers AI. When neither has a blurb, the model writes a short one if
// it knows the book, marked as such on the page. A book it doesn't know and
// has nothing on gets no terms rather than guessed ones.
//
// A record is filled the first time anyone opens it and kept (record_at);
// one that got no appeal terms is tried again after a day, or at once by
// Look up records, and record_from.appeal_error says why it got none.
// Anything typed in Edit details is marked "edited" and never replaced.

const APPEAL = {
	pacing: ["Fast-paced", "Steady", "Leisurely", "Slow-building", "Unhurried", "Episodic"],
	tone: ["Adventurous", "Atmospheric", "Bleak", "Creepy", "Dark", "Darkly humorous", "Epic", "Funny", "Gritty", "Haunting",
		"Heartwarming", "Hopeful", "Intense", "Melancholy", "Menacing", "Moving", "Nostalgic", "Offbeat", "Playful",
		"Reflective", "Romantic", "Suspenseful", "Thought-provoking", "Upbeat", "Whimsical", "Wry"],
	style: ["Accessible", "Archaic", "Compelling", "Conversational", "Dense", "Descriptive", "Dialogue-rich", "Engaging",
		"Informative", "Lyrical", "Poetic", "Richly detailed", "Scholarly", "Spare", "Stylistically complex", "Witty"],
	characters: ["Antihero", "Complex", "Ensemble cast", "Flawed", "Larger than life", "Likeable", "Memorable villain",
		"Morally ambiguous", "Quirky", "Strong female lead", "Sympathetic", "Unreliable narrator", "Well-developed"],
	story: ["Action-packed", "Character-driven", "Coming-of-age", "Interconnected stories", "Intricately plotted",
		"Issue-oriented", "Mystery to solve", "Multiple perspectives", "Nonlinear", "Open-ended", "Plot-driven",
		"Political intrigue", "Quest", "Survival", "Sweeping", "Twisty", "World-building"],
};
const RECORD_CLAUDE_MODEL = "claude-opus-5-5";
const RECORD_AI_MODEL = COVERAGE_AI_MODEL;
const BLURB_MAX = 4000;
const RECORD_RETRY_MS = 24 * 60 * 60 * 1000;
// Words to a printed page, for an estimate (the reader's CHARS_PER_PAGE is this at 6 characters a word).
const WORDS_PER_PAGE = 275;

// Catalog details: the same on the family Record and the site's book logs.
const CATALOG_FIELDS = ["year", "publisher", "language", "classification", "isbn", "subjects"];
const LANGUAGES = { en: "English", eng: "English", fr: "French", fre: "French", fra: "French", de: "German", ger: "German", deu: "German",
	es: "Spanish", spa: "Spanish", it: "Italian", ita: "Italian", ja: "Japanese", jpn: "Japanese", la: "Latin", lat: "Latin",
	ang: "Old English", enm: "Middle English", grc: "Ancient Greek", el: "Greek", gre: "Greek", ru: "Russian", rus: "Russian",
	pt: "Portuguese", por: "Portuguese", nl: "Dutch", dut: "Dutch", sv: "Swedish", swe: "Swedish", zh: "Chinese", chi: "Chinese", ga: "Irish", gle: "Irish" };
function isbnOf(s) {
	const d = String(s || "").replace(/^urn:isbn:|^isbn:?\s*/i, "").replace(/[\s-]/g, "");
	return /^(97[89]\d{10}|\d{9}[\dXx])$/.test(d) ? d.toUpperCase() : null;
}
// Raw values -> the tidy ones kept: a four-digit year, a language name (from
// a code like "en" or "eng"), digits-only ISBN; unknown fields dropped.
function cleanCatalog(c) {
	const out = {};
	if (!c || typeof c !== "object") return out;
	const year = /\b(\d{4})\b/.exec(String(c.year ?? ""));
	if (year && +year[1] > 0 && +year[1] <= new Date().getFullYear() + 1) out.year = year[1];
	for (const k of ["publisher", "classification"]) { const v = str(c[k] == null ? null : String(c[k]), 120); if (v) out[k] = v; }
	const lang = str(c.language == null ? null : String(c.language), 40);
	if (lang) out.language = LANGUAGES[lang.toLowerCase().split(/[-_]/)[0]] || (lang.length > 3 ? lang : null);
	if (!out.language) delete out.language;
	const isbn = isbnOf(c.isbn);
	if (isbn) out.isbn = isbn;
	// Subject headings: a list, or one string with "; " between them.
	const subjects = (Array.isArray(c.subjects) ? c.subjects : String(c.subjects ?? "").split(";"))
		.map((t) => str(String(t ?? ""), 120)).filter(Boolean);
	if (subjects.length) out.subjects = [...new Set(subjects)].slice(0, 10);
	return out;
}

// The Library of Congress catalog (its SRU search, on port 210; no key):
// {classification, subjects, year, publisher, language} from the MARC record
// for this ISBN, else for this title and author. Its Dewey number (082), else
// its LC call number (050), and its LC subject headings (6XX, second
// indicator 0). null when LC has no record, as for most self-published and
// ebook-only books.
const LOC_SRU = "http://lx2.loc.gov:210/lcdb";
async function locRecord(isbn, title, author) {
	const search = async (query) => {
		const res = await fetch(LOC_SRU + "?" + new URLSearchParams({
			version: "1.1", operation: "searchRetrieve", query, maximumRecords: "5", recordSchema: "marcxml",
		}), { headers: { "User-Agent": LOOKUP_UA } });
		if (!res.ok) {
			await res.body?.cancel();
			throw new HttpError(502, `lx2.loc.gov answered ${res.status}`);
		}
		return marcRecords(await res.text());
	};
	const want = looseTitle(title);
	const surname = looseTitle(String(author || "").split(/,|&| and /)[0]).split(" ").pop();
	const fits = (m) => {
		const t = looseTitle(m.title);
		return !want || t === want || t.startsWith(want + " ") || want.startsWith(t + " ");
	};
	const byAuthor = (m) => !surname || looseTitle(m.author).split(" ").includes(surname);
	let found = isbn ? (await search(`bath.isbn=${isbn}`))[0] : null;
	if (!found && want) {
		const q = `dc.title="${want}"` + (surname ? ` and dc.creator="${surname}"` : "");
		found = (await search(q)).find((m) => fits(m) && byAuthor(m));
	}
	return found ? found.catalog : null;
}
// MARCXML (an SRU answer) -> [{title, author, catalog}].
function marcRecords(xml) {
	return [...xml.matchAll(/<(?:\w+:)?record\b[^>]*>([\s\S]*?)<\/(?:\w+:)?record>/g)]
		.filter((m) => /<(?:\w+:)?datafield\b/.test(m[1]))
		.map((m) => marcRecord(m[1]));
}
function marcRecord(xml) {
	const fields = [...xml.matchAll(/<(?:\w+:)?datafield\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?datafield>/g)].map((m) => ({
		tag: (/\btag="(\d{3})"/.exec(m[1]) || [])[1],
		ind2: (/\bind2="(.)"/.exec(m[1]) || [])[1],
		subs: [...m[2].matchAll(/<(?:\w+:)?subfield\b[^>]*\bcode="(.)"[^>]*>([\s\S]*?)<\/(?:\w+:)?subfield>/g)].map((s) => [s[1], xmlText(s[2])]),
	}));
	const field = (tag) => fields.find((f) => f.tag === tag);
	const sub = (f, codes) => (f ? f.subs.filter(([c]) => codes.includes(c)).map(([, v]) => v) : []);
	// ISBD punctuation ("Dune /", "Chilton Books,", "1965.") goes.
	const tidy = (v) => String(v || "").replace(/\s*[\/:;,=]\s*$/, "").replace(/(\w{3,})\.$/, "$1").replace(/^\[|\]$/g, "").trim();
	const control = (/<(?:\w+:)?controlfield\b[^>]*\btag="008"[^>]*>([^<]*)</.exec(xml) || [])[1] || "";
	const pub = field("264") || field("260");
	const dewey = sub(field("082"), ["a"])[0];
	const lcc = sub(field("050"), ["a", "b"]).join(" ");
	const subjects = fields
		.filter((f) => ["600", "610", "611", "630", "650", "651"].includes(f.tag) && f.ind2 === "0")
		.map((f) => {
			const main = sub(f, ["a", "b", "c", "d", "t"]).map(tidy).join(" ");
			return [main, ...sub(f, ["v", "x", "y", "z"]).map(tidy)].filter(Boolean).join(" -- ");
		});
	return {
		title: tidy(sub(field("245"), ["a", "b"]).join(" ")),
		author: tidy(sub(field("100") || field("110"), ["a"])[0]),
		catalog: cleanCatalog({
			classification: dewey ? dewey.replace(/\//g, "") : lcc || null,
			subjects,
			year: sub(pub, ["c"])[0] || control.slice(7, 11),
			publisher: tidy(sub(pub, ["b"])[0]),
			language: control.slice(35, 38).trim(),
		}),
	};
}

// The named entities descriptions use besides XML's own.
const HTML_ENTITIES = { nbsp: " ", ldquo: "\u201c", rdquo: "\u201d", lsquo: "\u2018", rsquo: "\u2019", mdash: "\u2014", ndash: "\u2013",
	hellip: "\u2026", eacute: "\u00e9", egrave: "\u00e8", aacute: "\u00e1", iacute: "\u00ed", oacute: "\u00f3", uacute: "\u00fa",
	ouml: "\u00f6", uuml: "\u00fc", auml: "\u00e4", ccedil: "\u00e7", ntilde: "\u00f1", copy: "\u00a9", reg: "\u00ae", trade: "\u2122", laquo: "\u00ab", raquo: "\u00bb" };
function htmlEntities(t) {
	return decodeXml(t)
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&([a-z]+);/gi, (m, n) => HTML_ENTITIES[n] ?? m);
}
// HTML or plain description text -> paragraphs separated by blank lines,
// without Open Library's trailing "----------" link lists and [n] links.
function blurbText(s) {
	let t = String(s || "")
		.replace(/<\s*br\s*\/?>/gi, "\n")
		.replace(/<\/\s*(p|div|li|h\d)\s*>/gi, "\n\n")
		.replace(/<[^>]+>/g, "");
	t = htmlEntities(t);
	t = t.split(/\n\s*-{4,}\s*\n|\n\s*\[1\]:/)[0]
		.replace(/\(\[source\]\[\d+\]\)/gi, "")
		.replace(/\[([^\]]+)\]\[\d+\]/g, "$1")
		.replace(/[ \t]+/g, " ")
		.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean).join("\n\n");
	if (t.length > BLURB_MAX) t = t.slice(0, BLURB_MAX).replace(/\s+\S*$/, "") + "…";
	return t || null;
}

// What the file says: {blurb, pages, words} (each null when it doesn't say).
async function fileRecord(env, book) {
	const type = bookType(book), out = { blurb: null, pages: null, words: null, catalog: {} };
	if (type === "epub") {
		const zip = await r2Zip(env, book.r2_key, book.size);
		if (!zip) return out;
		const { opf } = await epubPackage(env, zip);
		const md = (/<(?:\w+:)?metadata\b[\s\S]*?<\/(?:\w+:)?metadata>/i.exec(opf) || [opf])[0];
		const desc = /<dc:description\b[^>]*>([\s\S]*?)<\/dc:description>/i.exec(md);
		// The description is often escaped HTML (&lt;p&gt;), so it's unescaped before the tags go.
		if (desc) out.blurb = blurbText(decodeXml(desc[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")));
		const el = (name) => [...md.matchAll(new RegExp(`<dc:${name}\\b[^>]*>([\\s\\S]*?)</dc:${name}>`, "gi"))].map((m) => xmlText(m[1])).filter(Boolean);
		out.catalog = cleanCatalog({ year: el("date")[0], publisher: el("publisher")[0], language: el("language")[0], isbn: el("identifier").find(isbnOf) });
		// About 6 characters a word once the markup is gone, which is roughly a third of an XHTML file.
		const chars = zip.files.filter((f) => /\.x?html?$/i.test(f.name)).reduce((n, f) => n + f.usize, 0);
		if (chars) out.words = Math.round(chars * 0.35 / 6);
	} else if (type === "cbz") {
		const zip = await r2Zip(env, book.r2_key, book.size);
		if (!zip) return out;
		out.pages = zip.files.filter((f) => COVER_IMAGE.test(f.name) && !/(^|\/)(__MACOSX\/|\.)/.test(f.name)).length || null;
		const el = await comicInfo(env, book);
		if (el) {
			out.blurb = blurbText(el("Summary"));
			out.catalog = cleanCatalog({ year: el("Year"), publisher: el("Publisher"), language: el("LanguageISO") });
		}
	} else if (type === "pdf") {
		// Known once it has been opened in the reader.
		try { out.pages = JSON.parse(book.position || "null")?.pages || null; } catch {}
	} else if (type === "txt") {
		out.words = Math.round((book.size || 0) / 6);
	} else if (type === "audiobook") {
		const md = (await absJSON(env, `/api/items/${encodeURIComponent(book.abs_id)}`)).media?.metadata || {};
		out.blurb = blurbText(md.description);
		out.catalog = cleanCatalog({ year: md.publishedYear, publisher: md.publisher, language: md.language, isbn: md.isbn });
	}
	return out;
}

// Open Library, then Google Books: {blurb, pages, catalog, from: {blurb,
// pages, catalog: {field: source}}}, each only from a match with the same
// title and author. need: the catalog fields still wanted.
async function onlineRecord(title, author, need = CATALOG_FIELDS) {
	const want = looseTitle(title), out = { blurb: null, pages: null, catalog: {}, from: { catalog: {} } };
	const take = (found, source) => {
		for (const [k, v] of Object.entries(cleanCatalog(found))) {
			if (need.includes(k) && !out.catalog[k]) { out.catalog[k] = v; out.from.catalog[k] = source; }
		}
	};
	const done = () => out.blurb && out.pages && need.every((k) => out.catalog[k]);
	if (!want) return out;
	const surname = looseTitle(String(author || "").split(/,|&| and /)[0]).split(" ").pop();
	const same = (t) => { const a = looseTitle(t); return a === want || want.startsWith(a + " ") || a.startsWith(want + " "); };
	const byAuthor = (names) => !surname || (names || []).some((n) => looseTitle(n).split(" ").includes(surname));
	await within(async () => {
		const q = [title, author].filter(Boolean).join(" ");
		const data = await lookupJSON("https://openlibrary.org/search.json?" + new URLSearchParams({
			q, fields: "key,title,author_name,number_of_pages_median,first_publish_year,publisher,language,isbn,ddc,lcc", limit: "10",
		}));
		const hit = (data.docs || []).find((d) => same(d.title) && byAuthor(d.author_name) && /^\/works\/OL\d+W$/.test(d.key || ""));
		if (!hit) return;
		if (Number.isInteger(hit.number_of_pages_median) && hit.number_of_pages_median > 0) { out.pages = hit.number_of_pages_median; out.from.pages = "openlibrary"; }
		// The first year it came out; a publisher and ISBN from its editions; Dewey, else Library of Congress.
		take({
			year: hit.first_publish_year, publisher: (hit.publisher || [])[0], language: (hit.language || []).includes("eng") ? "eng" : (hit.language || [])[0],
			isbn: (hit.isbn || []).find((i) => i.length === 13) || (hit.isbn || [])[0], classification: (hit.ddc || [])[0] || (hit.lcc || [])[0],
		}, "openlibrary");
		const work = await lookupJSON(`https://openlibrary.org${hit.key}.json`);
		const desc = blurbText(typeof work.description === "string" ? work.description : work.description?.value);
		if (desc) { out.blurb = desc; out.from.blurb = "openlibrary"; }
	}, null, 8000);
	if (done()) return out;
	await within(async () => {
		const q = [`intitle:${title}`].concat(author ? [`inauthor:${String(author).split(",")[0]}`] : []).join(" ");
		const data = await lookupJSON("https://www.googleapis.com/books/v1/volumes?" + new URLSearchParams({ q, maxResults: "5", printType: "books" }));
		for (const it of data.items || []) {
			const v = it.volumeInfo || {};
			if (!same(v.title || "") || !byAuthor(v.authors)) continue;
			if (!out.blurb && v.description) { out.blurb = blurbText(v.description); if (out.blurb) out.from.blurb = "google"; }
			if (!out.pages && Number.isInteger(v.pageCount) && v.pageCount > 0) { out.pages = v.pageCount; out.from.pages = "google"; }
			const ids = Object.fromEntries((v.industryIdentifiers || []).map((i) => [i.type, i.identifier]));
			take({ year: v.publishedDate, publisher: v.publisher, language: v.language, isbn: ids.ISBN_13 || ids.ISBN_10 }, "google");
			if (done()) break;
		}
	}, null, 8000);
	return out;
}

const APPEAL_SYSTEM = `You are a readers' advisory librarian. For one book in a family's home library, you pick its appeal terms: the words a librarian uses to say what a book feels like to read (Joyce Saricks' appeal factors, as NoveList uses them), so someone can tell if it suits them.

Rules:
- Base it on what you know of this book (title, author, series) and on the jacket copy if there is one. Describe this book, not its genre in general.
- Pick from the allowed terms only: one to three per factor, the ones that fit best. Leave a factor empty if none fits (poetry and reference books often have no characters or storyline).
- If you don't recognize the book and the jacket copy is missing or tells you too little, set "known" to false and leave every factor empty. Never guess from the title alone.
- "blurb": only when no jacket copy is given and you know the book well, two or three sentences of jacket copy: what it's about and why someone would enjoy it, without spoilers past the opening. Otherwise "".`;

const APPEAL_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["known", "pacing", "tone", "style", "characters", "story", "blurb"],
	properties: {
		known: { type: "boolean", description: "Whether you know enough about this book to describe it." },
		...Object.fromEntries(Object.entries(APPEAL).map(([k, terms]) => [k, { type: "array", items: { type: "string", enum: terms } }])),
		blurb: { type: "string" },
	},
};

const APPEAL_AI_SCHEMA = {
	type: "object",
	required: APPEAL_SCHEMA.required,
	properties: {
		known: { type: "boolean" },
		...Object.fromEntries(Object.keys(APPEAL).map((k) => [k, { type: "array", items: { type: "string" } }])),
		blurb: { type: "string" },
	},
};

function appealPrompt(book, blurb, tags) {
	const lines = [
		`Title: ${book.title}`,
		book.author && `Author: ${book.author}`,
		book.series && `Series: ${book.series}${book.volume ? `, book ${book.volume}` : ""}`,
		bookType(book) === "cbz" && "Format: comic",
		bookType(book) === "audiobook" && `Format: audiobook${book.narrator ? `, narrated by ${book.narrator}` : ""}`,
		tags.length && `Library tags: ${tags.join(", ")}`,
	].filter(Boolean);
	return `${lines.join("\n")}\n\n${blurb ? `<jacket_copy>\n${blurb}\n</jacket_copy>` : "No jacket copy."}\n\nPick this book's appeal terms.`;
}

// -> {appeal, blurb, model}, or null with no model to ask.
async function appealTerms(env, book, blurb, tags) {
	if (!env.ANTHROPIC_API_KEY && !env.AI) return null;
	let answer, model;
	if (env.ANTHROPIC_API_KEY) {
		answer = await claudeJSON(env, { model: RECORD_CLAUDE_MODEL, maxTokens: 4000, effort: "low", schema: APPEAL_SCHEMA, system: APPEAL_SYSTEM, user: appealPrompt(book, blurb, tags) });
		model = RECORD_CLAUDE_MODEL;
	} else {
		// Workers AI's JSON mode gives up ("JSON Mode couldn't be met") on a
		// schema this size with enums, so its schema has plain strings, the
		// allowed terms go in the prompt, and cleanAppeal keeps only those.
		const lists = Object.entries(APPEAL).map(([k, terms]) => `${k}: ${terms.join(", ")}`).join("\n");
		const out = await env.AI.run(RECORD_AI_MODEL, {
			messages: [
				{ role: "system", content: `${APPEAL_SYSTEM}\n\nAllowed terms, by factor:\n${lists}` },
				{ role: "user", content: appealPrompt(book, blurb, tags) },
			],
			response_format: { type: "json_schema", json_schema: APPEAL_AI_SCHEMA },
			max_tokens: 800,
		});
		const raw = out?.response;
		answer = typeof raw === "string" ? JSON.parse((/\{[\s\S]*\}/.exec(raw) || [raw])[0]) : raw;
		model = RECORD_AI_MODEL.replace(/^@cf\/[^/]+\//, "");
	}
	if (!answer || typeof answer !== "object") throw new Error("No answer");
	return { appeal: answer.known === false ? null : cleanAppeal(answer, true), blurb: blurb ? null : blurbText(answer.blurb), model };
}

// Only known factors, each a short list of short terms; strict: only the
// allowed ones (a model's), else anything (typed in Edit details). null when empty.
function cleanAppeal(a, strict) {
	if (!a || typeof a !== "object") return null;
	const out = {}, key = (t) => String(t).toLowerCase().replace(/[^a-z]+/g, "");
	for (const [k, terms] of Object.entries(APPEAL)) {
		const got = Array.isArray(a[k]) ? a[k] : [];
		// A model's "fast paced" is the list's "Fast-paced".
		const named = strict ? got.map((t) => terms.find((x) => key(x) === key(t))) : got.map((t) => str(t, 40));
		const list = [...new Set(named.filter(Boolean))].slice(0, strict ? 3 : 6);
		if (list.length) out[k] = list;
	}
	return Object.keys(out).length ? out : null;
}

function recordJSON(book) {
	let appeal = null, from = {};
	try { appeal = JSON.parse(book.appeal || "null"); } catch {}
	try { from = JSON.parse(book.record_from || "{}") || {}; } catch {}
	let catalog = {};
	try { catalog = JSON.parse(book.catalog || "{}") || {}; } catch {}
	return { blurb: book.blurb || null, pages: book.pages || null, appeal, catalog, from, filled: !!book.record_at };
}
// soon: the owner's Look up records, which tries a record without appeal terms again at once.
function recordDue(book, soon) {
	if (!book.record_at) return true;
	const r = recordJSON(book);
	// Records looked up before catalog details (or the Library of Congress) existed get them once.
	if (!r.from.catalog || !r.from.loc) return true;
	return !r.appeal && r.from.appeal !== "edited" && (soon || Date.now() - book.record_at > RECORD_RETRY_MS);
}

// Fills in what's missing (all of it with refresh, except anything edited)
// and saves it. book: a books row (with r2_key). -> the record.
async function fillRecord(env, book, refresh) {
	const had = recordJSON(book), from = { ...had.from };
	const keep = (k) => from[k] === "edited" || (!refresh && had[k]);
	let blurb = keep("blurb") ? had.blurb : null, pages = keep("pages") ? had.pages : null, appeal = keep("appeal") ? had.appeal : null;
	if (!keep("blurb")) delete from.blurb;
	if (!keep("pages")) delete from.pages;
	if (!keep("appeal")) delete from.appeal;
	// An audiobook's length is its duration (on the row), so it gets no page count.
	const audio = bookType(book) === "audiobook";
	let file = { blurb: null, pages: null, words: null, catalog: {} };
	try { file = await fileRecord(env, book); } catch (err) { console.warn("record file", book.id, err); }
	if (!blurb && file.blurb) { blurb = file.blurb; from.blurb = "file"; }
	if (!pages && file.pages) { pages = file.pages; from.pages = "file"; }
	// Catalog fields one by one: an edited one stays, a known one stays unless refreshing.
	const catFrom = { ...(from.catalog || {}) }, catalog = {};
	for (const k of CATALOG_FIELDS) {
		if (had.catalog[k] && (catFrom[k] === "edited" || !refresh)) catalog[k] = had.catalog[k];
		else delete catFrom[k];
	}
	for (const [k, v] of Object.entries(file.catalog || {})) if (!catalog[k]) { catalog[k] = v; catFrom[k] = "file"; }
	const need = CATALOG_FIELDS.filter((k) => !catalog[k]);
	if (!blurb || (!pages && !audio) || need.length) {
		const online = await onlineRecord(book.title, book.author || "", need);
		if (!blurb && online.blurb) { blurb = online.blurb; from.blurb = online.from.blurb; }
		if (!pages && !audio && online.pages) { pages = online.pages; from.pages = online.from.pages; }
		for (const [k, v] of Object.entries(online.catalog)) { catalog[k] = v; catFrom[k] = online.from.catalog[k]; }
	}
	// The Library of Congress's call number and subject headings win over
	// Open Library's and Google's; its other details only fill gaps. Edits stay.
	const loc = await within(() => locRecord(catalog.isbn, book.title, book.author || ""), undefined, 8000);
	// "unreached" (LC down, or too slow) isn't tried again until the next refresh.
	from.loc = loc === undefined ? "unreached" : loc ? "found" : "none";
	for (const [k, v] of Object.entries(loc || {})) {
		if (catFrom[k] === "edited" || catFrom[k] === "file") continue;
		if (k === "classification" || k === "subjects" || !catalog[k]) { catalog[k] = v; catFrom[k] = "loc"; }
	}
	from.catalog = catFrom;
	if (!pages && file.words > 2000) { pages = Math.max(1, Math.round(file.words / WORDS_PER_PAGE)); from.pages = "estimate"; }
	if (!keep("appeal")) {
		const { results } = await env.DB.prepare("SELECT t.name FROM book_tag_links l JOIN book_tags t ON t.id = l.tag_id WHERE l.book_id = ?").bind(book.id).all();
		const tags = results.map((r) => r.name).filter((t) => t.toLowerCase() !== HIDE_TAG.toLowerCase() && t.toLowerCase() !== "books");
		// Why there are no terms, kept for Edit details: no model set up, the model's error, or it didn't know the book.
		let why = "";
		const got = await within(() => appealTerms(env, book, blurb, tags).catch((err) => {
			console.warn("appeal", book.id, err);
			why = String(err?.message || err).slice(0, 200);
			return null;
		}), null, 40000);
		delete from.appeal_error;
		if (got?.appeal) { appeal = got.appeal; from.appeal = got.model; }
		else from.appeal_error = why || (got ? `${got.model} didn't know this book` : env.ANTHROPIC_API_KEY || env.AI ? "the model took too long" : "no AI binding or ANTHROPIC_API_KEY");
		if (got?.blurb && !blurb) { blurb = got.blurb; from.blurb = "ai"; from.blurb_model = got.model; }
	}
	const row = await env.DB.prepare("UPDATE books SET blurb = ?, pages = ?, appeal = ?, catalog = ?, record_from = ?, record_at = ? WHERE id = ? RETURNING blurb, pages, appeal, catalog, record_from, record_at")
		.bind(blurb, pages, appeal ? JSON.stringify(appeal) : null, Object.keys(catalog).length ? JSON.stringify(catalog) : null, JSON.stringify(from), Date.now(), book.id).first();
	return recordJSON(row || {});
}

// GET /api/catalog: every book's catalog details, for the book logs on the
// site (its build matches them to the notes by title and author). Only
// catalog facts: no files, tags, reading progress or family details.
async function catalogFeed(env) {
	const { results } = await env.DB.prepare(
		`SELECT id, title, author, series, volume, pages, catalog, record_from FROM books WHERE ${NOT_AUDIOBOOK} ORDER BY id`,
	).all();
	const books = results.map((b) => {
		const r = recordJSON(b);
		return {
			id: b.id, title: b.title, author: b.author || null, series: b.series || null, volume: b.volume || null,
			pages: r.pages, pages_estimated: r.from.pages === "estimate", ...r.catalog,
		};
	});
	return json({ books });
}

// GET /api/family/books/:id: a book's record, looked up the first time.
async function familyRecord(env, id) {
	const book = await familyBook(env, id);
	const record = recordDue(book) ? await fillRecord(env, book, false) : recordJSON(book);
	return json({ id, record });
}
// GET /api/books/:id/record (?refresh=1 looks it up again, keeping edits).
async function ownerRecord(env, id, url) {
	const book = await getBook(env, id);
	const refresh = url.searchParams.has("refresh");
	const record = refresh || (url.searchParams.has("fill") && recordDue(book, true)) ? await fillRecord(env, book, refresh) : recordJSON(book);
	return json({ id, record });
}

// Asking for a library card, from the landing page: anyone can, so it's
// guarded. The request waits on the Family screen (and as a card atop Unread)
// until approved, which makes their invite link, or declined. In order:
//   * a filled-in "website" field is a bot (people never see it): dropped quietly
//   * Cloudflare Turnstile, when TURNSTILE_SITE_KEY and TURNSTILE_SECRET are
//     set: the page's check token is confirmed with Cloudflare
//   * 3 requests a day from one address (kept as a salted hash, never the address)
//   * 25 waiting at once at most
const REQUESTS_PER_IP_PER_DAY = 3;
const REQUESTS_WAITING_MAX = 25;
function turnstileOn(env) { return !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET); }
async function turnstileOk(env, token, ip) {
	if (!token) return false;
	const form = new FormData();
	form.append("secret", env.TURNSTILE_SECRET);
	form.append("response", token);
	if (ip) form.append("remoteip", ip);
	try {
		const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
		return !!(await res.json()).success;
	} catch {
		return false;
	}
}
async function requestCard(request, env) {
	const data = await readJSON(request);
	if (str(data.website, 200)) return json({ ok: true });
	const name = str(data.name, 60);
	if (!name) throw new HttpError(400, "Please give your name");
	const email = str(data.email, 254);
	if (email && !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(email)) throw new HttpError(400, "That email doesn't look right. Please check it, or leave it empty.");
	const ip = request.headers.get("CF-Connecting-IP") || "";
	if (turnstileOn(env) && !(await turnstileOk(env, str(data.check, 4096), ip))) {
		throw new HttpError(403, "The check didn't go through. Please try it again.");
	}
	const now = Date.now(), ipHash = await hashSecret(ip + "|" + (env.READER_TOKEN || ""));
	const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE request_ip = ? AND created_at > ?").bind(ipHash, now - 86400000).first("n");
	if (recent >= REQUESTS_PER_IP_PER_DAY) throw new HttpError(429, "You've already sent a few requests today. Please wait for an answer.");
	const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM people WHERE requested_at IS NOT NULL").first("n");
	if (waiting >= REQUESTS_WAITING_MAX) throw new HttpError(429, "Too many requests are waiting right now. Please try again later.");
	await env.DB.prepare("INSERT INTO people (name, created_at, requested_at, request_note, request_ip, request_email) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(name, now, now, str(data.note, 300), ipHash, email).run();
	return json({ ok: true }, 201);
}

// The owner's side: the Family screen.
const PERSON_COLUMNS = `id, name, created_at, last_seen_at, invite_expires_at, requested_at, request_note, request_email, token_hash IS NOT NULL AS signed_in,
	(SELECT COUNT(*) FROM downloads d WHERE d.person_id = people.id) AS downloads`;

async function listPeople(env) {
	const { results } = await env.DB.prepare(`SELECT ${PERSON_COLUMNS} FROM people ORDER BY requested_at IS NULL, name COLLATE NOCASE, id`).all();
	for (const p of results) p.signed_in = !!p.signed_in;
	return json({ people: results });
}

async function personRow(env, id) {
	const p = await env.DB.prepare(`SELECT ${PERSON_COLUMNS} FROM people WHERE id = ?`).bind(id).first();
	if (!p) throw new HttpError(404, "No such person");
	p.signed_in = !!p.signed_in;
	return p;
}

async function addPerson(request, env) {
	const name = str((await readJSON(request)).name, 60);
	if (!name) throw new HttpError(400, "A name is needed");
	const code = randomToken(), now = Date.now();
	const row = await env.DB.prepare("INSERT INTO people (name, invite_hash, invite_expires_at, created_at) VALUES (?, ?, ?, ?) RETURNING id")
		.bind(name, await hashSecret(code), now + INVITE_DAYS * 86400000, now).first();
	return json({ person: await personRow(env, row.id), code }, 201);
}

// A fresh code, for a lost phone or a forwarded link: the old code stops
// working and so does every device they signed in on.
async function newInvite(env, id) {
	const code = randomToken();
	const { meta } = await env.DB.prepare("UPDATE people SET token_hash = NULL, invite_hash = ?, invite_expires_at = ?, requested_at = NULL WHERE id = ?")
		.bind(await hashSecret(code), Date.now() + INVITE_DAYS * 86400000, id).run();
	if (!meta.changes) throw new HttpError(404, "No such person");
	return json({ person: await personRow(env, id), code });
}

// What someone downloaded, newest first (a book since deleted takes its rows with it).
async function listDownloads(env, id) {
	await personRow(env, id);
	const { results } = await env.DB.prepare(
		`SELECT d.at, d.book_id, b.title, b.author FROM downloads d JOIN books b ON b.id = d.book_id
		WHERE d.person_id = ? ORDER BY d.at DESC LIMIT 200`,
	).bind(id).all();
	return json({ downloads: results });
}

async function removePerson(env, id) {
	const { meta } = await env.DB.prepare("DELETE FROM people WHERE id = ?").bind(id).run();
	if (!meta.changes) throw new HttpError(404, "No such person");
	return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Helpers

function matchId(path, prefix) {
	if (!path.startsWith(prefix)) return null;
	const rest = path.slice(prefix.length);
	return /^\d+$/.test(rest) ? toId(rest) : null;
}

function toId(v) {
	const n = Number(v);
	if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(400, "Bad id");
	return n;
}

function clampInt(v, lo, hi, fallback) {
	const n = parseInt(v, 10);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function str(v, max) {
	if (typeof v !== "string") return null;
	const s = v.trim().slice(0, max);
	return s || null;
}

function httpUrl(v) {
	if (typeof v !== "string" || v.length > 2000) return null;
	try {
		const u = new URL(v.trim());
		return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
	} catch {
		return null;
	}
}

async function readJSON(request) {
	if (Number(request.headers.get("Content-Length")) > MAX_JSON_BYTES) throw new HttpError(413, "Request too large");
	const text = await request.text();
	if (text.length > MAX_JSON_BYTES) throw new HttpError(413, "Request too large");
	let data;
	try {
		data = JSON.parse(text || "{}");
	} catch {
		throw new HttpError(400, "Body must be JSON");
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "Body must be a JSON object");
	return data;
}

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
}

// The page gets a fresh nonce per load for its one inline <script> and
// <style>; nothing else inline may run. pdf.js comes from cdnjs (its worker
// is started from a blob: wrapper that imports the cdnjs file); its CMaps
// and standard fonts come from jsDelivr because cdnjs doesn't carry them.
// Players an article may show inline (see embedSrc in the page script).
const EMBED_HOSTS = ["www.youtube.com", "www.youtube-nocookie.com", "player.vimeo.com", "player.twitch.tv", "clips.twitch.tv", "open.spotify.com",
	"w.soundcloud.com", "bandcamp.com", "embed.podcasts.apple.com", "embed.music.apple.com", "cdn.jwplayer.com",
	"datawrapper.dwcdn.net", "flo.uri.sh", "public.flourish.studio"];

// The app icon: a book with an R. The page carries the SVG itself (so it
// shows offline); iPhones want a PNG for the home screen.
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 768"><rect width="768" height="768" fill="#90d0df"/><path fill="#fdd983" d="M595.6 197.5C589.4 189 579.2 184 568.5 184L564 184L564 171.5C564 161.4 556.1 154.1 546.5 154.1C545.4 154.1 544.3 154.1 543.1 154.6L523.9 156.9L523.9 149.5C523.9 139.4 516 131.5 506.4 131.5C504.8 131.5 503.1 131.5 501.4 132L483.3 137.1L483.3 131.5C483.3 121.9 475.4 114 465.8 114C465.3 114 464.7 114 464.7 114C464.1 106.1 456.8 99.3 448.3 99.3C446.6 99.3 444.9 99.3 443.2 99.9L435.9 102.1L435.9 94.8C435.9 85.2 428 76.7 417.9 76.7C416.2 76.7 413.9 77.3 412.2 77.9L198.9 149.5C178.6 156.3 165.1 175.5 165.1 196.9L165.1 595.9C165.1 612.2 171.3 628 183.1 639.3L211.9 668.7C226 683.3 246.3 691.2 266.6 691.2C268.9 691.2 270.6 691.2 272.8 691.2L562.9 668.1C585.4 666.4 602.9 647.2 602.9 625.2L602.9 218.4C602.4 211 600.1 203.7 595.6 197.5ZM595.6 197.5"/><path fill="#202020" d="M179.2 196.9L179.2 595.9C179.2 608.9 184.2 620.7 193.3 629.7L222.1 659.1C235 672.1 253.1 678.8 271.7 677.7L561.7 654.6C577 653.4 588.8 640.5 588.8 625.2L588.8 218.9L269.5 242.1C254.2 243.2 239 238.7 227.1 229.7L202.3 211C193.3 204.3 187.1 194.1 186.5 182.8C186.5 180.6 186.5 178.3 187.1 176.1C182 181.1 179.2 189 179.2 196.9ZM179.2 196.9"/><path fill="#90d0df" d="M218.1 171.5C213 173.2 210.2 178.9 211.9 184C213 187.3 214.7 190.7 216.4 191.9L241.2 210.5C249.1 216.1 259.3 224 269.5 223.5L550.5 195.8L551 171.5C551 170.4 550.5 169.9 549.9 168.7C549.3 168.2 548.2 167.6 547.1 168.2L509.3 172.7L509.8 149C509.8 147.8 509.3 146.7 508.1 146.2C507 145.6 505.9 145.6 505.3 145.6L469.2 155.7L469.2 132C469.2 130.9 468.6 129.8 467.5 129.2C466.4 128.7 465.3 128.7 464.7 128.7L450.6 133.7L450.6 115.7C450.6 115.1 450 114.6 449.5 114C448.9 113.4 448.3 113.4 447.8 113.4L421.2 121.9L421.2 105.5ZM218.1 171.5"/><path fill="#202020" d="M266.6 683.3C248.6 683.3 231.1 676 218.1 663L189.3 633.7C179.2 623.5 174.1 610 174.1 595.9L174.1 196.9C174.1 179.4 185.4 163.6 202.3 158L414.5 85.8C417.3 84.6 420.7 85.2 422.9 86.9C425.2 88.6 426.9 91.4 426.9 94.8L426.9 114.6L445.5 108.3C447.8 107.8 450.6 107.8 452.3 109.5C454.5 111.2 455.7 113.4 455.7 115.7L455.7 125.8L462.4 123.6C465.3 122.5 468.1 123 470.9 124.7C473.2 126.4 474.8 129.2 474.8 132L474.8 148.4L503.6 140.5C506.4 139.4 509.3 139.9 511.5 141.6C513.8 143.3 515.5 146.2 515.5 149L514.9 166.5L544.8 162.5C547.1 162 549.9 162.5 552.2 164.2C554.4 165.9 555.5 168.7 555.5 171.5L555 192.4L568 192.4C575.9 192.4 583.8 196.4 588.3 202.6C591.7 207.1 593.3 212.7 593.3 218.4L593.3 625.2C593.3 643.3 579.2 658.5 561.2 659.6L271.1 682.8C270 683.3 268.3 683.3 266.6 683.3ZM193.3 629.7L222.1 659.1C235 672.1 253.1 678.8 271.7 677.7L561.7 654.6C577 653.4 588.8 640.5 588.8 625.2L588.8 218.4C588.8 213.9 587.1 209.9 584.9 206C580.9 200.9 575.3 198.1 569.1 198.1L549.9 198.1L550.5 171.5C550.5 170.4 549.9 169.9 549.3 168.7C548.8 168.2 547.6 167.6 546.5 168.2L509.3 172.7L509.8 149C509.8 147.8 509.3 146.7 508.1 146.2C507 145.6 505.9 145.6 505.3 145.6L469.2 155.7L469.2 132C469.2 130.9 468.6 129.8 467.5 129.2C466.4 128.7 465.3 128.7 464.7 128.7L450.6 133.7L450.6 115.7C450.6 115.1 450 114.6 449.5 114C448.9 113.4 448.3 113.4 447.8 113.4L421.2 121.9L421.2 94.8C421.2 93.7 420.7 92.5 419.5 92C418.4 91.4 417.3 90.9 416.2 91.4L203.4 163.1C188.8 168.2 179.2 181.7 179.2 196.9L179.2 595.9C179.2 608.9 184.2 620.7 193.3 629.7ZM193.3 629.7"/><path fill="#eb8462" d="M184.2 178.9C184.2 180 184.2 180.6 184.2 181.7C184.8 193 191 204.3 201.2 211.6L226 230.2C230 233.1 233.9 235.9 238.4 237.6C243.5 239.8 246.9 244.3 246.9 250L246.9 663.6C246.9 664.7 248 665.9 249.1 665.9C250.3 665.9 251.4 664.7 251.4 663.6L251.4 257.3C251.4 249.4 257.6 243.8 265.5 243.8C267.2 243.8 268.9 243.8 270 243.8L588.3 220.6L588.3 218.4C588.3 217.8 588.3 217.2 588.3 216.7L268.9 239.8C254.2 240.9 239.5 236.4 227.7 227.4L202.9 208.8C193.8 202 188.2 192.4 187.6 181.7C187.6 177.2 188.2 173.8 189.9 171C188.2 173.2 185.9 176.1 184.2 178.9ZM184.2 178.9"/><path fill="#202020" d="M232.8 184C233.3 185.1 233.9 185.7 235 185.7C235 185.7 235.6 185.7 235.6 185.7L421.2 121.3L421.2 116.8L234.5 181.1C233.3 181.7 232.8 182.8 232.8 184ZM232.8 184"/><path fill="#202020" d="M450.6 128.1L245.2 191.3C244.1 191.9 243.5 193 244.1 194.1C244.1 195.2 245.2 195.8 246.3 195.8C246.3 195.8 246.9 195.8 246.9 195.8L450.6 132.6ZM450.6 128.1"/><path fill="#202020" d="M255.9 203.1C255.9 204.3 257 204.8 258.2 204.8C258.2 204.8 258.7 204.8 258.7 204.8L469.8 154.6L469.8 150.1L257 200.9C255.9 200.9 255.3 202 255.9 203.1ZM255.9 203.1"/><path fill="#202020" d="M271.1 211C271.1 212.2 272.3 212.7 273.4 212.7C273.4 212.7 273.4 212.7 274 212.7L509.3 172.1L509.3 167.6L272.8 208.2C271.7 208.8 271.1 209.9 271.1 211ZM271.1 211"/><path fill="#202020" d="M210.2 175.5C208.5 178.3 208.5 181.7 209.6 185.1C211.3 189.6 213 193 214.7 194.1L239.5 212.7C248 218.9 257.6 225.7 267.8 225.7C268.3 225.7 268.9 225.7 269.5 225.7L549.9 198.1L549.9 193.6L268.9 221.8C259.9 222.3 250.3 215.6 242.4 209.4L217.5 190.7C217 190.2 215.3 189 213.6 183.4C213 181.1 213 179.4 214.2 177.2C215.3 175.5 217 173.8 218.7 173.2L421.8 107.8L421.8 103.3L217 169.3C214.2 170.4 211.9 172.1 210.2 175.5ZM210.2 175.5"/><path fill="#fdd983" transform="translate(306.3 561.8)" d="M227.5 15.7L227.5 23.3C158.9-2.8 125.1-39 108.4-107.3C105.9-107 103.8-107 102.8-107L98.3-107C94.1-107 90.6-107 84-108L84-27.9C84-15 87.1-9.4 97.9-4.9L97.9 0L12.9 0L12.9-4.9C23.7-9.4 26.8-15 26.8-27.9L26.8-204.5C26.8-217.4 23.7-223 12.9-227.5L12.9-232.4L39.7-232.4C45.6-232.4 56.4-232.8 70.7-233.8C87.5-234.8 106.6-235.5 118.1-235.5C182.6-235.5 217.8-212.9 217.8-171.4C217.8-153.3 209.8-136.6 194.8-125.4C188.5-120.6 177.4-115.7 161.7-110.8C181.2-46.3 205.2 1.7 227.5 15.7ZM84-201.4L84-118.8C88.5-118.5 91.6-118.1 94.1-118.1L101.4-118.1C140.8-118.1 161-136.2 161-171.1C161-201.7 137.3-225.8 108-225.8C90.9-225.8 84-219.2 84-201.4ZM84-201.4"/></svg>';
const ICON_URI = "data:image/svg+xml," + encodeURIComponent(ICON_SVG);
// "Reader" set in Romana, the icon's typeface, as outlines.
const WORDMARK_SVG = '<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 -345 1450 383" fill="currentColor"><path d="M327 22.5L327 33.5C228.5-4 180-56 156-154C152.5-153.5 149.5-153.5 148-153.5L141.5-153.5C135.5-153.5 130.5-153.5 121-155L121-40C121-21.5 125.5-13.5 141-7L141 0L18.9 0L18.9-7C34.4-13.5 38.9-21.5 38.9-40L38.9-293.6C38.9-312.1 34.4-320.1 18.9-326.6L18.9-333.6L57.5-333.6C66-333.6 81.5-334.1 102-335.6C126-337.1 153.5-338.1 170-338.1C262.5-338.1 313-305.6 313-246.1C313-220.1 301.5-196 280-180C271-173 255-166 232.5-159C260.5-66.5 295 2.5 327 22.5ZM121-289.1L121-170.5C127.5-170 132-169.5 135.5-169.5L146-169.5C202.5-169.5 231.5-195.5 231.5-245.6C231.5-289.6 197.5-324.1 155.5-324.1C131-324.1 121-314.6 121-289.1ZM121-289.1M519.1-57.5L528.1-51.5C489.6-9 464.5 5.5 427.5 5.5C367.5 5.5 327-43.5 327-115C327-184.5 371-235.1 431-235.1C465-235.1 496.6-216.6 512.6-188C522.1-170.5 525.6-154.5 525.6-126L525.6-122.5C525.6-121 525.6-119 525.1-117L400.5-117C402.5-83 409-65 424.5-52.5C436.5-42 451-37 468-37C485.6-37 497.1-42 519.1-57.5ZM398.5-134.5L443.5-134.5C463-134.5 467.5-141.5 467.5-167C467.5-200.5 455-220.6 435-220.6C409.5-220.6 398.5-193 398.5-134.5ZM398.5-134.5M764.6-22L773.1-13.5C753.6 1 743.6 5 724.1 5C696.6 5 680.6-6.5 675.6-29C659.6-17 658.1-14.5 651.6-10.5C637.1-0.5 618.6 5 601.1 5C565.1 5 540.1-16.5 540.1-47C540.1-70.5 555.6-90.5 587.1-107C608.6-119 624.6-125.5 675.6-145.5L675.6-197.5C675.6-213 668.6-221.1 654.6-221.1C642.1-221.1 635.6-215 631.1-200.5C623.6-175 611.1-162 593.6-162C577.1-162 564.1-172.5 564.1-186.5C564.1-215 605.1-235.1 663.6-235.1C719.6-235.1 748.6-215.5 748.6-179L748.6-29C748.6-21 751.1-17 756.1-17C758.6-17 761.1-18.5 764.6-22ZM675.6-43.5L675.6-129.5C649.6-118 637.1-112 627.6-102.5C618.1-93 612.1-78 612.1-62.5C612.1-41 622.6-27.5 638.6-27.5C649.1-27.5 658.1-31.5 675.6-43.5ZM675.6-43.5M938.2 0L938.2-28C914.6-4 897.6 5 873.1 5C848.6 5 823.6-8 809.6-27.5C795.6-47.5 788.6-74.5 788.6-108.5C788.6-184 827.6-235.6 883.6-235.6C905.6-235.6 917.6-231.1 938.2-214.5L938.2-281.6C938.2-296.1 935.2-301.1 925.2-303.6L925.2-314.6C962.2-324.1 968.7-325.6 1001.2-341.6L1011.7-341.6L1011.7-34C1011.7-18.5 1014.7-13 1025.2-6.5L1025.2 0ZM938.2-44.5L938.2-172.5C938.2-198.5 925.7-215.5 906.1-215.5C893.6-215.5 884.1-208.5 877.1-194C869.1-178.5 863.6-142.5 863.6-112C863.6-55.5 877.6-26 905.1-26C915.1-26 922.6-30 938.2-44.5ZM938.2-44.5M1242.7-57.5L1251.7-51.5C1213.2-9 1188.2 5.5 1151.2 5.5C1091.2 5.5 1050.7-43.5 1050.7-115C1050.7-184.5 1094.7-235.1 1154.7-235.1C1188.7-235.1 1220.2-216.6 1236.2-188C1245.7-170.5 1249.2-154.5 1249.2-126L1249.2-122.5C1249.2-121 1249.2-119 1248.7-117L1124.2-117C1126.2-83 1132.7-65 1148.2-52.5C1160.2-42 1174.7-37 1191.7-37C1209.2-37 1220.7-42 1242.7-57.5ZM1122.2-134.5L1167.2-134.5C1186.7-134.5 1191.2-141.5 1191.2-167C1191.2-200.5 1178.7-220.6 1158.7-220.6C1133.2-220.6 1122.2-193 1122.2-134.5ZM1122.2-134.5M1361.7-180.5L1361.7-34C1361.7-18.5 1364.7-12.5 1375.3-6.5L1375.3 0L1274.7 0L1274.7-6.5C1285.2-12.5 1288.2-18.5 1288.2-34L1288.2-177C1288.2-191.5 1285.2-196.5 1274.7-199L1274.7-210C1312.2-219.6 1318.2-220.6 1350.7-236.6L1361.7-236.6L1361.7-197C1379.3-224.6 1394.8-235.1 1416.3-235.1C1433.8-235.1 1446.8-223.1 1446.8-207C1446.8-191 1435.3-179 1419.3-179C1410.3-179 1409.3-179 1394.8-189.5C1391.3-192 1387.8-193 1383.8-193C1375.3-193 1368.2-189 1361.7-180.5ZM1361.7-180.5"/></svg>';
const ICON_PNG = "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";
function touchIcon() {
	return new Response(Uint8Array.from(atob(ICON_PNG), (c) => c.charCodeAt(0)), {
		headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
	});
}
// Fraunces (SIL Open Font License, src/fonts/OFL.txt): the variable font
// with its SOFT axis fixed at 100 (the rounded corners) and WONK at 0, so
// weight and optical size are all that's left to vary. Latin only; anything
// else falls back to the system serif. The files are base64 at the bottom of
// this file (made from src/fonts/), so it still deploys by pasting. Rename
// them if they ever change, since browsers keep them for a year.
const FONTS = { "/fonts/fraunces-soft.woff2": "FRAUNCES", "/fonts/fraunces-soft-italic.woff2": "FRAUNCES_ITALIC" };
function font(name) {
	const b64 = name === "FRAUNCES" ? FRAUNCES : FRAUNCES_ITALIC;
	return new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), {
		headers: { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
	});
}
function page() {
	const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
	const csp = [
		"default-src 'none'",
		`script-src 'nonce-${nonce}' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/hls.js@1.7.3/`,
		`style-src 'nonce-${nonce}'`,
		"img-src https: data: blob:",
		"font-src 'self' data: https://cdn.jsdelivr.net",
		// https: for HLS video (hls.js fetches the stream's pieces itself, from wherever the site hosts them).
		"connect-src 'self' https:",
		"media-src 'self' https: blob:",
		"frame-src " + EMBED_HOSTS.map((h) => "https://" + h).join(" "),
		"worker-src 'self' blob: https://cdnjs.cloudflare.com",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; ");
	const html = PAGE.replaceAll("__NONCE__", nonce).replaceAll("__ICON__", ICON_URI).replaceAll("__WORDMARK__", WORDMARK_SVG)
		.replaceAll("__PDFJS__", PDFJS_URL).replaceAll("__PDFJS_DATA__", PDFJS_DATA_URL);
	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": csp,
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "no-cache",
		},
	});
}

// The family page: a separate small page, so none of the app's code or data
// reaches family. It signs in from the invite link, then shows the books as
// covers (A-Z, a series in volume order) in the Sepia theme, with search and
// a format filter. Tapping a book opens its Record (#book=<id>): the jacket
// copy, page count and appeal terms, the download button, and Read online
// (#preview=<id>), the whole book to read on the page.
function familyPage(env) {
	const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
	// Turnstile (the library card form's check) runs from Cloudflare's own address, in a frame.
	const ts = turnstileOn(env) ? " https://challenges.cloudflare.com" : "";
	const csp = [
		"default-src 'none'",
		// Reading a PDF loads pdf.js from cdnjs (as the app does), its CMaps and fonts from jsDelivr.
		`script-src 'nonce-${nonce}' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com${ts}`,
		`style-src 'nonce-${nonce}'`,
		"img-src 'self' data: blob:",
		// An audiobook's player streams from /api/family/books/:id/audio/:n.
		"media-src 'self'",
		"font-src 'self' data:",
		"connect-src 'self' https://cdn.jsdelivr.net",
		"worker-src blob: https://cdnjs.cloudflare.com",
		`frame-src${ts || " 'none'"}`,
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; ");
	const siteKey = turnstileOn(env) ? env.TURNSTILE_SITE_KEY.replace(/[^\w-]/g, "") : "";
	const html = FAMILY_PAGE.replaceAll("__NONCE__", nonce).replaceAll("__ICON__", ICON_URI).replaceAll("__TURNSTILE__", siteKey)
		.replaceAll("__PDFJS__", PDFJS_URL).replaceAll("__PDFJS_DATA__", PDFJS_DATA_URL);
	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": csp,
			// The invite code is in the hash, which is never sent anywhere, but no referrer either way.
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"X-Robots-Tag": "noindex",
			"Cache-Control": "no-cache",
		},
	});
}
const FAMILY_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#f4ecd8">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Back Alley">
<link rel="icon" type="image/svg+xml" href="__ICON__">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="/fonts/fraunces-soft.woff2" as="font" type="font/woff2" crossorigin>
<title>The Back Alley Library</title>
<style nonce="__NONCE__">
	@font-face { font-family: "Fraunces"; src: url(/fonts/fraunces-soft.woff2) format("woff2"); font-weight: 300 700; font-display: swap; }
	@font-face { font-family: "Fraunces"; src: url(/fonts/fraunces-soft-italic.woff2) format("woff2"); font-weight: 300 700; font-style: italic; font-display: swap; }
	/* Always the app's Sepia theme, whatever the device is set to. */
	:root { --bg: #f4ecd8; --fg: #3b3024; --muted: #7b6c58; --line: #e2d6bb; --card: #f9f2e2; --sel: #eadfc4; --accent: #8a4b14; --on-accent: #fff;
		--display: "Fraunces", ui-serif, Georgia, serif; --sans: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif; color-scheme: light; }
	* { box-sizing: border-box; }
	html { -webkit-text-size-adjust: 100%; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 var(--sans); overflow-x: hidden; }
	main { max-width: 1000px; margin: 0 auto; padding: max(20px, env(safe-area-inset-top)) 16px max(32px, env(safe-area-inset-bottom)); }
	h1 { font: 600 30px/1.15 var(--display); margin: 4px 0 14px; letter-spacing: -.01em; }
	a { color: var(--accent); }
	button, input { font: inherit; color: inherit; }
	[hidden] { display: none !important; }
	.vh { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.muted { color: var(--muted); }
	input[type=search] { width: 100%; border: 1px solid var(--line); background: var(--card); border-radius: 10px; padding: 9px 12px; font-size: 16px; min-height: 42px; }
	.formats { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 4px; }
	.formats button { appearance: none; border: 1px solid var(--line); background: var(--card); border-radius: 999px; padding: 5px 12px; min-height: 34px; font-size: 14px; cursor: pointer; }
	.formats button[aria-pressed=true] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
	.count { font-size: 14px; margin: 8px 0 0; }
	/* Genre picks under the search: little drawn cards, Fiction then Nonfiction. */
	.recs h2 { font: 600 12px/1.2 var(--sans); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); margin: 16px 0 8px; }
	.genres { display: flex; align-items: flex-start; gap: 10px; overflow-x: auto; margin: 0 -16px; padding: 6px 16px; scroll-padding-inline: 16px; scroll-snap-type: x proximity; scrollbar-width: none; }
	.genres::-webkit-scrollbar { display: none; }
	.genre { appearance: none; flex: 0 0 112px; border: 0; background: none; padding: 0; text-align: left; cursor: pointer; scroll-snap-align: start; }
	.genre .art { display: block; position: relative; aspect-ratio: 4 / 3; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.22); }
	.genre .art::after { content: ""; position: absolute; inset: 5px; border: 1px solid rgba(255,255,255,.3); border-radius: 4px; }
	.genre svg { display: block; width: 100%; height: 100%; transition: transform .25s; }
	.genre:hover svg, .genre:focus-visible svg { transform: scale(1.06); }
	.genre .gl { display: block; font: 600 15px/1.2 var(--display); margin-top: 6px; }
	.genre .gn { display: block; font-size: 12px; color: var(--muted); }
	.genre[aria-pressed=true] .art { box-shadow: 0 0 0 3px var(--bg), 0 0 0 5px var(--accent); }
	.genre[aria-pressed=true] .gl { color: var(--accent); }
	.genre:focus-visible { outline: none; }
	.genre:focus-visible .art { box-shadow: 0 0 0 3px var(--bg), 0 0 0 5px var(--muted); }
	.covers { list-style: none; margin: 14px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 22px 14px; }
	.covers a { display: flex; flex-direction: column; gap: 3px; color: inherit; text-decoration: none; min-width: 0; }
	.cover { position: relative; aspect-ratio: 2 / 3; border-radius: 5px; overflow: hidden; background: var(--sel); box-shadow: 0 1px 4px rgba(0,0,0,.22); margin-bottom: 5px; }
	.cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
	.gencover { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; gap: 10px; padding: 16% 12%; text-align: center;
		color: #fbf7ee; font-family: var(--display); outline: 1px solid rgba(255,255,255,.35); outline-offset: -7px;
		background-image: linear-gradient(90deg, rgba(0,0,0,.28), rgba(0,0,0,0) 7%, rgba(255,255,255,.06) 9%, rgba(0,0,0,0) 12%); }
	.gencover .gt { font-weight: 600; font-size: 15px; line-height: 1.2; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
	.gencover .ga { font-size: 12px; font-style: italic; opacity: .85; overflow-wrap: anywhere; }
	.ct { font: 600 15px/1.25 var(--display); overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
	.ca { font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.dl { font-size: 13px; color: var(--accent); font-weight: 600; }
	.fmt { display: flex; gap: 8px; margin-top: 2px; }
	.fmt svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
	.empty { color: var(--muted); padding: 24px 0; text-align: center; }
	.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 10px 0 4px; }
	.filters .formats { margin: 0; }
	select { border: 1px solid var(--line); background: var(--card); border-radius: 999px; min-height: 34px; padding: 4px 10px; font-size: 14px; max-width: 100%; }
	.up { display: inline-block; margin: 6px 0 0; font-size: 15px; text-decoration: none; }
	/* A series: one cover with the rest of the volumes stacked behind it. */
	.series .cover { overflow: visible; isolation: isolate; }
	.series .cover::before, .series .cover::after { content: ""; position: absolute; inset: 0; border-radius: 5px; background: var(--line);
		box-shadow: 0 1px 3px rgba(0,0,0,.18); transform: translate(4px, -4px); z-index: -1; }
	.series .cover::after { transform: translate(8px, -8px); opacity: .7; z-index: -2; }
	.series .cover > * { border-radius: 5px; overflow: hidden; }
	.welcome { max-width: 520px; margin: 0 auto; }
	.welcome p { margin: 0 0 14px; }
	.welcome h2 { font: 600 20px/1.25 var(--display); margin: 22px 0 8px; }
	.addr { font: 600 17px/1.3 var(--sans); background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; overflow-wrap: anywhere; user-select: all; -webkit-user-select: all; }
	.how { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin: 10px 0; }
	details { margin: 6px 0 14px; color: var(--muted); font-size: 15px; }
	details p { margin: 8px 0 0; }
	summary { cursor: pointer; color: var(--accent); }
	.go { appearance: none; width: 100%; border: 0; border-radius: 10px; background: var(--accent); color: var(--on-accent); font-weight: 600; font-size: 17px; min-height: 48px; margin-top: 10px; cursor: pointer; }
	.sub { margin: -8px 0 14px; font-size: 14px; }
	.intro { margin: 0 0 20px; font: 400 17px/1.55 var(--display); }
	.intro p { margin: 0 0 10px; }
	/* The landing page: the library's sepia, all type. Brown text, red
	   buttons, and printer's flourishes above and below the title. */
	body.landing main { min-height: 100vh; display: flex; flex-direction: column; justify-content: center; }
	.sepia { max-width: 520px; width: 100%; margin: 32px auto; text-align: center; color: var(--fg); }
	.sepia .orn { display: flex; align-items: center; gap: 14px; color: #8b2e1f; font: 400 22px/1 var(--display); }
	.sepia .orn::before, .sepia .orn::after { content: ""; flex: 1; height: 0; border-top: 1px solid #b89a72; border-bottom: 1px solid #b89a72; padding-top: 2px; }
	.sepia h1 { margin: 18px 0 16px; font: 600 48px/1 var(--display); letter-spacing: -.02em; color: #4a3220; }
	.sepia h1 small { display: block; font: italic 400 22px/1 var(--display); letter-spacing: 0; color: var(--muted); margin-bottom: 8px; }
	.sepia h1 em { font-style: italic; font-weight: 500; }
	.sepia .orn + p { margin-top: 22px; }
	.sepia p { margin: 0 0 18px; font: 400 19px/1.6 var(--display); color: #4a3220; }
	.stamp { appearance: none; display: block; width: 100%; margin-top: 8px; padding: 15px 18px; cursor: pointer;
		border: 0; border-radius: 10px; background: #8b2e1f; color: #fbf3e2; box-shadow: 0 2px 0 #5e1d12;
		font: 600 17px/1.2 var(--display); letter-spacing: .02em; transition: background .15s, transform .1s, box-shadow .1s; }
	.stamp:hover, .stamp:focus-visible { background: #a1381f; outline: none; }
	.stamp:active { transform: translateY(2px); box-shadow: 0 0 0 #5e1d12; }
	.stamp:disabled { opacity: .55; }
	.sepia form { text-align: left; }
	.sepia label { display: block; font: 600 13px/1.3 var(--sans); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 18px 0 4px; }
	.sepia label .muted { text-transform: none; letter-spacing: 0; font-weight: 400; }
	.sepia .hint { margin-top: 5px; font: italic 400 14px/1.4 var(--display); color: var(--muted); }
	.sepia input[type=text], .sepia input[type=email], .sepia textarea { width: 100%; border: 1px solid var(--line); background: var(--card); color: var(--fg); padding: 10px 12px;
		font: 400 18px/1.4 var(--display); border-radius: 10px; }
	.sepia textarea { resize: vertical; min-height: 70px; }
	.sepia input:focus, .sepia textarea:focus { outline: none; border-color: #8b2e1f; }
	.sepia .msg { font: 400 17px/1.5 var(--display); color: #4a3220; }
	.sepia .msg.bad { color: #8b2e1f; }
	.check { margin: 16px 0 4px; min-height: 0; }
	.check:empty { margin: 0; }
	.hp { position: absolute !important; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
	footer { margin-top: 36px; padding-top: 14px; border-top: 1px solid var(--line); font-size: 14px; text-align: center; }
	/* A book's Record: a catalog record, with the download button on it. */
	.record { max-width: 820px; }
	.rtop { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 28px; align-items: start; margin-top: 14px; }
	.rcover { margin: 0; }
	.rcover .gencover .gt { font-size: 21px; }
	.rcover .gencover .ga { font-size: 15px; }
	.eyebrow { font: 600 12px/1.2 var(--sans); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); margin: 2px 0 8px; }
	.record h1 { font-size: 34px; margin: 0 0 6px; overflow-wrap: anywhere; }
	.record h1:focus { outline: none; }
	.rby { font: italic 400 19px/1.35 var(--display); margin: 0 0 4px; }
	.rseries { margin: 0; font-size: 15px; }
	.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; margin: 18px 0 20px; font-size: 15px; }
	.facts dt { color: var(--muted); font: 600 11px/1.2 var(--sans); letter-spacing: .14em; text-transform: uppercase; padding-top: 4px; }
	.facts dd { margin: 0; }
	.rdl { display: flex; align-items: center; justify-content: center; gap: 8px; max-width: 340px; text-decoration: none; margin-top: 0; }
	.rdl.off { background: var(--line); color: var(--muted); }
	.rleft { font-size: 14px; margin: 8px 0 0; }
	/* The audiobook's buttons, under the ebook's when the library has both. */
	.raudio { margin-top: 16px; }
	.rsec { border-top: 1px solid var(--line); margin-top: 30px; padding-top: 18px; }
	.rsec h2 { font: 600 12px/1.2 var(--sans); letter-spacing: .16em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; }
	.blurb p { font: 400 18px/1.6 var(--display); margin: 0 0 14px; max-width: 62ch; }
	.blurb .muted { font: 400 16px/1.5 var(--sans); }
	.note { font-size: 13px; color: var(--muted); margin: 4px 0 0; }
	.appeal { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 12px 16px; margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
	.appeal dt { font: 600 16px/1.3 var(--display); padding-top: 4px; }
	.appeal dd { margin: 0; display: flex; flex-wrap: wrap; gap: 6px; }
	.term { border: 1px solid var(--t-line, var(--line)); background: var(--t-bg, var(--bg)); color: var(--t-fg, inherit); border-radius: 999px; padding: 3px 12px; font-size: 14px; line-height: 1.5; }
	/* Each appeal factor has its own color: its label and its terms. */
	.appeal .f-pacing { --t-fg: #8a3a12; --t-bg: #f6dcc8; --t-line: #e8b896; }
	.appeal .f-tone { --t-fg: #6b2f5b; --t-bg: #efd9e6; --t-line: #d9b3cb; }
	.appeal .f-style { --t-fg: #1f5d5a; --t-bg: #d6ebe6; --t-line: #a9d1c9; }
	.appeal .f-characters { --t-fg: #4f5b16; --t-bg: #e3e8c6; --t-line: #c3cd92; }
	.appeal .f-story { --t-fg: #2f4a7a; --t-bg: #dbe3f1; --t-line: #b3c3e0; }
	.appeal dt[class^="f-"] { color: var(--t-fg); }
	.rbtns { display: flex; flex-wrap: wrap; gap: 10px; max-width: 520px; }
	.rbtns .rdl { flex: 1 1 200px; }
	.rpv { display: flex; align-items: center; justify-content: center; flex: 0 1 150px; min-height: 48px; margin-top: 0; border: 1px solid var(--accent); border-radius: 10px;
		color: var(--accent); font-weight: 600; font-size: 17px; text-decoration: none; background: transparent; }
	.rpv:hover, .rpv:focus-visible { background: var(--card); }
	/* Reading online: the book, laid out like a page of a book. */
	.preview { max-width: 720px; margin: 0 auto; }
	.pveye { margin-top: 14px; }
	.preview h1 { font-size: 30px; margin: 0 0 4px; overflow-wrap: anywhere; }
	.preview h1:focus { outline: none; }
	.pvby { font: italic 400 18px/1.35 var(--display); margin: 0 0 6px; }
	.pvnote { font-size: 14px; margin: 0 0 22px; }
	.pvnote:empty { margin-bottom: 18px; }
	.pvtext { font: 400 19px/1.65 var(--display); background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 34px clamp(18px, 6vw, 56px) 30px;
		box-shadow: 0 1px 3px rgba(0,0,0,.06); overflow-wrap: break-word; }
	.pvtext p { margin: 0; text-indent: 1.4em; white-space: pre-line; }
	.pvtext h2 + p, .pvtext hr + p, .pvtext p:first-child, .pvtext blockquote + p { text-indent: 0; }
	.pvtext h2 { font: 600 23px/1.3 var(--display); text-align: center; margin: 10px 0 18px; }
	.pvtext h2 + h2 { margin-top: -10px; font-size: 18px; font-weight: 400; font-style: italic; }
	.pvtext blockquote { margin: 12px 1.4em; font-size: 17px; white-space: pre-line; }
	.pvtext hr { border: 0; margin: 34px 0; text-align: center; height: 1em; }
	.pvtext hr::before { content: "\2042"; color: var(--muted); font-size: 18px; }
	.pvpages { display: flex; flex-direction: column; align-items: center; gap: 14px; }
	.pvpages img, .pvpages .pvpdf { display: block; width: 100%; max-width: 720px; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.22); border-radius: 2px; }
	/* A page not loaded yet holds a comic page's usual shape, so the place can be found before the pages above it load. */
	.pvpages img { height: auto; aspect-ratio: auto 2 / 3; max-width: 600px; }
	.linkbtn { appearance: none; border: 0; background: none; padding: 0; color: var(--accent); font: inherit; text-decoration: underline; cursor: pointer; }
	.pvmore { text-align: center; font-size: 14px; margin: 22px 0; min-height: 1em; }
	.pvpdf { position: relative; }
	.pvpdf canvas { display: block; width: 100%; height: 100%; }
	.pvpdf .pn { position: absolute; right: 8px; bottom: 6px; font-size: 12px; color: #999; }
	/* Listening to an audiobook, laid out like the app's player page: a square cover, the chapter playing and a slider across it, the controls, then every chapter. */
	.lplay { display: grid; grid-template-columns: minmax(0, 260px) minmax(0, 1fr); gap: 32px; align-items: center; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 22px; font-family: var(--sans); }
	.lpcov .cover { aspect-ratio: 1; margin: 0; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.18); }
	.lpmain { min-width: 0; }
	.lpchap { appearance: none; display: inline-block; max-width: 100%; margin: 0; padding: 4px 0; border: 0; background: none; font: inherit; font-weight: 600; color: var(--accent); text-align: inherit; overflow-wrap: anywhere; cursor: pointer; }
	.lpchap::after { content: " \25BE"; font-size: .8em; }
	.lpmain [hidden] { display: none; }
	/* The slider: a round dot on a filled track (the browser's own is a pill in Safari and can't take the theme). */
	.pseek { display: block; width: 100%; height: 28px; margin: 8px 0 0; background: transparent; cursor: pointer; -webkit-appearance: none; appearance: none; --p: 0%; }
	.pseek::-webkit-slider-runnable-track { height: 6px; border-radius: 3px; background: linear-gradient(to right, var(--accent) var(--p), var(--line) var(--p)); }
	.pseek::-moz-range-track { height: 6px; border-radius: 3px; background: var(--line); }
	.pseek::-moz-range-progress { height: 6px; border-radius: 3px; background: var(--accent); }
	.pseek::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; margin-top: -6px; border-radius: 50%; background: var(--accent); border: 3px solid var(--card); box-shadow: 0 0 0 1px var(--accent); }
	.pseek::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 3px solid var(--card); box-shadow: 0 0 0 1px var(--accent); }
	.pseek:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
	.lptimes { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
	.lpctl { display: flex; align-items: center; justify-content: space-between; gap: 4px; max-width: 360px; margin: 14px 0 0; }
	.lpctl button { appearance: none; min-width: 48px; min-height: 48px; padding: 0 6px; border: 0; border-radius: 10px; background: none; color: var(--accent); font: inherit; font-size: 17px; font-variant-numeric: tabular-nums; cursor: pointer; }
	.lpctl button:disabled { opacity: .35; cursor: default; }
	.lpctl svg { width: 22px; height: 22px; fill: currentColor; display: block; margin: auto; }
	.lpctl .pplay { flex: none; width: 68px; height: 68px; min-width: 0; padding: 0; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: grid; place-items: center; }
	.lpctl .pplay svg { width: 26px; height: 26px; }
	.lpctl button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
	.lpmore { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 14px; font-size: 14px; color: var(--muted); }
	.lpmore button, .lpsleep button { appearance: none; border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 999px; padding: 5px 13px; min-height: 36px; font: inherit; font-size: 14px; font-variant-numeric: tabular-nums; cursor: pointer; }
	.lpmore .sleepbtn.on, .lpmore .voicebtn.on { border-color: var(--accent); color: var(--accent); }
	.lpsleep { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
	.pfile { font-size: 13px; margin: 10px 0 0; }
	.lpchaps h2 { font: 600 13px/1.3 var(--sans); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 26px 0 0; }
	.chapters { list-style: none; margin: 10px 0 0; padding: 0; max-height: 420px; overflow-y: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--card); font-family: var(--sans); }
	.chapters li + li { border-top: 1px solid var(--line); }
	.chapters button { appearance: none; display: flex; width: 100%; justify-content: space-between; gap: 12px; border: 0; background: transparent; color: inherit; padding: 10px 14px; text-align: left; font: inherit; font-size: 15px; cursor: pointer; }
	.chapters button[aria-current=true] { background: var(--sel); color: var(--accent); font-weight: 600; }
	.chapters .chtime { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
	/* The chapter picker over the page. */
	.chapdlg { width: min(480px, calc(100vw - 32px)); max-height: min(560px, calc(100vh - 80px)); padding: 14px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); color: var(--fg); box-shadow: 0 10px 30px rgba(0,0,0,.25); }
	.chapdlg[open] { display: flex; flex-direction: column; }
	.chapdlg::backdrop { background: rgba(0,0,0,.4); }
	.chapdlghd { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	.chapdlghd h2 { font: 600 13px/1.3 var(--sans); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0; }
	.chapdlghd .x { appearance: none; min-width: 40px; min-height: 40px; border: 0; background: none; color: var(--accent); font-size: 24px; cursor: pointer; }
	.chapdlg .chapters { flex: 1 1 auto; min-height: 0; max-height: none; background: var(--bg); }
	/* The player bar: the book playing, pinned to the bottom while the library is browsed. */
	.lbar { position: fixed; left: 0; right: 0; bottom: var(--lost, 0px); z-index: 15; background: var(--card); border-top: 1px solid var(--line);
		padding: 8px 12px calc(8px + env(safe-area-inset-bottom)); box-shadow: 0 -4px 18px rgba(0,0,0,.08); font-family: var(--sans); }
	.lbar[hidden] { display: none; }
	.lbprog { position: absolute; left: 0; right: 0; top: -1px; height: 3px; }
	.lbprog span { display: block; height: 100%; width: 0; background: var(--accent); }
	.lbrow { display: flex; align-items: center; gap: 4px; max-width: 760px; margin: 0 auto; }
	.lbtitle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; color: inherit; text-decoration: none; }
	.lbcov { flex: none; width: 44px; }
	.lbcov .cover { aspect-ratio: 1; margin: 0; border-radius: 4px; }
	.lbcov .gencover > * { display: none; }
	.lbtext { min-width: 0; display: flex; flex-direction: column; }
	#lbName { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	#lbTime { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.lbar button { appearance: none; flex: none; min-width: 44px; min-height: 44px; padding: 0 4px; border: 0; background: none; color: var(--accent); font: inherit; font-size: 15px; font-variant-numeric: tabular-nums; cursor: pointer; }
	.lbar .pplay { width: 46px; height: 46px; min-width: 0; padding: 0; border-radius: 50%; background: var(--accent); color: var(--on-accent); display: grid; place-items: center; }
	.lbar .pplay svg { width: 20px; height: 20px; fill: currentColor; }
	.lbar button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	body.has-lbar { padding-bottom: calc(72px + env(safe-area-inset-bottom) + var(--lost, 0px)); }
	#lbClose { min-width: 36px; font-size: 20px; }
	@media (max-width: 380px) { #lbBack, #lbFwd { display: none; } }
	@media (max-width: 600px) {
		.lplay { grid-template-columns: minmax(0, 1fr); gap: 18px; padding: 18px 14px; }
		.lpcov { width: 78%; max-width: 320px; margin: 0 auto; }
		.lpmain { text-align: center; }
		.lpctl { margin-inline: auto; }
		.lpmore, .lpsleep { justify-content: center; }
	}
	.pvend { text-align: center; border-top: 1px solid var(--line); margin-top: 30px; padding-top: 22px; }
	.pvend p { margin: 0 0 6px; font: 400 18px/1.5 var(--display); }
	.pvend .rbtns { margin: 6px auto 0; justify-content: center; }
	.pvend .rdl { margin-top: 0; }
	.pvend .rleft { font: 14px/1.45 var(--sans); margin: 0 0 10px; }
	@media (max-width: 600px) {
		.rtop { grid-template-columns: 1fr; gap: 18px; }
		.rcover { width: 56%; max-width: 230px; justify-self: center; }
		.record h1 { font-size: 29px; }
		.rdl { max-width: none; }
		.rbtns { max-width: none; }
		.rpv { flex-basis: 100%; }
		.pvtext { font-size: 18px; }
		.appeal { grid-template-columns: 1fr; gap: 4px; }
		.appeal dd { margin-bottom: 10px; }
		.appeal dd:last-child { margin-bottom: 0; }
	}
</style>
</head>
<body>
<main>
	<section id="landing" class="sepia" hidden>
		<div class="orn" aria-hidden="true">&#10086;</div>
		<h1><small>Welcome to</small>The <em>Back Alley</em> Library</h1>
		<div class="orn" aria-hidden="true">&#10087;</div>
		<p>The Back Alley Library is a secret between family and friends. Inside you will find my entire collection of books, comics, and audiobooks. Click the button below to request your library card.</p>
		<p id="lMsg" class="msg" hidden></p>
		<button id="lAsk" class="stamp" type="button">Request your library card</button>
		<form id="lForm" hidden>
			<label for="lName">Your name</label>
			<input id="lName" type="text" maxlength="60" autocomplete="name" autocapitalize="words" required>
			<label for="lEmail">Your email <span class="muted">(optional)</span></label>
			<input id="lEmail" type="email" maxlength="254" autocomplete="email" autocapitalize="off" spellcheck="false">
			<div class="hint">I'll send your library card here.</div>
			<label for="lNote">How do I know you? <span class="muted">(optional)</span></label>
			<textarea id="lNote" maxlength="300"></textarea>
			<div class="hp" aria-hidden="true"><label for="lSite">Website</label><input id="lSite" type="text" tabindex="-1" autocomplete="off"></div>
			<div id="lCheck" class="check"></div>
			<button id="lSend" class="stamp" type="submit">Send my request</button>
		</form>
	</section>
	<h1 id="head" hidden>The Back Alley Library</h1>
	<p id="sub" class="sub muted" hidden></p>
	<div id="intro" class="intro" hidden>
		<p>Welcome to the Back Alley Library. All of the books in the collection are DRM free and work anywhere. Consolidating the history of my digital purchases is a big job and I add more to the collection when I have time.</p>
		<p>I put a download limit of 10 books per person per day so you guys don't hog my internet. Happy Reading!</p>
	</div>
	<p id="note" class="muted">Loading…</p>
	<section id="welcome" class="welcome" hidden>
		<p id="wIntro">Browse, then download any book to read in Apple Books or your favorite app. They're yours to keep.</p>
		<h2>Save this page so you can come back for new books</h2>
		<p>The address to keep:</p>
		<div id="wAddr" class="addr"></div>
		<div id="wHow" class="how"></div>
		<details><summary>Other devices</summary><div id="wOther"></div></details>
		<p id="wOwner" class="muted"></p>
		<button id="wGo" class="go" type="button">Go to the library</button>
	</section>
	<div id="lib" hidden>
		<div id="browse">
		<div id="tools">
			<label class="vh" for="q">Search</label>
			<input id="q" type="search" placeholder="Search title, author, series" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
			<div id="recs" class="recs" hidden>
				<h2 id="hFic">Fiction</h2>
				<div id="fiction" class="genres" role="group" aria-labelledby="hFic"></div>
				<h2 id="hNon">Nonfiction</h2>
				<div id="nonfiction" class="genres" role="group" aria-labelledby="hNon"></div>
			</div>
			<div class="filters">
				<div id="formats" class="formats" role="group" aria-label="Format"></div>
				<label class="vh" for="tag">Tag</label>
				<select id="tag"></select>
			</div>
		</div>
		<a id="up" class="up" href="/library" hidden>‹ All books</a>
		<p id="count" class="count muted"></p>
		<ul id="books" class="covers"></ul>
		<p id="none" class="empty" hidden>Nothing matches.</p>
		</div>
		<article id="record" class="record" hidden>
			<a id="rBack" class="up" href="/library">‹ Back</a>
			<div class="rtop">
				<div id="rCover" class="cover rcover"></div>
				<div>
					<p class="eyebrow">Record</p>
					<h1 id="rTitle" tabindex="-1"></h1>
					<p id="rBy" class="rby"></p>
					<p id="rSeries" class="rseries"></p>
					<dl id="rFacts" class="facts"></dl>
					<div class="rbtns">
						<a id="rDl" class="go rdl" href="#"></a>
						<a id="rPv" class="rpv" href="#">Read online</a>
					</div>
					<p id="rLeft" class="rleft muted"></p>
					<div id="rAudio" class="raudio" hidden>
						<div class="rbtns">
							<a id="rAdl" class="go rdl" href="#"></a>
							<a id="rListen" class="rpv" href="#">Listen</a>
						</div>
						<p id="rALeft" class="rleft muted"></p>
					</div>
				</div>
			</div>
			<section id="rBlurbSec" class="rsec">
				<h2>From the jacket</h2>
				<div id="rBlurb" class="blurb"></div>
				<p id="rBlurbNote" class="note" hidden></p>
			</section>
			<section id="rAppealSec" class="rsec" hidden>
				<h2>Appeal factors</h2>
				<dl id="rAppeal" class="appeal"></dl>
			</section>
		</article>
		<article id="preview" class="preview" hidden>
			<a id="pvBack" class="up" href="/library">‹ Back</a>
			<p id="pvEye" class="eyebrow pveye">Read online</p>
			<h1 id="pvTitle" tabindex="-1"></h1>
			<p id="pvBy" class="pvby"></p>
			<p id="pvNote" class="pvnote muted"></p>
			<div id="pvBody"></div>
			<div id="pvEnd" class="pvend" hidden>
				<p id="pvEndText"></p>
				<p id="pvLeft" class="rleft muted"></p>
				<div class="rbtns"><a id="pvDl" class="go rdl" href="#"></a></div>
			</div>
		</article>
		<footer><a id="howLink" href="#">How to save this page</a></footer>
	</div>
</main>
<div id="lbAudio" hidden></div>
<div id="lbar" class="lbar" hidden>
	<div class="lbprog"><span id="lbProg"></span></div>
	<div class="lbrow">
		<a id="lbTitle" class="lbtitle" href="#"><span id="lbCov" class="lbcov"></span><span class="lbtext"><span id="lbName"></span><span id="lbTime"></span></span></a>
		<button id="lbBack" type="button" aria-label="Back 15 seconds">&#8634;15</button>
		<button id="lbPlay" class="pplay" type="button" aria-label="Play"></button>
		<button id="lbFwd" type="button" aria-label="Forward 30 seconds">30&#8635;</button>
		<button id="lbClose" type="button" aria-label="Stop and close the player">&times;</button>
	</div>
</div>
<script nonce="__NONCE__">
var $ = function (id) { return document.getElementById(id); };
function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function say(msg) { $("note").textContent = msg; $("note").hidden = !msg; }
var FORMATS = { epub: "EPUB", pdf: "PDF", cbz: "Comics", txt: "Text", audiobook: "Audiobooks" };
var KIND = { epub: "EPUB", pdf: "PDF", cbz: "Comic", txt: "Text", audiobook: "Audiobook" };
var COLORS = ["#7a3b2e", "#2f4f6f", "#3d5a3a", "#5b3f6e", "#8a6a1f", "#1f5e5e", "#6b2f45", "#4a4f63", "#7b4a1c", "#35524a"];
var books = [], format = "", query = "", tag = "", me = {};
// Showing one series' volumes: the address carries it (#series=Name) so Back returns to all books.
function openSeries() { var m = /^#series=(.+)$/.exec(location.hash); return m ? decodeURIComponent(m[1]) : null; }
// A book's Record: #book=<id>.
function openBook() { var m = /^#book=(\d+)$/.exec(location.hash); return m ? Number(m[1]) : null; }
// Its preview: #preview=<id>.
function openPreview() { var m = /^#preview=(\d+)$/.exec(location.hash); return m ? Number(m[1]) : null; }
var listScroll = 0, viaList = false, viaRecord = false, onRecord = false, onPreview = false, records = {}, common = {};
function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

// 33,120 seconds -> "9 h 12 min"
function hours(sec) {
	var m = Math.round((sec || 0) / 60);
	return m < 60 ? Math.max(1, m) + " min" : Math.floor(m / 60) + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
}
// 3725 -> "1:02:05"
function clock(sec) {
	sec = Math.max(0, Math.floor(sec || 0));
	var hh = Math.floor(sec / 3600), mm = Math.floor(sec / 60) % 60, ss = sec % 60;
	return (hh ? hh + ":" + (mm < 10 ? "0" : "") : "") + mm + ":" + (ss < 10 ? "0" : "") + ss;
}
function bytes(n) { return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB"; }
function fold(s) { return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase(); }

async function signIn(code) {
	var res = await fetch("/api/family/redeem", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code }) });
	// The link works once, so the address to keep is the plain one.
	history.replaceState(null, "", "/library");
	if (!res.ok) {
		var d = await res.json().catch(function () { return {}; });
		if (res.status === 410) return "That link has already been used or has run out. If it was meant for you, request a new card below.";
		throw new Error(d.error || "Couldn't sign in.");
	}
	return "";
}

function drawnCover(b) {
	var n = 0, key = (b.title || "") + (b.author || "");
	for (var i = 0; i < key.length; i++) n = (n * 31 + key.charCodeAt(i)) >>> 0;
	var g = h("div", "gencover");
	g.style.backgroundColor = COLORS[n % COLORS.length];
	g.setAttribute("aria-hidden", "true");
	g.append(h("span", "gt", b.title));
	if (b.author) g.append(h("span", "ga", b.author));
	return g;
}
// The drawn cover sits underneath; a real one covers it once it loads.
function fillCover(cov, b) {
	cov.textContent = "";
	cov.append(drawnCover(b));
	// An ebook with no cover of its own borrows its audiobook's (which is square, so it's second choice).
	if (b.audio && b.audio.cover !== "none" && (b.cover === "none" || (b.cover == null && b.type !== "epub" && b.type !== "cbz"))) b = b.audio;
	if (b.cover === "yes" || (b.cover !== "none" && (b.type === "epub" || b.type === "cbz" || b.type === "audiobook"))) {
		var img = h("img");
		img.alt = "";
		img.loading = "lazy";
		img.decoding = "async";
		img.addEventListener("error", function () { img.remove(); });
		img.src = "/api/family/books/" + b.id + "/cover";
		cov.append(img);
	}
	return cov;
}
// A card shows its formats as icons (the Record spells them out): an open
// book for anything to read, headphones for an audiobook.
var READ_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 4.5h6a4 4 0 0 1 4 4V20a3 3 0 0 0-3-3H2zM22 4.5h-6a4 4 0 0 0-4 4V20a3 3 0 0 1 3-3h7z"/></svg>';
var LISTEN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>';
// Tapping a book opens its Record; Back returns to the same place in the list.
function card(b) {
	var li = h("li"), a = h("a"), cov = fillCover(h("div", "cover"), b);
	a.href = "#book=" + b.id;
	a.addEventListener("click", function () { listScroll = window.scrollY; viaList = true; });
	a.setAttribute("aria-label", b.title + (b.author ? " by " + b.author : "") + ", " + KIND[b.type] + (b.audio ? " and audiobook" : ""));
	var by = [b.author, b.series ? b.series + (b.volume ? " " + b.volume : "") : null].filter(Boolean).join(" · ");
	a.append(cov, h("span", "ct", b.title));
	if (by) a.append(h("span", "ca", by));
	var fm = h("span", "dl fmt");
	fm.innerHTML = (b.type === "audiobook" ? "" : READ_ICON) + (b.type === "audiobook" || b.audio ? LISTEN_ICON : "");
	a.append(fm);
	li.append(a);
	return li;
}

// A book the library has as an ebook and an audiobook is one Record with
// both: the audiobook joins the ebook with the same title (before any
// subtitle) and an author sharing a word, as b.audio (and it gets .parent).
// An audiobook with no ebook stays a book of its own.
function titleKey(b) { return fold(b.title).split(/[:(\[]/)[0].replace(/[^a-z0-9]+/g, " ").trim(); }
function authorWords(b) { return fold(b.author).replace(/[^a-z]+/g, " ").trim().split(" ").filter(function (w) { return w.length > 1; }); }
function pairAudio(list) {
	var ebooks = {};
	list.forEach(function (b) {
		var k = titleKey(b);
		if (b.type !== "audiobook" && k) (ebooks[k] = ebooks[k] || []).push(b);
	});
	return list.filter(function (b) {
		if (b.type !== "audiobook") return true;
		var words = authorWords(b), e = (ebooks[titleKey(b)] || []).filter(function (x) {
			var theirs = authorWords(x);
			return !x.audio && (!words.length && !theirs.length || words.some(function (w) { return theirs.indexOf(w) >= 0; }));
		})[0];
		if (!e) return true;
		e.audio = b;
		b.parent = e;
		// Audiobookshelf's title, author and series are shown for both.
		e.fileTitle = e.title;
		e.title = b.title;
		if (b.author) e.author = b.author;
		if (b.series) { e.series = b.series; e.volume = b.volume; }
		return false;
	});
}
function findBook(id) {
	for (var i = 0; i < books.length; i++) {
		if (books[i].id === id) return books[i];
		if (books[i].audio && books[i].audio.id === id) return books[i].audio;
	}
	return null;
}
function renderFormats() {
	var box = $("formats"), have = {};
	books.forEach(function (b) {
		have[b.type] = (have[b.type] || 0) + 1;
		if (b.audio) have.audiobook = (have.audiobook || 0) + 1;
	});
	var kinds = Object.keys(FORMATS).filter(function (k) { return have[k]; });
	box.textContent = "";
	box.hidden = kinds.length < 2;
	[""].concat(kinds).forEach(function (k) {
		var btn = h("button", null, k ? FORMATS[k] : "All");
		btn.type = "button";
		btn.setAttribute("aria-pressed", String(k === format));
		btn.addEventListener("click", function () {
			format = k;
			if (k && pick) { pick = null; renderRecs(); }
			renderFormats();
			render();
		});
		box.append(btn);
	});
}
// A series is one series however its name was typed, as in the app's
// Library: names that fold the same group together. Every volume shows the
// spelling with the most capitals (a name typed lazily loses them; one in all
// capitals counts least), and on a tie the one most volumes use.
function sameSeries(list) {
	var names = {};
	list.forEach(function (b) {
		if (!b.series) return;
		var k = fold(b.series), n = names[k] = names[k] || {};
		n[b.series] = (n[b.series] || 0) + 1;
	});
	var caps = function (s) { return s === s.toUpperCase() ? -1 : s.replace(/[^A-Z]/g, "").length; };
	Object.keys(names).forEach(function (k) {
		names[k] = Object.keys(names[k]).sort(function (a, b) { return caps(b) - caps(a) || names[k][b] - names[k][a]; })[0];
	});
	list.forEach(function (b) { if (b.series) b.series = names[fold(b.series)]; });
}
function seriesCard(name, vols) {
	var li = h("li", "series"), a = h("a"), first = card(vols[0]).querySelector(".cover");
	a.href = "#series=" + encodeURIComponent(name);
	a.setAttribute("aria-label", name + ", series of " + vols.length);
	a.append(first, h("span", "ct", name), h("span", "ca", vols.length + " books"));
	li.append(a);
	return li;
}
// Genre picks. Each fiction pick covers the tag names that mean it (Mystery
// or Mysteries, Urban Fantasy counts as Fantasy). Nonfiction picks are the
// other tags that turn up on books also tagged Nonfiction: History,
// Biography & Memoir and so on. Only picks with books show.
var INK = "#fbf7ee", GOLD = "#f2c66d", EMBER = "#ef9a52";
var ART = {
	classics: ["#6b2f45", '<path d="M18 23 40 11l22 12z" fill="' + INK + '"/><rect x="17" y="24" width="46" height="3" fill="' + INK + '"/>'
		+ '<g fill="' + INK + '" opacity=".9"><rect x="21" y="29" width="5" height="15"/><rect x="30" y="29" width="5" height="15"/><rect x="45" y="29" width="5" height="15"/><rect x="54" y="29" width="5" height="15"/></g>'
		+ '<rect x="15" y="45" width="50" height="3" fill="' + INK + '"/><rect x="12" y="49" width="56" height="3" fill="' + INK + '" opacity=".7"/><circle cx="40" cy="19" r="2.2" fill="' + GOLD + '"/>'],
	westerns: ["#8a6a1f", '<circle cx="58" cy="17" r="8" fill="' + GOLD + '"/><path d="M0 45h9l4-11h17l4 11h46v15H0z" fill="#000" opacity=".22"/>'
		+ '<g fill="none" stroke="' + INK + '" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M44 52V23"/><path d="M44 39h-7v-8"/><path d="M44 34h7v-7"/></g>'
		+ '<path d="M0 52h80" stroke="' + INK + '" stroke-width="1.5" opacity=".6"/>'],
	mysteries: ["#2f4f6f", '<g fill="' + INK + '" opacity=".55"><ellipse cx="11" cy="51" rx="2.4" ry="3.8" transform="rotate(-25 11 51)"/><ellipse cx="17" cy="45" rx="2.4" ry="3.8" transform="rotate(-25 17 45)"/><ellipse cx="18" cy="55" rx="2.4" ry="3.8" transform="rotate(-25 18 55)"/></g>'
		+ '<circle cx="36" cy="25" r="12" fill="' + INK + '" fill-opacity=".14" stroke="' + INK + '" stroke-width="4"/><path d="M45 34l11 11" stroke="' + INK + '" stroke-width="6" stroke-linecap="round"/>'
		+ '<path d="M32 22a4 4 0 1 1 5 4c-1 .5-1 1.5-1 3" fill="none" stroke="' + GOLD + '" stroke-width="2.4" stroke-linecap="round"/><circle cx="36" cy="33" r="1.5" fill="' + GOLD + '"/>'],
	fantasy: ["#5b3f6e", '<circle cx="62" cy="14" r="6" fill="' + GOLD + '"/><circle cx="65" cy="12" r="5.2" fill="#5b3f6e"/><g fill="' + INK + '" opacity=".7"><circle cx="14" cy="12" r="1"/><circle cx="24" cy="7" r="1.2"/><circle cx="52" cy="24" r=".9"/></g>'
		+ '<g fill="' + INK + '"><rect x="21" y="31" width="9" height="21"/><path d="M20 31l5.5-10 5.5 10z"/><rect x="50" y="31" width="9" height="21"/><path d="M49 31l5.5-10 5.5 10z"/>'
		+ '<path d="M30 36h3v-3h3v3h3v-3h2v3h3v-3h3v3h3v16H30z"/><rect x="36" y="21" width="8" height="13"/><path d="M35 21l5-11 5 11z"/></g>'
		+ '<path d="M40 10V4l6 2-6 2" fill="' + EMBER + '" stroke="' + EMBER + '" stroke-width="1"/><path d="M37 52v-6a3 3 0 0 1 6 0v6z" fill="#5b3f6e"/>'],
	scifi: ["#1f5e5e", '<g fill="' + INK + '" opacity=".7"><circle cx="10" cy="10" r="1"/><circle cx="20" cy="52" r="1"/><circle cx="70" cy="46" r="1.2"/><circle cx="46" cy="8" r=".9"/></g>'
		+ '<circle cx="59" cy="20" r="8" fill="' + GOLD + '"/><ellipse cx="59" cy="20" rx="14" ry="4" fill="none" stroke="' + INK + '" stroke-width="1.8" transform="rotate(-18 59 20)"/>'
		+ '<g transform="translate(30 34) rotate(40)"><path d="M-3 11 0 21l3-10z" fill="' + EMBER + '"/><path d="M0-17c7 6 7 20 4 28h-8c-3-8-3-22 4-28z" fill="' + INK + '"/>'
		+ '<circle cy="-4" r="2.6" fill="#1f5e5e"/><path d="M-4 3l-6 9 6-1zM4 3l6 9-6-1z" fill="' + INK + '"/></g>'],
	history: ["#7b4a1c", '<path d="M29 10h22M29 50h22" stroke="' + INK + '" stroke-width="3.5" stroke-linecap="round"/>'
		+ '<path d="M32 12c0 11 7 13 7 18s-7 7-7 18h16c0-11-7-13-7-18s7-7 7-18z" fill="' + INK + '" fill-opacity=".12" stroke="' + INK + '" stroke-width="2.4"/>'
		+ '<path d="M35 20h10c-1 3-4 5-5 6-1-1-4-3-5-6zM34 47c1-6 5-8 6-9 1 1 5 3 6 9z" fill="' + GOLD + '"/>'],
	people: ["#4a4f63", '<rect x="25" y="9" width="30" height="40" rx="3" fill="none" stroke="' + GOLD + '" stroke-width="3"/>'
		+ '<circle cx="40" cy="24" r="6.5" fill="' + INK + '"/><path d="M29 46c1-8 6-12 11-12s10 4 11 12z" fill="' + INK + '"/>'],
	philosophy: ["#35524a", '<ellipse cx="40" cy="36" rx="14" ry="16" fill="' + INK + '" fill-opacity=".9"/><path d="M27 24l3-9 6 6M53 24l-3-9-6 6" fill="' + INK + '"/>'
		+ '<g fill="#35524a"><circle cx="34" cy="30" r="5"/><circle cx="46" cy="30" r="5"/></g><g fill="' + GOLD + '"><circle cx="34" cy="30" r="2.2"/><circle cx="46" cy="30" r="2.2"/><path d="M38 36h4l-2 4z"/></g>'
		+ '<path d="M18 53h44" stroke="' + INK + '" stroke-width="3" stroke-linecap="round"/>'],
	religion: ["#6b2f45", '<circle cx="40" cy="20" r="13" fill="' + GOLD + '" opacity=".22"/><path d="M40 9c4 5 5 9 0 14-5-5-4-9 0-14z" fill="' + EMBER + '"/>'
		+ '<path d="M40 14c2 3 2 5 0 7-2-2-2-4 0-7z" fill="' + GOLD + '"/><rect x="34" y="25" width="12" height="25" rx="1.5" fill="' + INK + '"/><path d="M26 51h28" stroke="' + INK + '" stroke-width="3" stroke-linecap="round"/>'],
	science: ["#3d5a3a", '<g fill="none" stroke="' + INK + '" stroke-width="2.2"><ellipse cx="40" cy="30" rx="20" ry="7"/><ellipse cx="40" cy="30" rx="20" ry="7" transform="rotate(60 40 30)"/><ellipse cx="40" cy="30" rx="20" ry="7" transform="rotate(-60 40 30)"/></g>'
		+ '<circle cx="40" cy="30" r="4" fill="' + GOLD + '"/>'],
	poetry: ["#5b3f6e", '<path d="M54 8C40 12 30 26 27 44l3 1c4-14 13-26 24-37z" fill="' + INK + '"/><path d="M27 44l-3 8" stroke="' + INK + '" stroke-width="2" stroke-linecap="round"/>'
		+ '<path d="M34 52c6-4 12 3 20-2" fill="none" stroke="' + GOLD + '" stroke-width="2" stroke-linecap="round"/>'],
	book: ["#2f4f6f", '<path d="M40 18c-6-5-15-6-22-4v32c7-2 16-1 22 4 6-5 15-6 22-4V14c-7-2-16-1-22 4z" fill="' + INK + '"/>'
		+ '<path d="M40 18v32" stroke="#2f4f6f" stroke-width="1.5"/><g stroke="#2f4f6f" stroke-width="1" opacity=".5"><path d="M23 22c4-1 9 0 13 2M23 28c4-1 9 0 13 2M44 24c4-2 9-3 13-2M44 30c4-2 9-3 13-2"/></g>'
		+ '<path d="M53 12v12l3-2 3 2V12" fill="' + EMBER + '"/>'],
	horror: ["#2b2a33", '<circle cx="58" cy="17" r="10" fill="' + GOLD + '"/><g fill="#2b2a33"><path d="M50 13l3-2 1.5 1.5L56 11l3 2-2 .3-1 1.5-1.5-.8-1.5.8-1-1.5z"/></g>'
		+ '<g fill="' + INK + '" opacity=".75"><path d="M10 18l4-3 2 1.6 2-1.6 4 3-2.4.2-1 1.8-2.6-1-2.6 1-1-1.8z"/><path d="M22 9l3-2 1.4 1.2L27.8 7l3 2-1.8.2-.8 1.3-1.8-.7-1.8.7-.8-1.3z"/></g>'
		+ '<path d="M28 52V31a11 11 0 0 1 22 0v21l-3.7-3-3.6 3-3.7-3-3.7 3-3.6-3z" fill="' + INK + '"/>'
		+ '<g fill="#2b2a33"><ellipse cx="34.5" cy="31" rx="2.2" ry="3.2"/><ellipse cx="43.5" cy="31" rx="2.2" ry="3.2"/><ellipse cx="39" cy="40" rx="2.4" ry="3"/></g>'],
	ya: ["#7a3b2e", '<path d="M10 46c10 2 16-6 26-4" fill="none" stroke="' + INK + '" stroke-width="1.8" stroke-dasharray="3 3" stroke-linecap="round" opacity=".7"/>'
		+ '<path d="M30 36L66 14 50 46 43 38z" fill="' + INK + '"/><path d="M43 38l23-24-19 28z" fill="#000" opacity=".18"/><path d="M43 38v8l4-4" fill="' + INK + '"/>'
		+ '<circle cx="18" cy="16" r="5" fill="' + GOLD + '"/>'],
	kids: ["#34466a", '<rect y="34" width="80" height="12" fill="' + EMBER + '" opacity=".35"/><path d="M0 48q20-6 40-2t40-1v15H0z" fill="#22301f"/><g fill="' + INK + '" opacity=".7"><circle cx="12" cy="10" r="1"/><circle cx="26" cy="6" r=".9"/><circle cx="70" cy="30" r=".9"/></g>'
		+ '<circle cx="64" cy="12" r="5" fill="' + GOLD + '"/><circle cx="66.5" cy="10.5" r="4.4" fill="#34466a"/>'
		+ '<path d="M36 60V40c0-3-4-6-8-7M40 60V40c0-3 5-5 9-6" fill="none" stroke="#2b2218" stroke-width="5" stroke-linecap="round"/>'
		+ '<g fill="#2f5a3e"><circle cx="24" cy="30" r="11"/><circle cx="54" cy="29" r="11"/><circle cx="39" cy="22" r="13"/></g>'
		+ '<path d="M28 31h24v12H28z" fill="#b9814f"/><path d="M25 32l15-10 15 10z" fill="#7a3b2e"/><rect x="35" y="34" width="7" height="6" rx="1" fill="' + GOLD + '"/>'
		+ '<path d="M24 43h32" stroke="#2b2218" stroke-width="2"/><g stroke="' + INK + '" stroke-width="1.4" opacity=".85"><path d="M50 43v17M55 43v17M50 48h5M50 53h5M50 58h5"/></g>'],
	palette: ["#8a4b5e", '<path d="M40 12c-15 0-26 9-26 19 0 9 8 15 16 13 4-1 4-6 8-6 3 0 3 4 7 4 9 0 17-5 17-13 0-10-10-17-22-17z" fill="' + INK + '"/>'
		+ '<circle cx="31" cy="37" r="3.6" fill="#8a4b5e"/><circle cx="27" cy="26" r="3.4" fill="#c8322c"/><circle cx="36" cy="19" r="3.4" fill="' + GOLD + '"/>'
		+ '<circle cx="47" cy="20" r="3.4" fill="#5f9e8f"/><circle cx="54" cy="29" r="3.4" fill="#3b6d8f"/>'
		+ '<path d="M66 8L50 36" stroke="' + EMBER + '" stroke-width="3" stroke-linecap="round"/><path d="M50 36l-3 6 5-3z" fill="#3b3024"/>'],
	smile: ["#2f6b4f", '<circle cx="40" cy="30" r="19" fill="' + GOLD + '"/><g fill="none" stroke="#3b3024" stroke-width="2.6" stroke-linecap="round"><path d="M30 25q3-4 6 0M44 25q3-4 6 0"/></g>'
		+ '<path d="M29 33h22c0 7-5 11-11 11s-11-4-11-11z" fill="#3b3024"/><path d="M34 40c3-2 9-2 12 0-2 2.5-10 2.5-12 0z" fill="' + EMBER + '"/>'
		+ '<g fill="' + INK + '" opacity=".75"><path d="M12 14l2 3 3 2-3 2-2 3-2-3-3-2 3-2zM66 40l1.5 2.5 2.5 1.5-2.5 1.5-1.5 2.5-1.5-2.5-2.5-1.5 2.5-1.5z"/></g>'],
	summit: ["#4a5f7a", '<circle cx="18" cy="16" r="6" fill="' + GOLD + '"/><path d="M4 52l22-24 10 10 12-20 28 34z" fill="' + INK + '" opacity=".45"/>'
		+ '<path d="M18 52l26-36 22 36z" fill="' + INK + '"/><path d="M44 16l-6 8 3-1 3 3 3-3 3 1z" fill="#4a5f7a" opacity=".35"/>'
		+ '<path d="M44 16V5" stroke="#3b3024" stroke-width="1.6"/><path d="M44 5l9 3-9 3z" fill="' + EMBER + '"/>'],
	bolt: ["#3c3f6e", '<path d="M22 30a8 8 0 0 1 2-15.6A12 12 0 0 1 46 11a9 9 0 0 1 14 7 7 7 0 0 1-2 12z" fill="' + INK + '"/>'
		+ '<path d="M42 30l-10 13h8l-5 13 15-18h-8l5-8z" fill="' + GOLD + '"/>'
		+ '<g stroke="' + GOLD + '" stroke-width="1.6" stroke-linecap="round" opacity=".7"><path d="M24 40l-4 4M58 38l4 3"/></g>']
};
// A laurel wreath for nonfiction Classics: two arcs of leaves.
ART.laurel = ["#6b5a2e", (function () {
	var out = "";
	for (var i = 0; i < 6; i++) {
		var deg = 112 + i * 24, r = deg * Math.PI / 180, dx = Math.cos(r) * 18, y = (30 + Math.sin(r) * 18).toFixed(1);
		[[40 + dx, deg + 25], [40 - dx, 180 - deg - 25]].forEach(function (l) {
			var x = l[0].toFixed(1);
			out += '<ellipse cx="' + x + '" cy="' + y + '" rx="2.4" ry="5.4" fill="' + (i % 2 ? GOLD : INK) + '" transform="rotate(' + l[1] + " " + x + " " + y + ')"/>';
		});
	}
	return out + '<path d="M33 51l7-4 7 4" fill="none" stroke="' + EMBER + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
		+ '<path d="M40 22l2.4 5 5.4.6-4 3.7 1.1 5.3-4.9-2.7-4.9 2.7 1.1-5.3-4-3.7 5.4-.6z" fill="' + INK + '"/>';
})()];
var FICTION = [
	["Classics", /\bclassic/, "classics"],
	["Westerns", /\bwestern/, "westerns"],
	["Mysteries", /\bmyster|\bdetective/, "mysteries"],
	["Fantasy", /fantasy/, "fantasy"],
	["Science Fiction", /science fiction|\bsci ?-?fi\b|^sf$/, "scifi"],
	["Horror", /horror/, "horror"],
	["Young Adult", /young adult|\bya\b|\bteen/, "ya"],
	["Middle Grade", /middle grade|children|\bkids?\b/, "kids"]
];
// Which drawing a nonfiction tag gets. No two cards share one: a tag whose
// drawing is taken, or that matches none, gets the next spare.
var FACT_ART = [[/histor|\bwar\b/, "history"], [/biograph|memoir|\blives\b/, "people"], [/philosoph/, "philosophy"],
	[/religio|theolog|bible|spiritual/, "religion"], [/scien|physics|biolog|chemis|astronom|math|nature/, "science"], [/poe/, "poetry"],
	[/classic/, "laurel"], [/creativ|drawing|\bart\b|design/, "palette"], [/humou?r|comedy/, "smile"],
	[/personal|self|develop|productiv|success/, "summit"], [/myth|folklore|legend/, "bolt"]];
var SPARE_ART = ["book", "summit", "palette", "bolt", "laurel", "smile", "science", "history", "people", "philosophy", "religion", "poetry"];
var NONFIC = /^non-?fiction$/;
var pick = null, anyRecs = false;
function svgArt(key) {
	var a = ART[key] || ART.book;
	return '<svg viewBox="0 0 80 60" aria-hidden="true" focusable="false"><rect width="80" height="60" fill="' + a[0] + '"/>' + a[1] + "</svg>";
}
function genreButton(g) {
	var btn = h("button", "genre"), art = h("span", "art");
	btn.type = "button";
	btn.setAttribute("aria-pressed", String(!!pick && pick.id === g.id));
	art.innerHTML = svgArt(g.art);
	btn.append(art, h("span", "gl", g.label), h("span", "gn", g.n + (g.n === 1 ? " book" : " books")));
	btn.addEventListener("click", function () {
		pick = pick && pick.id === g.id ? null : g;
		// A pick starts from the whole library: a format or tag left on would
		// narrow it, often to nothing.
		if (pick) { tag = ""; $("tag").value = ""; if (format) { format = ""; renderFormats(); } }
		renderRecs();
		render();
	});
	return btn;
}
function renderRecs() {
	var fic = [], non = [], counts = {}, used = {};
	FICTION.forEach(function (f) {
		var test = function (b) { return b.tags.some(function (t) { return f[1].test(fold(t)); }); };
		var n = books.filter(test).length;
		if (n) fic.push({ id: "f:" + f[0], label: f[0], art: f[2], test: test, n: n });
	});
	// A tag every book has (like "Books") isn't a collection.
	var everywhere = {};
	books.forEach(function (b) { b.tags.forEach(function (t) { everywhere[t] = (everywhere[t] || 0) + 1; }); });
	common = {};
	Object.keys(everywhere).forEach(function (t) { if (everywhere[t] === books.length && books.length > 1) common[t] = 1; });
	books.forEach(function (b) {
		if (!b.tags.some(function (t) { return NONFIC.test(fold(t)); })) return;
		b.tags.forEach(function (t) { if (!NONFIC.test(fold(t)) && everywhere[t] < books.length) counts[t] = (counts[t] || 0) + 1; });
	});
	var tags = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || fold(a).localeCompare(fold(b)); }), arts = {};
	// Tags with their own drawing first, so a spare never takes one of those.
	tags.forEach(function (t) {
		FACT_ART.some(function (r) { if (r[0].test(fold(t)) && !used[r[1]]) { arts[t] = r[1]; used[r[1]] = 1; return true; } return false; });
	});
	tags.forEach(function (t) {
		var art = arts[t];
		if (!art) { art = SPARE_ART.filter(function (k) { return !used[k]; })[0] || "book"; used[art] = 1; }
		non.push({ id: "n:" + t, label: t, art: art, n: counts[t], test: function (b) {
			return b.tags.indexOf(t) >= 0 && b.tags.some(function (x) { return NONFIC.test(fold(x)); });
		} });
	});
	// A pick whose books have all gone lets go.
	if (pick && !fic.concat(non).some(function (g) { return g.id === pick.id; })) pick = null;
	[["fiction", "hFic", fic], ["nonfiction", "hNon", non]].forEach(function (row) {
		var box = $(row[0]);
		box.textContent = "";
		row[2].forEach(function (g) { box.append(genreButton(g)); });
		box.hidden = $(row[1]).hidden = !row[2].length;
	});
	anyRecs = fic.length + non.length > 0;
}
function renderTags() {
	var sel = $("tag"), names = {};
	books.forEach(function (b) { b.tags.forEach(function (t) { names[t] = 1; }); });
	var list = Object.keys(names).sort(function (a, b) { return fold(a).localeCompare(fold(b)); });
	sel.textContent = "";
	var all = h("option", null, "All tags");
	all.value = "";
	sel.append(all);
	list.forEach(function (t) { var o = h("option", null, t); o.value = t; sel.append(o); });
	sel.value = tag;
	sel.hidden = !list.length;
}
function render() {
	// An audiobook paired with its ebook opens the ebook's Record, and plays on its own.
	var id = openBook(), rb = id && findBook(id), pid = openPreview(), pb = pid && findBook(pid);
	if (rb && rb.parent) rb = rb.parent;
	$("browse").hidden = !!(rb || pb);
	$("record").hidden = !rb;
	$("preview").hidden = !pb;
	$("intro").hidden = !!(rb || pb);
	onRecord = !!rb;
	onPreview = !!pb;
	if (!pb) closePreview();
	if (rb) { $("head").hidden = $("sub").hidden = true; showRecord(rb); return; }
	if (pb) { $("head").hidden = $("sub").hidden = true; showPreview(pb); return; }
	document.title = "The Back Alley Library";
	$("head").hidden = false;
	var series = openSeries(), words = fold(query).split(/\s+/).filter(Boolean);
	var shown = books.filter(function (b) {
		if (series != null && fold(b.series) !== fold(series)) return false;
		if (format && b.type !== format && !(format === "audiobook" && b.audio)) return false;
		if (tag && b.tags.indexOf(tag) < 0) return false;
		if (pick && !pick.test(b)) return false;
		var text = fold([b.title, b.author, b.series, b.fileTitle].join(" "));
		return words.every(function (w) { return text.indexOf(w) >= 0; });
	});
	var ul = $("books");
	ul.textContent = "";
	$("up").hidden = series == null;
	$("recs").hidden = series != null || !anyRecs;
	if ($("welcome").hidden) $("head").textContent = series != null ? (shown[0] ? shown[0].series : series) : "The Back Alley Library";
	$("sub").hidden = series != null || !me.name || !$("welcome").hidden;
	// Browsing (no search, not inside a series): a series is one cover that opens to its volumes.
	var group = series == null && !words.length, seen = {};
	shown.forEach(function (b) {
		if (group && b.series) {
			if (seen[b.series]) return;
			var vols = shown.filter(function (x) { return x.series === b.series; });
			seen[b.series] = 1;
			if (vols.length > 1) { ul.append(seriesCard(b.series, vols)); return; }
		}
		ul.append(card(b));
	});
	$("none").hidden = shown.length > 0;
	$("count").textContent = series != null ? shown.length + (shown.length === 1 ? " volume" : " volumes")
		: shown.length === books.length ? books.length + (books.length === 1 ? " book" : " books") : shown.length + " of " + books.length;
}

function showSub() {
	if (!me.name) return;
	var audio = books.some(function (b) { return b.type === "audiobook"; }) && me.audio_left != null
		? ", " + (me.audio_left === 1 ? "1 audiobook" : me.audio_left + " audiobooks") : "";
	var left = me.left == null ? "" : " · " + (me.left === 1 ? "1 download" : me.left + " downloads") + audio + " left today";
	$("sub").textContent = "Signed in as " + me.name + left;
	$("sub").hidden = false;
}
// The Worker enforces the daily limit; this just says so before the tap
// leads to its page, and keeps the count on the page current.
// Audiobooks have their own limit: 2 a day, on top of the 10 books.
function limits(b) {
	return b.type === "audiobook" ? { left: me.audio_left, today: me.audio_today || [], key: "audio_left" }
		: { left: me.left, today: me.today || [], key: "left" };
}
function downloading(e, b) {
	var l = me && limits(b);
	if (!me || l.left == null || l.today.indexOf(b.id) >= 0) return;
	if (l.left <= 0) {
		e.preventDefault();
		alert("That's today's " + (b.type === "audiobook" ? "2 audiobooks" : "10 books") + ". Come back tomorrow for more.");
		return;
	}
	l.today.push(b.id);
	me[l.key]--;
	showSub();
}

// The Record: what's known about the book at once, then its jacket copy,
// pages and appeal terms, which the Worker looks up the first time.
var APPEAL = [["pacing", "Pacing"], ["tone", "Tone"], ["style", "Writing style"], ["characters", "Characters"], ["story", "Storyline"]];
function showRecord(b) {
	document.title = b.title + " · The Back Alley Library";
	fillCover($("rCover"), b);
	$("rTitle").textContent = b.title;
	$("rBy").textContent = b.author ? "by " + b.author : "";
	$("rBy").hidden = !b.author;
	var sr = $("rSeries");
	sr.textContent = "";
	sr.hidden = !b.series;
	if (b.series) {
		var link = h("a", null, b.series);
		link.href = "#series=" + encodeURIComponent(b.series);
		if (b.volume) sr.append("Book " + b.volume + " of ");
		sr.append(link);
	}
	recordFacts(b, records[b.id]);
	downloadButton($("rDl"), $("rLeft"), b);
	var pv = $("rPv"), listen = b.type === "audiobook";
	pv.href = "#preview=" + b.id;
	pv.textContent = listen ? "Listen" : "Read online";
	pv.setAttribute("aria-label", listen ? "Listen to " + b.title : "Read " + b.title + " online");
	pv.onclick = function () { viaRecord = true; };
	$("rAudio").hidden = !b.audio;
	if (b.audio) {
		downloadButton($("rAdl"), $("rALeft"), b.audio);
		$("rListen").href = "#preview=" + b.audio.id;
		$("rListen").setAttribute("aria-label", "Listen to " + b.title);
		$("rListen").onclick = function () { viaRecord = true; };
	}
	if (records[b.id]) return recordDetails(b, records[b.id]);
	$("rBlurbSec").hidden = false;
	$("rBlurb").innerHTML = '<p class="muted">Looking this book up…</p>';
	$("rBlurbNote").hidden = $("rAppealSec").hidden = true;
	var get = function (id) {
		return fetch("/api/family/books/" + id).then(function (res) {
			if (!res.ok) throw new Error();
			return res.json();
		}).then(function (d) { return d.record; });
	};
	Promise.all([get(b.id), b.audio ? get(b.audio.id).catch(function () { return null; }) : null]).then(function (r) {
		var rec = records[b.id] = withAudio(r[0], r[1]);
		if (openBook() === b.id) { recordFacts(b, rec); recordDetails(b, rec); }
	}).catch(function () {
		if (openBook() === b.id) $("rBlurb").innerHTML = '<p class="muted">Couldn\'t look this book up just now.</p>';
	});
}
// A book with an audiobook too: Audiobookshelf's details (usually
// Audible's, once matched there) come first for what the two share. Its
// description wins over any but one edited by hand. Publisher, year and
// ISBN describe an edition, and the audiobook's are the recording's, so
// the ebook's stay and the audiobook's only fill gaps. Appeal terms the
// ebook lacks come from the audiobook's record.
function withAudio(rec, audio) {
	if (!audio) return rec;
	var out = Object.assign({}, rec, { from: Object.assign({}, rec.from), catalog: Object.assign({}, rec.catalog) });
	if (audio.blurb && audio.from.blurb === "file" && rec.from.blurb !== "edited") {
		out.blurb = audio.blurb;
		out.from.blurb = "abs";
	}
	Object.keys(audio.catalog || {}).forEach(function (k) {
		if (k !== "isbn" && !out.catalog[k]) out.catalog[k] = audio.catalog[k];
	});
	if (!rec.appeal && audio.appeal) out.appeal = audio.appeal;
	return out;
}
function recordFacts(b, rec) {
	var dl = $("rFacts"), add = function (k, v) { if (v) dl.append(h("dt", null, k), h("dd", null, v)); };
	dl.textContent = "";
	add("Format", KIND[b.type] + " · " + bytes(b.size));
	if (b.type === "audiobook") { add("Length", hours(b.duration)); add("Narrator", b.narrator); }
	if (b.audio) { add("Audiobook", hours(b.audio.duration) + " · " + bytes(b.audio.size)); add("Narrator", b.audio.narrator); }
	if (rec && rec.pages) add("Length", (rec.from.pages === "estimate" ? "About " : "") + rec.pages.toLocaleString() + (rec.pages === 1 ? " page" : " pages"));
	var c = rec && rec.catalog || {};
	add("Published", c.year);
	add("Publisher", c.publisher);
	add("Language", c.language);
	add("Shelved", b.tags.filter(function (t) { return !common[t]; }).join(", "));
	add("Call number", c.classification);
	add("Subjects", (c.subjects || []).join("; "));
	add("ISBN", c.isbn);
}
function downloadButton(dl, left, b) {
	dl.href = "/api/family/books/" + b.id + "/file";
	dl.onclick = function (e) { downloading(e, b); setTimeout(function () { recordLeft(dl, left, b); }, 0); };
	recordLeft(dl, left, b);
}
function recordLeft(dl, left, b) {
	var l = limits(b), audio = b.type === "audiobook";
	var took = l.today.indexOf(b.id) >= 0, out = l.left != null && l.left <= 0 && !took;
	dl.textContent = out ? "That's today's " + (audio ? "2 audiobooks" : "10 books") : "Download " + KIND[b.type];
	dl.classList.toggle("off", out);
	dl.setAttribute("aria-label", out ? "No downloads left today" : "Download " + b.title + ", " + KIND[b.type] + ", " + bytes(b.size));
	left.hidden = l.left == null;
	if (l.left == null) return;
	left.textContent = took ? "Downloaded today, so taking it again doesn't count." : out ? "Come back tomorrow for more." + (audio ? " You can still listen here." : "")
		: audio ? (l.left === 1 ? "1 audiobook download" : l.left + " audiobook downloads") + " left today. Listening here doesn't count."
		: (l.left === 1 ? "1 download" : l.left + " downloads") + " left today.";
}
function recordDetails(b, rec) {
	var box = $("rBlurb"), note = $("rBlurbNote"), who = function (m) { return /^claude/.test(m || "") ? "Claude" : "an AI model"; };
	box.textContent = "";
	(rec.blurb || "").split(/\n\s*\n/).forEach(function (p) { if (p.trim()) box.append(h("p", null, p.trim())); });
	var said = { openlibrary: "From Open Library.", google: "From Google Books.", abs: "From the audiobook's details.",
		ai: "This one had no jacket copy, so " + who(rec.from.blurb_model) + " wrote this summary." }[rec.from.blurb];
	note.textContent = said || "";
	note.hidden = !said || !rec.blurb;
	$("rBlurbSec").hidden = !rec.blurb;
	var dl = $("rAppeal"), any = false;
	dl.textContent = "";
	APPEAL.forEach(function (f) {
		var terms = rec.appeal && rec.appeal[f[0]];
		if (!terms || !terms.length) return;
		var dd = h("dd", "f-" + f[0]);
		terms.forEach(function (t) { dd.append(h("span", "term", t)); });
		dl.append(h("dt", "f-" + f[0], f[1]), dd);
		any = true;
	});
	$("rAppealSec").hidden = !any;
	if (!rec.blurb && !any) {
		$("rBlurbSec").hidden = false;
		box.innerHTML = '<p class="muted">Nothing more on this one yet.</p>';
	}
}
// Reading online: the whole book on the page (see "Reading online" in the
// Worker). EPUB and text as paragraphs laid out here, a piece at a time as
// the reader nears the end of what's there; a comic's pages as images; a
// PDF's pages drawn by pdf.js from the pieces of the file it asks for. It
// isn't a download, so it doesn't count toward the 10 a day. The place is
// kept on this device (read:<id>), and the book opens there next time.
var PDFJS = "__PDFJS__", PDFJS_DATA = "__PDFJS_DATA__";
var pv = null, pdfjsLoading = null;
function closePreview() {
	if (!pv) return;
	pv.alive = false;
	pv.cleanup.forEach(function (f) { try { f(); } catch (e) {} });
	$("pvBody").textContent = "";
	pv = null;
}
function showPreview(b) {
	var listen = b.type === "audiobook";
	document.title = (listen ? "Listen: " : "Read: ") + b.title + " · The Back Alley Library";
	$("pvEye").textContent = listen ? "Listen" : "Read online";
	$("pvBack").href = "#book=" + (b.parent || b).id;
	$("pvBack").textContent = "‹ Back to the record";
	$("pvTitle").textContent = b.title;
	$("pvBy").textContent = b.author ? "by " + b.author : "";
	$("pvBy").hidden = !b.author;
	if (pv && pv.id === b.id) return;
	closePreview();
	var sess = pv = { id: b.id, alive: true, cleanup: [] };
	$("pvNote").textContent = listen ? "Loading…" : "Loading the book…";
	$("pvEnd").hidden = true;
	$("pvBody").textContent = "";
	// The book playing in the bar: its player, as it was left.
	if (nowPlaying && nowPlaying.id === b.id) return nowPlaying.attach(sess);
	var place = /^(\d+):(\d+)$/.exec(read("read:" + b.id) || "");
	previewPiece(b, place ? place[1] : 0).then(function (d) {
		if (!sess.alive) return;
		if (d.type === "audiobook") return previewAudio(sess, b, d);
		if (d.type === "pdf") return previewPdf(sess, b, d);
		if (d.type === "cbz") return previewComic(sess, b, d);
		previewText(sess, b, d);
	}).catch(function (e) {
		if (!sess.alive) return;
		$("pvNote").textContent = (e && e.message) || "Couldn't load the book.";
		previewEnd(b, "");
	});
}
function previewPiece(b, at) {
	return fetch("/api/family/books/" + b.id + "/preview" + (at ? "?at=" + at : "")).then(function (res) {
		return res.json().catch(function () { return {}; }).then(function (d) {
			if (!res.ok) throw new Error(d.error || "Couldn't load the book.");
			return d;
		});
	});
}
// The place: the page or paragraph a third of the way down the screen, kept
// a moment after scrolling stops. -> the element there with data-place.
function keepPlace(sess, b, box) {
	var timer = 0, save = function () {
		var r = box.getBoundingClientRect(), el = document.elementFromPoint(r.left + r.width / 2, window.innerHeight / 3);
		el = el && el.closest("[data-place]");
		if (el && box.contains(el)) store("read:" + b.id, el.dataset.place);
	};
	var onScroll = function () { clearTimeout(timer); timer = setTimeout(save, 400); };
	window.addEventListener("scroll", onScroll, { passive: true });
	sess.cleanup.push(function () { clearTimeout(timer); window.removeEventListener("scroll", onScroll); });
}
function goToPlace(el) {
	if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3 + 8);
}
function previewEnd(b, text) {
	$("pvEndText").textContent = text;
	$("pvEndText").hidden = !text;
	downloadButton($("pvDl"), $("pvLeft"), b);
	$("pvEnd").hidden = false;
}
// Listening: the whole audiobook, streamed from the home server a piece at a
// time, so it isn't a download and isn't counted. Laid out like the app's
// player page: a square cover, the chapter playing with a slider across just
// that chapter, previous/next chapter, back 15 and forward 30, speed, a
// sleep timer, and every chapter to jump to (from the chapter's name, the
// Chapters button, or the list below). A book in several files plays them
// in turn. The place and the speed are kept on this device, and the lock
// screen shows the cover and takes play, pause and skips.
// Once it has played, it keeps playing after the page is left, in the bar
// at the bottom (nowPlaying), until the bar's × or another book plays. Its
// audio element lives outside the page (in #lbAudio), since one taken out
// of the document stops.
var SPEEDS = [1, 1.25, 1.5, 1.75, 2];
var SVG_PREV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2.2v14H6zM19 5v14L9.5 12z"/></svg>';
var SVG_NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.8 5H18v14h-2.2zM5 5v14l9.5-7z"/></svg>';
var SVG_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
var SVG_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
// Voice boost (the Voice button under the player): voices brought forward
// and quiet speech lifted, through the Web Audio API. A cut below 90 Hz,
// a lift around 3 kHz where speech is clearest, a compressor that evens out
// loud and soft, the level made up again, and a limiter so it can't clip.
// "Voice +" is a little, "Voice ++" more. Kept on this device. A book only
// goes through Web Audio once it plays with boost on; turned off, it's
// passed straight through. An audio context starts only from a tap, so it
// starts with the first tap on a player (not anywhere on the page, since a
// running one can stop music playing in another app).
var VOICE_LEVELS = [null, { eq: 4, thr: -24, ratio: 3, gain: 1.25 }, { eq: 6, thr: -30, ratio: 4, gain: 1.6 }];
var voice = { level: Number(read("voiceBoost")) || 0, ctx: null, chain: null, wired: [] };
if (!VOICE_LEVELS[voice.level]) voice.level = 0;
function voiceCtx() {
	var AC = window.AudioContext || window.webkitAudioContext;
	if (!voice.ctx && AC) {
		try { voice.ctx = new AC(); } catch (e) { return null; }
		// iOS: play as media, past the silent switch, as the audio element would.
		try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {}
		var c = voice.ctx, n = voice.chain = {
			hp: c.createBiquadFilter(), eq: c.createBiquadFilter(), comp: c.createDynamicsCompressor(),
			gain: c.createGain(), lim: c.createDynamicsCompressor(),
		};
		n.hp.type = "highpass";
		n.hp.frequency.value = 90;
		n.eq.type = "peaking";
		n.eq.frequency.value = 3000;
		n.eq.Q.value = 0.9;
		n.comp.knee.value = 10;
		n.comp.attack.value = 0.005;
		n.comp.release.value = 0.25;
		n.lim.threshold.value = -2;
		n.lim.knee.value = 0;
		n.lim.ratio.value = 20;
		n.lim.attack.value = 0.001;
		n.lim.release.value = 0.1;
		n.hp.connect(n.eq);
		n.eq.connect(n.comp);
		n.comp.connect(n.gain);
		n.gain.connect(n.lim);
		n.lim.connect(c.destination);
	}
	if (voice.ctx && voice.ctx.state !== "running") voice.ctx.resume().catch(function () {});
	return voice.ctx;
}
// Every book wired so far, through the chain at this level or straight out.
function voiceRoute() {
	if (!voice.ctx) return;
	var v = VOICE_LEVELS[voice.level], n = voice.chain;
	if (v) {
		n.eq.gain.value = v.eq;
		n.comp.threshold.value = v.thr;
		n.comp.ratio.value = v.ratio;
		n.gain.gain.value = v.gain;
	}
	voice.wired.forEach(function (s) {
		s.disconnect();
		s.connect(v ? n.hp : voice.ctx.destination);
	});
}
// On play: a book not wired yet goes through, if boost is on and the context
// is running (it isn't before a tap, and then the book plays as it is).
function voiceWire(audio) {
	if (voice.ctx && voice.ctx.state !== "running") voice.ctx.resume().catch(function () {});
	if (!voice.level || audio.voiceSrc || !voice.ctx || voice.ctx.state !== "running") return;
	try { audio.voiceSrc = voice.ctx.createMediaElementSource(audio); } catch (e) { return; }
	voice.wired.push(audio.voiceSrc);
	voiceRoute();
}
function voiceUnwire(audio) {
	if (!audio.voiceSrc) return;
	audio.voiceSrc.disconnect();
	voice.wired = voice.wired.filter(function (s) { return s !== audio.voiceSrc; });
}
// The Voice button: off, a little, more, and round again.
function voiceNext(audio) {
	voice.level = (voice.level + 1) % VOICE_LEVELS.length;
	store("voiceBoost", String(voice.level));
	var c = voice.level ? voiceCtx() : voice.ctx;
	if (!c) return;
	c.resume().then(function () {
		if (!audio.paused) voiceWire(audio);
		voiceRoute();
	}, function () {});
}
function voiceLabel() { return ["Voice", "Voice +", "Voice ++"][voice.level]; }
document.addEventListener("click", function (e) {
	if (voice.level && e.target.closest && e.target.closest(".lplay, #lbar")) voiceCtx();
}, true);
function previewAudio(sess, b, d) {
	$("pvNote").textContent = [b.narrator ? "Read by " + b.narrator : "", hours(d.duration || b.duration)].filter(Boolean).join(" · ");
	var files = d.files || [], starts = [], total = 0;
	files.forEach(function (f) { starts.push(total); total += f.duration || 0; });
	var audio = h("audio"), cur = -1, pending = null, saved = 0;
	var rate = parseFloat(read("listenRate")) || 1, part = h("p", "pfile muted");
	var eng = { id: b.id, b: b, audio: audio, alive: true, note: $("pvNote").textContent, total: total };
	var onPage = function () { return !!pv && pv.id === b.id && eng.alive; };
	$("lbAudio").append(audio);
	if (SPEEDS.indexOf(rate) < 0) rate = 1;
	audio.preload = "metadata";
	var chapters = (d.chapters || []).length > 1 ? d.chapters : [];
	// The chapter at t: {i, start, end} (the whole book when it has no chapters).
	var chapterAt = function (t) {
		var i = -1;
		chapters.forEach(function (c, n) { if (c.start <= t + 0.5) i = n; });
		if (i < 0) return { i: -1, start: 0, end: total };
		return { i: i, start: chapters[i].start, end: chapters[i + 1] ? chapters[i + 1].start : total };
	};
	var now = function () { return cur < 0 ? 0 : starts[cur] + (audio.currentTime || 0); };
	var load = function (n, at, play) {
		cur = n;
		pending = at;
		audio.src = "/api/family/books/" + b.id + "/audio/" + n;
		audio.defaultPlaybackRate = audio.playbackRate = rate;
		part.textContent = "Part " + (n + 1) + " of " + files.length;
		part.hidden = files.length < 2;
		if (play) audio.play().catch(function () {});
	};
	// A place in the whole book -> the file it's in, and the time in it.
	var seek = function (t, play) {
		t = Math.max(0, Math.min(t, Math.max(0, total - 1)));
		// An end-of-chapter sleep timer follows to the chapter landed in.
		if (sl.end != null) sl.end = chapterAt(t).end;
		var n = 0;
		while (n + 1 < files.length && starts[n + 1] <= t) n++;
		if (n !== cur) load(n, t - starts[n], play);
		else {
			audio.currentTime = t - starts[n];
			if (play) audio.play().catch(function () {});
		}
		render(t);
	};
	var keep = function () { if (cur >= 0) store("listen:" + b.id, String(Math.floor(now()))); };
	audio.addEventListener("loadedmetadata", function () {
		if (pending) audio.currentTime = pending;
		pending = null;
	});
	audio.addEventListener("ended", function () {
		if (cur + 1 < files.length) load(cur + 1, 0, true);
		else { store("listen:" + b.id, "0"); setSleep("off"); }
	});
	audio.addEventListener("timeupdate", function () {
		var t = now();
		if (Math.abs(t - saved) >= 5) { saved = t; keep(); position(t); }
		if (sl.end != null && !audio.paused && t >= sl.end - 0.3) sleepNow();
		render(t);
		if (nowPlaying === eng) paintBar();
	});
	audio.addEventListener("play", function () { voiceWire(audio); playing(); showPlaying(); position(now()); paintBar(); });
	audio.addEventListener("pause", function () { showPlaying(); position(now()); paintBar(); });
	audio.addEventListener("pause", keep);
	audio.addEventListener("error", function () {
		if (onPage() && audio.error) $("pvNote").textContent = "This audiobook couldn't play just now. The home server may be offline, so try again later.";
	});

	var btn = function (cls, html, label, fn) {
		var x = h("button", cls);
		x.type = "button";
		x.innerHTML = html;
		if (label) x.setAttribute("aria-label", label);
		x.addEventListener("click", fn);
		return x;
	};
	// Previous: back to this chapter's start, or the one before when it's only
	// just begun. Next: the next chapter's start.
	var step = function (by) {
		var t = now(), ch = chapterAt(t);
		if (by < 0) seek(t - ch.start > 3 || ch.i <= 0 ? ch.start : chapters[ch.i - 1].start, !audio.paused);
		else if (chapters[ch.i + 1]) seek(chapters[ch.i + 1].start, !audio.paused);
	};
	var skip = function (by) { seek(now() + by, !audio.paused); };
	var playBtn = btn("pplay", SVG_PLAY, "Play", function () {
		if (audio.paused) audio.play().catch(function () {}); else audio.pause();
	});
	var prev = btn(null, SVG_PREV, "Previous chapter", function () { step(-1); });
	var next = btn(null, SVG_NEXT, "Next chapter", function () { step(1); });
	var ctl = h("div", "lpctl");
	ctl.append(prev, btn(null, "&#8634;15", "Back 15 seconds", function () { skip(-15); }), playBtn,
		btn(null, "30&#8635;", "Forward 30 seconds", function () { skip(30); }), next);
	var showPlaying = function () {
		var on = !audio.paused;
		playBtn.innerHTML = on ? SVG_PAUSE : SVG_PLAY;
		playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
	};

	// The slider runs across the chapter playing (the whole book with no chapters).
	var chap = btn("lpchap", "", null, function () { pick(); });
	chap.setAttribute("aria-haspopup", "dialog");
	chap.hidden = true;
	var seekBar = h("input", "pseek"), times = h("div", "lptimes"), at = h("span"), left = h("span"), drag = null;
	seekBar.type = "range";
	seekBar.min = 0;
	seekBar.max = 1000;
	seekBar.step = 1;
	seekBar.value = 0;
	times.append(at, left);
	var dragAt = function () { return drag.start + seekBar.value / 1000 * (drag.end - drag.start); };
	seekBar.addEventListener("input", function () {
		if (!drag) drag = chapterAt(now());
		var t = dragAt();
		seekBar.style.setProperty("--p", seekBar.value / 10 + "%");
		at.textContent = clock(t - drag.start);
		left.textContent = "−" + clock(Math.max(0, drag.end - t));
	});
	seekBar.addEventListener("change", function () {
		if (!drag) return;
		var t = dragAt();
		drag = null;
		seek(t, !audio.paused);
	});

	var rateBtn = btn("small", rate + "×", "Playback speed", function () {
		rate = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length] || 1;
		audio.defaultPlaybackRate = audio.playbackRate = rate;
		store("listenRate", String(rate));
		rateBtn.textContent = rate + "×";
		position(now());
	});
	var chapsBtn = btn("small", "Chapters", null, function () { pick(); });
	chapsBtn.setAttribute("aria-haspopup", "dialog");
	chapsBtn.hidden = !chapters.length;
	var sleepBtn = btn("small sleepbtn", "Sleep", null, function () {
		var open = sleepOpts.hidden;
		sleepOpts.hidden = !open;
		sleepBtn.setAttribute("aria-expanded", String(open));
	});
	sleepBtn.setAttribute("aria-expanded", "false");
	var voiceBtn = btn("small voicebtn", "", null, function () { voiceNext(audio); paintVoice(); });
	var paintVoice = function () {
		voiceBtn.textContent = voiceLabel();
		voiceBtn.setAttribute("aria-label", "Voice boost: " + ["off", "a little", "more"][voice.level]);
		voiceBtn.classList.toggle("on", voice.level > 0);
	};
	paintVoice();
	var info = h("span", "lpinfo"), more = h("div", "lpmore");
	more.append(rateBtn, chapsBtn, sleepBtn, voiceBtn, info);
	var sleepOpts = h("div", "lpsleep");
	sleepOpts.setAttribute("role", "group");
	sleepOpts.setAttribute("aria-label", "Sleep timer");
	sleepOpts.hidden = true;
	[["15", "15 min"], ["30", "30 min"], ["45", "45 min"], ["60", "1 h"], ["chapter", chapters.length ? "End of chapter" : "End of book"], ["off", "Off"]].forEach(function (o) {
		sleepOpts.append(btn("small", o[1], null, function () {
			setSleep(o[0]);
			sleepOpts.hidden = true;
			sleepBtn.setAttribute("aria-expanded", "false");
		}));
	});

	var cov = h("div", "lpcov"), main = h("div", "lpmain"), box = h("div", "lplay");
	cov.append(fillCover(h("div", "cover"), b));
	main.append(chap, seekBar, times, ctl, more, sleepOpts, part);
	box.append(cov, main);
	$("pvBody").append(box);

	// Every chapter: a list under the player, and the same list in a picker
	// over the page, opened from the chapter's name or the Chapters button.
	var lists = [], dlg = null;
	var pick = function () {
		if (!dlg) return;
		dlg.showModal();
		inView(lists[1]);
	};
	var inView = function (ol) {
		var on = ol.querySelector("[aria-current]");
		if (on) ol.scrollTop = on.parentNode.offsetTop - ol.offsetTop - ol.clientHeight / 3;
	};
	if (chapters.length) {
		var sec = h("section", "lpchaps");
		sec.append(h("h2", null, "Chapters"));
		dlg = h("dialog", "chapdlg");
		dlg.setAttribute("aria-label", "Chapters");
		var hd = h("div", "chapdlghd");
		hd.append(h("h2", null, "Chapters"), btn("x", "&times;", "Close", function () { dlg.close(); }));
		dlg.append(hd);
		[sec, dlg].forEach(function (parent) {
			var ol = h("ol", "chapters");
			chapters.forEach(function (c, i) {
				var li = h("li"), x = h("button");
				x.type = "button";
				x.append(h("span", null, c.title || "Chapter " + (i + 1)), h("span", "chtime", clock(c.start)));
				x.addEventListener("click", function () {
					if (dlg.open) dlg.close();
					seek(c.start, true);
				});
				li.append(x);
				ol.append(li);
			});
			lists.push(ol);
			parent.append(ol);
		});
		// A tap on the dimmed page around it closes it.
		dlg.addEventListener("click", function (e) {
			var r = dlg.getBoundingClientRect();
			if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dlg.close();
		});
		$("pvBody").append(sec, dlg);
	}

	var marked = null;
	var render = function (t) {
		var ch = chapterAt(t), len = Math.max(0, ch.end - ch.start), n = chapters.length, c = chapters[ch.i];
		chap.textContent = c ? c.title || "Chapter " + (ch.i + 1) : "";
		chap.hidden = !c;
		if (c) chap.setAttribute("aria-label", "Chapter: " + chap.textContent + ". Choose a chapter");
		if (!drag) {
			seekBar.value = len ? Math.round((t - ch.start) / len * 1000) : 0;
			seekBar.style.setProperty("--p", seekBar.value / 10 + "%");
			at.textContent = clock(Math.max(0, t - ch.start));
			left.textContent = "−" + clock(Math.max(0, ch.end - t));
		}
		seekBar.setAttribute("aria-label", n ? "Place in the chapter" : "Place in the book");
		seekBar.setAttribute("aria-valuetext", clock(t - ch.start) + " of " + clock(len));
		next.disabled = !(n && ch.i + 1 < n);
		info.textContent = (c ? "Chapter " + (ch.i + 1) + " of " + n + " · " : "") + hours(Math.max(0, total - t)) + " left";
		if (ch.i !== marked) {
			marked = ch.i;
			lists.forEach(function (ol) {
				ol.querySelectorAll("button").forEach(function (x, k) { if (k === ch.i) x.setAttribute("aria-current", "true"); else x.removeAttribute("aria-current"); });
				inView(ol);
			});
		}
	};

	// The sleep timer: pause after some minutes of listening (the last 10
	// seconds fade out where the browser lets a page set the volume), or at
	// the end of the chapter playing. Minutes count only while it plays.
	var sl = { left: null, end: null, last: 0, timer: null };
	var setSleep = function (v) {
		clearInterval(sl.timer);
		sl.left = sl.end = sl.timer = null;
		audio.volume = 1;
		if (v === "chapter") sl.end = chapterAt(now()).end;
		else if (v !== "off" && v != null) {
			sl.left = Number(v) * 60;
			sl.last = Date.now();
			sl.timer = setInterval(tick, 1000);
		}
		paintSleep();
	};
	var tick = function () {
		var t = Date.now();
		if (!audio.paused) sl.left -= (t - sl.last) / 1000;
		sl.last = t;
		if (sl.left <= 0) return sleepNow();
		audio.volume = Math.max(0, Math.min(1, sl.left / 10));
		paintSleep();
	};
	var sleepNow = function () {
		audio.pause();
		setSleep("off");
		sleepBtn.textContent = "Sleep · paused";
	};
	var paintSleep = function () {
		sleepBtn.textContent = sl.left != null ? "Sleep · " + clock(Math.ceil(sl.left)) : sl.end != null ? "Sleep · end of " + (chapters.length ? "chapter" : "book") : "Sleep";
		sleepBtn.classList.toggle("on", sl.left != null || sl.end != null);
	};

	// The lock screen and Control Center: the title, the cover, and the
	// place in the whole book (not in the file playing).
	var ms = "mediaSession" in navigator ? navigator.mediaSession : null;
	var position = function (t) {
		if (!ms || !ms.setPositionState || !total) return;
		try { ms.setPositionState({ duration: total, position: Math.min(total, Math.max(0, t)), playbackRate: rate }); } catch (e) {}
	};
	var handlers = eng.handlers = {
		play: function () { audio.play().catch(function () {}); },
		pause: function () { audio.pause(); },
		seekbackward: function (e) { skip(-((e && e.seekOffset) || 15)); },
		seekforward: function (e) { skip((e && e.seekOffset) || 30); },
		seekto: function (e) { if (e && e.seekTime != null) seek(e.seekTime, !audio.paused); },
	};
	// The first play makes it the book in the bar, and stops the one there before.
	var playing = function () {
		if (nowPlaying === eng) return;
		if (nowPlaying) nowPlaying.teardown();
		nowPlaying = eng;
		if (ms) lockScreen();
	};
	var lockScreen = function () {
		var meta = { title: b.title, artist: b.author || "", album: "The Back Alley Library" };
		var setMeta = function (art) { try { ms.metadata = new MediaMetadata(art ? Object.assign({}, meta, { artwork: [art] }) : meta); } catch (e) {} };
		setMeta(null);
		Object.keys(handlers).forEach(function (k) { try { ms.setActionHandler(k, handlers[k]); } catch (e) {} });
		// The cover as a data: URL: the phone fetches artwork by itself, and a blob: URL isn't always shown.
		var src = b.cover === "none" ? null : "/api/family/books/" + b.id + "/cover";
		if (src) fetch(src).then(function (res) { return res.ok ? res.blob() : null; }).then(function (blob) {
			if (!blob || nowPlaying !== eng) return;
			var fr = new FileReader();
			fr.onload = function () { if (nowPlaying === eng) setMeta({ src: fr.result, sizes: "600x600", type: blob.type || "image/jpeg" }); };
			fr.readAsDataURL(blob);
		}).catch(function () {});
	};

	var from = parseFloat(read("listen:" + b.id)) || 0;
	seek(from, false);
	showPlaying();
	paintSleep();
	if (from > 5) $("pvNote").textContent += " · Picks up at " + clock(from);
	// Leaving the page: the book in the bar plays on; one never played stops here.
	var detach = function () {
		if (dlg && dlg.open) dlg.close();
		if (nowPlaying !== eng) return eng.teardown();
		keep();
		paintBar();
	};
	eng.attach = function (s) {
		$("pvNote").textContent = eng.note;
		$("pvBody").append(box);
		if (sec) $("pvBody").append(sec, dlg);
		render(now());
		paintVoice();
		previewEnd(b, "");
		s.cleanup.push(detach);
		paintBar();
	};
	eng.teardown = function () {
		if (!eng.alive) return;
		keep();
		setSleep("off");
		eng.alive = false;
		if (dlg && dlg.open) dlg.close();
		audio.pause();
		voiceUnwire(audio);
		audio.removeAttribute("src");
		audio.load();
		audio.remove();
		if (nowPlaying === eng) {
			nowPlaying = null;
			if (ms) {
				try { ms.metadata = null; } catch (e) {}
				Object.keys(handlers).forEach(function (k) { try { ms.setActionHandler(k, null); } catch (e) {} });
			}
		}
		paintBar();
	};
	eng.now = now;
	eng.paused = function () { return audio.paused; };
	eng.toggle = function () { if (audio.paused) audio.play().catch(function () {}); else audio.pause(); };
	eng.skip = skip;
	eng.label = function (t) { var c = chapters[chapterAt(t).i]; return c ? c.title || "Chapter " + (chapterAt(t).i + 1) : ""; };
	sess.cleanup.push(detach);
	previewEnd(b, "");
}

// The player bar: the book playing, once its Listen page is left, so it
// keeps going while the library is browsed. The title opens its player.
var nowPlaying = null;
function paintBar() {
	var e = nowPlaying, on = !!e && openPreview() !== e.id;
	$("lbar").hidden = !on;
	document.body.classList.toggle("has-lbar", on);
	if (!on) return;
	var t = e.now(), label = e.label(t);
	if ($("lbar").dataset.id !== String(e.id)) {
		$("lbar").dataset.id = String(e.id);
		$("lbTitle").href = "#preview=" + e.id;
		$("lbName").textContent = e.b.title;
		$("lbCov").textContent = "";
		$("lbCov").append(fillCover(h("div", "cover"), e.b));
	}
	$("lbTime").textContent = label ? label + " · " + clock(t) : clock(t) + " / " + clock(e.total);
	$("lbProg").style.width = (e.total ? Math.min(100, t / e.total * 100) : 0) + "%";
	var paused = e.paused();
	$("lbPlay").innerHTML = paused ? SVG_PLAY : SVG_PAUSE;
	$("lbPlay").setAttribute("aria-label", paused ? "Play" : "Pause");
}
$("lbPlay").addEventListener("click", function () { if (nowPlaying) nowPlaying.toggle(); });
$("lbBack").addEventListener("click", function () { if (nowPlaying) nowPlaying.skip(-15); });
$("lbFwd").addEventListener("click", function () { if (nowPlaying) nowPlaying.skip(30); });
$("lbClose").addEventListener("click", function () { if (nowPlaying) nowPlaying.teardown(); });
$("lbTitle").addEventListener("click", function () { viaRecord = false; });
// iOS 26 can lay a home-screen app out taller than the screen, leaving the
// bottom of the page (and the bar) below the edge. Upright, the page should
// never be taller than the screen; whatever it's over by is lifted back into
// view (--lost), as in the app.
function fitScreen() {
	var app = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
	var upright = window.innerHeight > window.innerWidth;
	var lost = app && upright ? Math.max(0, Math.round(window.innerHeight - Math.max(screen.width, screen.height))) : 0;
	document.documentElement.style.setProperty("--lost", lost + "px");
}
fitScreen();
window.addEventListener("resize", fitScreen);
function previewText(sess, b, d) {
	var box = h("div", "pvtext"), more = h("p", "pvmore muted"), loading = false, next = d.next;
	var place = /^(\d+):(\d+)$/.exec(read("read:" + b.id) || "");
	var add = function (d) {
		if (box.firstChild && d.blocks.length && d.blocks[0].k !== "hr") box.append(h("hr"));
		d.blocks.forEach(function (bl, i) {
			if (bl.k === "hr") { box.append(h("hr")); return; }
			var el = h(bl.k === "h" ? "h2" : bl.k === "q" ? "blockquote" : "p");
			el.dataset.place = d.at + ":" + i;
			bl.r.forEach(function (run) {
				var text = run[0], style = run[1] || "";
				if (!style) { el.append(text); return; }
				var outer = h(style.indexOf("i") >= 0 ? "em" : "strong"), inner = outer;
				if (style === "ib") { inner = h("strong"); outer.append(inner); }
				inner.textContent = text;
				el.append(outer);
			});
			box.append(el);
		});
	};
	// The next piece, once the end of this one is near.
	var io = new IntersectionObserver(function (entries) {
		if (!entries[0].isIntersecting || loading || next == null) return;
		loading = true;
		more.textContent = "Loading…";
		previewPiece(b, next).then(function (d) {
			if (!sess.alive) return;
			loading = false;
			add(d);
			next = d.next;
			more.textContent = "";
			if (next == null) { io.disconnect(); more.remove(); previewEnd(b, "That's the end."); return; }
			// Still in view (a short piece): straight on to the next.
			io.unobserve(more);
			io.observe(more);
		}, function () {
			if (!sess.alive) return;
			loading = false;
			more.textContent = "";
			var again = h("button", "linkbtn", "Couldn't load the rest. Try again");
			again.type = "button";
			again.onclick = function () { io.unobserve(more); io.observe(more); };
			more.append(again);
		});
	}, { rootMargin: "0px 0px 150% 0px" });
	add(d);
	$("pvBody").append(box, more);
	$("pvNote").textContent = "";
	if (d.at) {
		// Picked up where they left off; the start is a tap away.
		var start = h("button", "linkbtn", "Start from the beginning");
		start.type = "button";
		start.onclick = function () {
			store("read:" + b.id, "0:0");
			closePreview();
			showPreview(b);
			window.scrollTo(0, 0);
		};
		$("pvNote").append("Picking up where you left off. ", start);
	}
	if (place && Number(place[1]) === d.at) goToPlace(box.querySelector('[data-place="' + place[0] + '"]'));
	keepPlace(sess, b, box);
	sess.cleanup.push(function () { io.disconnect(); });
	if (next == null) previewEnd(b, "That's the end.");
	else io.observe(more);
}
// The place in a comic or PDF: its page.
function pagePlace(b, pages) {
	var n = Number(read("read:" + b.id));
	return Number.isInteger(n) && n > 1 && n <= pages.length ? pages[n - 1] : null;
}
function previewComic(sess, b, d) {
	var box = h("div", "pvpages"), pages = [];
	for (var i = 0; i < d.pages; i++) {
		var img = h("img");
		img.alt = "Page " + (i + 1);
		img.loading = "lazy";
		img.decoding = "async";
		img.dataset.place = String(i + 1);
		img.src = "/api/family/books/" + b.id + "/preview/page/" + i;
		pages.push(img);
		box.append(img);
	}
	$("pvBody").append(box);
	$("pvNote").textContent = d.pages === 1 ? "1 page" : d.pages + " pages";
	previewEnd(b, "That's the end.");
	goToPlace(pagePlace(b, pages));
	keepPlace(sess, b, box);
}
function loadPdfJs() {
	if (!pdfjsLoading) {
		pdfjsLoading = import(PDFJS + "pdf.min.mjs").then(function (lib) {
			lib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs";
			return lib;
		}).catch(function (e) {
			pdfjsLoading = null;
			throw new Error("Couldn't load the PDF viewer (" + e.message + ").");
		});
	}
	return pdfjsLoading;
}
// pdf.js asks for pieces as it needs them (16 KB of a smaller PDF, 64 KB of
// a big one), so only what the pages read need is fetched. Pages are drawn
// as they come near the screen and let go of once well past it, so a long
// PDF doesn't fill a phone's memory.
async function previewPdf(sess, b, d) {
	var size = d.size, CHUNK = size < 8 * 1048576 ? 16384 : 65536, failed = null;
	var part = async function (at, len) {
		var res = await fetch("/api/family/books/" + b.id + "/preview/part?at=" + at + "&len=" + len);
		if (!res.ok) {
			var e = new Error((await res.json().catch(function () { return {}; })).error || "HTTP " + res.status);
			e.status = res.status;
			throw e;
		}
		return new Uint8Array(await res.arrayBuffer());
	};
	var stop = function (e) {
		if (failed || !sess.alive) return;
		failed = e;
		$("pvNote").textContent = "Couldn't load the rest of the book.";
		previewEnd(b, "");
	};
	var lib = await loadPdfJs(), head = await part(0, Math.min(CHUNK, size)).catch(function (e) { stop(e); return null; });
	if (!sess.alive || !head) return;
	var range = new lib.PDFDataRangeTransport(size, head);
	range.requestDataRange = function (begin, end) {
		// In pieces of up to 1 MB, each a whole number of chunks.
		for (var at = begin; at < end; at += 1048576) (function (at, len) {
			part(at, len).then(function (data) { if (sess.alive) range.onDataRange(at, data); }, stop);
		})(at, Math.min(1048576, end - at));
	};
	var task = lib.getDocument({
		range: range, length: size, rangeChunkSize: CHUNK, disableAutoFetch: true, disableStream: true,
		isEvalSupported: false, useWorkerFetch: false,
		cMapUrl: PDFJS_DATA + "cmaps/", cMapPacked: true, standardFontDataUrl: PDFJS_DATA + "standard_fonts/"
	});
	sess.cleanup.push(function () { task.destroy(); });
	var doc = await task.promise;
	if (!sess.alive) return;
	var n = doc.numPages;
	var first = (await doc.getPage(1)).getViewport({ scale: 1 });
	if (!sess.alive) return;
	var box = h("div", "pvpages"), pages = [];
	for (var i = 1; i <= n; i++) {
		var div = h("div", "pvpdf");
		div.dataset.n = div.dataset.place = String(i);
		div.style.aspectRatio = first.width + " / " + first.height;
		div.append(h("span", "pn", String(i)));
		pages.push(div);
		box.append(div);
	}
	$("pvBody").append(box);
	$("pvNote").textContent = n === 1 ? "1 page" : n + " pages";
	previewEnd(b, "That's the end.");
	goToPlace(pagePlace(b, pages));
	keepPlace(sess, b, box);
	var io = new IntersectionObserver(function (entries) {
		entries.forEach(function (e) { if (e.isIntersecting && !failed) drawPdfPage(sess, doc, e.target); });
	}, { rootMargin: "100% 0px" });
	var away = new IntersectionObserver(function (entries) {
		entries.forEach(function (e) { if (!e.isIntersecting) dropPdfPage(e.target); });
	}, { rootMargin: "400% 0px" });
	pages.forEach(function (p) { io.observe(p); away.observe(p); });
	sess.cleanup.push(function () {
		io.disconnect();
		away.disconnect();
		pages.forEach(dropPdfPage);
	});
}
function dropPdfPage(div) {
	var c = div.querySelector("canvas");
	if (c) { c.width = c.height = 0; c.remove(); }
	div.done = false;
}
async function drawPdfPage(sess, doc, div) {
	if (div.done) return;
	div.done = true;
	try {
		var page = await doc.getPage(Number(div.dataset.n));
		var vp1 = page.getViewport({ scale: 1 }), dpr = Math.min(window.devicePixelRatio || 1, 2);
		div.style.aspectRatio = vp1.width + " / " + vp1.height;
		var scale = Math.min((div.clientWidth * dpr) / vp1.width, Math.sqrt(16e6 / (vp1.width * vp1.height)));
		var vp = page.getViewport({ scale: scale }), canvas = document.createElement("canvas");
		canvas.width = Math.floor(vp.width);
		canvas.height = Math.floor(vp.height);
		await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
		if (!sess.alive || !div.done) { canvas.width = canvas.height = 0; return; }
		div.prepend(canvas);
		page.cleanup();
	} catch (e) {
		div.done = false;
	}
}
async function load() {
	var invite = /[#&]invite=([\w-]+)/.exec(location.hash), used = invite ? await signIn(invite[1]) : "";
	var res = await fetch("/api/family/me");
	if (res.status === 401) return landing(used);
	if (!res.ok) throw new Error("Couldn't reach the library.");
	me = await res.json();
	$("head").hidden = false;
	showSub();
	$("intro").hidden = false;
	if (invite || !read("familyWelcomed")) welcome(true);
	var data = await (await fetch("/api/family/books")).json();
	books = pairAudio((data.books || []).slice()).sort(function (a, b) {
		return fold(a.series || a.title).localeCompare(fold(b.series || b.title)) || (parseFloat(a.volume) || 0) - (parseFloat(b.volume) || 0) || fold(a.title).localeCompare(fold(b.title));
	});
	sameSeries(books);
	say("");
	if ($("welcome").hidden) $("lib").hidden = false;
	if (!books.length) $("tools").hidden = true;
	renderFormats();
	renderTags();
	renderRecs();
	render();
	if (!books.length) $("none").textContent = "No books here yet.";
}
$("q").addEventListener("input", function () { query = this.value; render(); });
$("tag").addEventListener("change", function () { tag = this.value; if (tag && pick) { pick = null; renderRecs(); } render(); });
// Back from a Record opened from the list goes back to it; opened from a link, to all books.
$("rBack").addEventListener("click", function (e) {
	if (!viaList) return;
	e.preventDefault();
	history.back();
});
// Back from a book opened from its Record goes back to the Record.
$("pvBack").addEventListener("click", function (e) {
	if (!viaRecord) return;
	e.preventDefault();
	history.back();
});
window.addEventListener("hashchange", function () {
	var back = onRecord && !openBook() && !openPreview();
	if (back) viaList = false;
	if (onPreview && !openPreview()) viaRecord = false;
	render();
	window.scrollTo(0, back ? listScroll : 0);
	if (onRecord) $("rTitle").focus({ preventScroll: true });
	if (onPreview) $("pvTitle").focus({ preventScroll: true });
});

// The first time on a device: how to keep the page. The invite link works
// only once, so the plain address is the one worth bookmarking.
var DEVICES = {
	ios: "<b>iPhone or iPad:</b> tap Share (the square with the arrow), then <b>Add to Home Screen</b>, or <b>Add Bookmark</b>.",
	android: "<b>Android:</b> in Chrome, tap the ⋮ menu, then <b>Add to Home screen</b>, or the ☆ to bookmark it.",
	mac: "<b>Mac:</b> press <b>⌘D</b> to bookmark this page.",
	pc: "<b>Windows or other computers:</b> press <b>Ctrl+D</b> to bookmark this page."
};
function device() {
	var ua = navigator.userAgent;
	if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
	if (/Android/.test(ua)) return "android";
	return /Macintosh/.test(ua) ? "mac" : "pc";
}
function welcome(on) {
	$("welcome").hidden = !on;
	$("lib").hidden = on;
	if (!on) { render(); return; }
	var mine = device();
	$("head").textContent = "Welcome to The Back Alley Library" + (me.name ? ", " + me.name + "." : ".");
	$("sub").hidden = true;
	$("wAddr").textContent = location.host + "/library";
	$("wHow").innerHTML = DEVICES[mine];
	var other = $("wOther");
	other.textContent = "";
	Object.keys(DEVICES).forEach(function (k) { if (k !== mine) { var p = h("p"); p.innerHTML = DEVICES[k]; other.append(p); } });
	$("wOwner").textContent = "This link is just for you. If you get a new phone or lose access, ask " + (me.owner ? me.owner + " " : "") + "for a new one.";
	window.scrollTo(0, 0);
}
$("wGo").addEventListener("click", function () { store("familyWelcomed", "1"); welcome(false); });
$("howLink").addEventListener("click", function (e) { e.preventDefault(); welcome(true); });

// Not signed in: the landing page, and a request for a library card.
function landing(msg) {
	say("");
	document.body.classList.add("landing");
	$("landing").hidden = false;
	var asked = read("cardRequested");
	if (asked && !msg) msg = "Your request is in. You'll get your own link once it's approved.";
	$("lMsg").textContent = msg;
	$("lMsg").hidden = !msg;
	$("lAsk").textContent = asked ? "Request again" : "Request your library card";
}
// Cloudflare Turnstile, when it's set up: loaded only once the form opens, so
// someone who just looks never gets it. Usually it passes without a click.
var SITE_KEY = "__TURNSTILE__", checkToken = "", checkId = null;
function startCheck() {
	if (!SITE_KEY || checkId != null) return;
	checkId = "loading";
	window.onTurnstileLoad = function () {
		checkId = window.turnstile.render("#lCheck", {
			sitekey: SITE_KEY, theme: "light", action: "library-card",
			callback: function (t) { checkToken = t; },
			"expired-callback": function () { checkToken = ""; },
			"error-callback": function () { checkToken = ""; }
		});
	};
	var sc = document.createElement("script");
	sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad";
	sc.async = true;
	sc.nonce = "__NONCE__";
	sc.onerror = function () { checkId = null; $("lCheck").textContent = "The check couldn't load. Turn off any blocker for this page, then reload."; };
	document.head.append(sc);
}
$("lAsk").addEventListener("click", function () {
	$("lAsk").hidden = true;
	$("lMsg").hidden = true;
	$("lForm").hidden = false;
	startCheck();
	$("lName").focus();
});
$("lForm").addEventListener("submit", async function (e) {
	e.preventDefault();
	var name = $("lName").value.trim();
	if (!name) { $("lName").focus(); return; }
	if (SITE_KEY && !checkToken) {
		$("lMsg").className = "msg bad";
		$("lMsg").textContent = "One moment: the check below isn't done yet.";
		$("lMsg").hidden = false;
		return;
	}
	$("lSend").disabled = true;
	try {
		var res = await fetch("/api/family/request", { method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: name, email: $("lEmail").value.trim(), note: $("lNote").value.trim(), website: $("lSite").value, check: checkToken }) });
		var d = await res.json().catch(function () { return {}; });
		if (!res.ok) {
			// A token works once; a fresh one for the next try.
			checkToken = "";
			if (window.turnstile && checkId != null && checkId !== "loading") window.turnstile.reset(checkId);
			throw new Error(d.error || "That didn't go through. Please try again.");
		}
		store("cardRequested", "1");
		$("lForm").hidden = true;
		$("lMsg").className = "msg";
		$("lMsg").textContent = "Thanks, " + name + ". Your request is in. You'll get your own link once it's approved.";
		$("lMsg").hidden = false;
	} catch (err) {
		$("lMsg").className = "msg bad";
		$("lMsg").textContent = err.message;
		$("lMsg").hidden = false;
	}
	$("lSend").disabled = false;
});
load().catch(function (e) { say(e.message); });
</script>
</body>
</html>
`;

// Keeps a copy of the page so it opens with no connection (for downloaded
// episodes and books). Network first, so a deploy shows up on the next load.
// The PDF viewer (pdf.js and its fonts) is a pinned version that never
// changes, so it's kept once fetched and served from here after that; that's
// what lets a downloaded PDF open offline. The API and everything else go
// straight to the network.
function serviceWorker() {
	return new Response(SW, {
		headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" },
	});
}
const SW = `var SHELL = "reader-shell-v1", LIBS = "reader-libs-v1";
var PINNED = ${JSON.stringify([PDFJS_URL, PDFJS_DATA_URL])};
self.addEventListener("install", function (e) {
	e.waitUntil(caches.open(SHELL).then(function (c) { return c.add("/"); }).catch(function () {}).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
	var req = e.request, url = new URL(req.url);
	if (req.method === "GET" && (PINNED.some(function (p) { return req.url.indexOf(p) === 0; }) || (url.origin === location.origin && url.pathname.indexOf("/fonts/") === 0))) {
		e.respondWith(caches.open(LIBS).then(function (c) {
			return c.match(req.url).then(function (hit) {
				return hit || fetch(req).then(function (res) {
					if (res.ok && res.type !== "opaque") c.put(req.url, res.clone());
					return res;
				});
			});
		}));
		return;
	}
	if (req.method !== "GET" || url.origin !== location.origin || url.pathname !== "/") return;
	e.respondWith(fetch(req).then(function (res) {
		if (res.ok) { var copy = res.clone(); caches.open(SHELL).then(function (c) { return c.put("/", copy); }); }
		return res;
	}).catch(function () {
		return caches.match("/").then(function (res) { return res || Response.error(); });
	}));
});
`;

// The app. One page, hash routes (#/unread, #/item/12, #/book/3 ...) so the
// iPhone's back swipe works. All feed/page HTML is untrusted: it's parsed
// with DOMParser (an inert document -- nothing loads or runs there) and then
// rebuilt element by element from an allow-list before it touches the page.
// String.raw so the regexes and "…" escapes in the script reach the
// browser untouched -- which also means no backticks or dollar-brace in it.
const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta id="vp" name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Reader">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fbfaf7">
<link rel="icon" type="image/svg+xml" href="__ICON__">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preload" href="/fonts/fraunces-soft.woff2" as="font" type="font/woff2" crossorigin>
<title>Reader</title>
<style nonce="__NONCE__">
	@font-face { font-family: "Fraunces"; src: url(/fonts/fraunces-soft.woff2) format("woff2"); font-weight: 300 700; font-style: normal; font-display: swap; }
	@font-face { font-family: "Fraunces"; src: url(/fonts/fraunces-soft-italic.woff2) format("woff2"); font-weight: 300 700; font-style: italic; font-display: swap; }
	:root {
		--bg: #fbfaf7; --fg: #1d1c1a; --muted: #6d6a64; --line: #e4e1da; --card: #ffffff; --sel: #ecefe9;
		--accent: #2f5fd0; --on-accent: #fff; --dot: #2f5fd0; --bad: #b3261e; --pdf-page: #ffffff; --hl: #fbe38a; --hl-edge: #e0b400;
		--ok: #17663a; --ok-bg: #dcf0e2;
		--serif: ui-serif, "New York", "Iowan Old Style", Charter, Georgia, serif;
		/* Headings and book titles. Small text (buttons, menus, tags) stays --sans. */
		--display: "Fraunces", var(--serif);
		/* What articles and books are set in: --serif, or --display when chosen in settings. */
		--read: var(--serif);
		--sans: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
		--reader-size: 19px;
		color-scheme: light;
	}
	@media (prefers-color-scheme: dark) {
		:root:not([data-theme]) {
			--bg: #141414; --fg: #e7e4de; --muted: #9b978f; --line: #2d2c2a; --card: #1c1c1b; --sel: #2a2a28;
			--accent: #8fb0ff; --on-accent: #10131a; --dot: #8fb0ff; --bad: #ff8a80; --pdf-page: #1f1f1f; --hl: #5c4a12; --hl-edge: #b8930f;
			--ok: #8fdcaa; --ok-bg: #1d3526;
			color-scheme: dark;
		}
	}
	:root[data-theme=dark] {
		--bg: #141414; --fg: #e7e4de; --muted: #9b978f; --line: #2d2c2a; --card: #1c1c1b; --sel: #2a2a28;
		--accent: #8fb0ff; --on-accent: #10131a; --dot: #8fb0ff; --bad: #ff8a80; --pdf-page: #1f1f1f; --hl: #5c4a12; --hl-edge: #b8930f;
		--ok: #8fdcaa; --ok-bg: #1d3526;
		color-scheme: dark;
	}
	:root[data-theme=sepia] {
		--bg: #f4ecd8; --fg: #3b3024; --muted: #7b6c58; --line: #e2d6bb; --card: #f9f2e2; --sel: #eadfc4;
		--accent: #8a4b14; --on-accent: #fff; --dot: #a0551a; --bad: #a3261e; --pdf-page: #f4ecd8; --hl: #f0d27a; --hl-edge: #c49a1c;
		--ok: #3f5a12; --ok-bg: #dfe3bd;
		color-scheme: light;
	}
	/* Dark themes from wr1t3r (its src/style.css), mapped onto the reader's colors. */
	:root[data-theme=dracula] {
		--bg: #282a36; --fg: #f8f8f2; --muted: #a3abcc; --line: #44475a; --card: #2f3241; --sel: #44475a;
		--accent: #bd93f9; --on-accent: #282a36; --dot: #bd93f9; --bad: #ff5555; --pdf-page: #2f3241; --hl: #5d5f2a; --hl-edge: #f1fa8c;
		--ok: #50fa7b; --ok-bg: #44475a;
		color-scheme: dark;
	}
	:root[data-theme=kanagawa] {
		--bg: #1f1f28; --fg: #dcd7ba; --muted: #c8c093; --line: #363646; --card: #2a2a37; --sel: #223249;
		--accent: #7e9cd8; --on-accent: #1f1f28; --dot: #7e9cd8; --bad: #e46876; --pdf-page: #2a2a37; --hl: #49443c; --hl-edge: #e6c384;
		--ok: #98bb6c; --ok-bg: #363646;
		color-scheme: dark;
	}
	:root[data-theme=tokyonight] {
		--bg: #1a1b26; --fg: #c0caf5; --muted: #a9b1d6; --line: #292e42; --card: #1f2335; --sel: #283457;
		--accent: #7aa2f7; --on-accent: #1a1b26; --dot: #7aa2f7; --bad: #f7768e; --pdf-page: #1f2335; --hl: #3d59a1; --hl-edge: #e0af68;
		--ok: #9ece6a; --ok-bg: #292e42;
		color-scheme: dark;
	}
	:root[data-theme=gruvbox] {
		--bg: #282828; --fg: #ebdbb2; --muted: #a89984; --line: #3c3836; --card: #32302f; --sel: #504945;
		--accent: #fe8019; --on-accent: #282828; --dot: #fe8019; --bad: #fb4934; --pdf-page: #32302f; --hl: #5c4a1c; --hl-edge: #fabd2f;
		--ok: #b8bb26; --ok-bg: #3c3836;
		color-scheme: dark;
	}
	:root[data-theme=monokai] {
		--bg: #272822; --fg: #f8f8f2; --muted: #a59f85; --line: #3e3d32; --card: #2f302a; --sel: #49483e;
		--accent: #a6e22e; --on-accent: #272822; --dot: #a6e22e; --bad: #f92672; --pdf-page: #2f302a; --hl: #5b5a2e; --hl-edge: #e6db74;
		--ok: #a6e22e; --ok-bg: #3e3d32;
		color-scheme: dark;
	}
	* { box-sizing: border-box; }
	/* The page never scrolls sideways or zooms (a PDF or comic can pinch-zoom,
	   html.zoomable). clip, unlike hidden, leaves the sticky header working. */
	html { -webkit-text-size-adjust: 100%; overflow-x: hidden; overflow-x: clip; touch-action: pan-x pan-y; }
	html.zoomable { touch-action: auto; }
	body { overflow-x: clip; margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 var(--sans); }
	/* --lost: how far the page runs past the bottom of the screen, which iOS 26
	   does in home-screen apps (fitScreen() measures it; 0 everywhere else).
	   The end of every page and each bar pinned to the bottom move up by it. */
	body { padding-bottom: var(--lost, 0px); }
	a { color: var(--accent); }
	button, input, select { font: inherit; color: inherit; }
	[hidden] { display: none !important; }
	.vh { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.muted { color: var(--muted); }
	.err { color: var(--bad); }

	.btn { appearance: none; -webkit-appearance: none; border: 1px solid var(--line); background: var(--card); color: var(--fg);
		border-radius: 10px; padding: 8px 12px; min-height: 40px; font-size: 15px; line-height: 1.2; cursor: pointer;
		text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; }
	.btn:disabled { opacity: .55; cursor: default; }
	.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 600; }
	.btn.ghost { background: none; border-color: transparent; color: var(--accent); padding-inline: 6px; }
	.btn.small { min-height: 32px; padding: 4px 10px; font-size: 14px; border-radius: 8px; }
	.btn.wide { width: 100%; margin-top: 16px; }
	select { border: 1px solid var(--line); background: var(--card); border-radius: 10px; min-height: 40px; padding: 6px 8px; font-size: 15px; max-width: 100%; }
	select.small { min-height: 32px; font-size: 14px; border-radius: 8px; padding: 2px 6px; }
	input[type=text], input[type=password], input[type=search] { width: 100%; border: 1px solid var(--line); background: var(--card);
		border-radius: 10px; padding: 9px 12px; font-size: 16px; min-height: 42px; }

	.token { max-width: 420px; margin: 0 auto; padding: 48px 16px; }
	.token h1 { font-size: 24px; margin: 0 0 20px; }
	.token label { display: block; font-weight: 600; margin-bottom: 6px; }
	.token .btn { width: 100%; margin-top: 16px; }
	.hint { color: var(--muted); font-size: 14px; margin-top: 6px; }

	.top { position: sticky; top: 0; z-index: 10; background: var(--bg); border-bottom: 1px solid var(--line); }
	.bar { display: flex; align-items: center; gap: 8px; padding: 6px 16px; padding-top: max(6px, env(safe-area-inset-top));
		min-height: 52px; max-width: 1100px; margin: 0 auto; }
	.logo { width: 40px; height: 40px; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.2); flex: none; display: block; }
	.wordmark { display: block; flex: none; color: var(--fg); line-height: 0; }
	/* The logo and wordmark: a link to "/", which loads the app afresh (a hash-only change wouldn't). */
	.home { display: flex; align-items: center; gap: 8px; flex: none; text-decoration: none; border-radius: 10px; }
	.home:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	.wordmark svg { height: 28px; width: auto; display: block; }
	.token h1 .wordmark { display: inline-block; vertical-align: middle; }
	.token h1 .wordmark svg { height: 40px; }
	.token h1 .logo { display: inline-block; width: 56px; height: 56px; border-radius: 13px; vertical-align: middle; margin-right: 12px; }
	.bar h1 { flex: 1; min-width: 0; margin: 0; font-size: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.bar h1, .listhead h2, .article .title, .coverage h3, .books .bt, .covers .ct {
		font-family: var(--display); font-weight: 600; font-optical-sizing: auto; }
	.listhead h2, .article .title { letter-spacing: -.01em; }
	.bar .progress { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
	.bar .progress .pg::before { content: " · "; }
	/* A phone's bar is short of room: the page goes under the percentage. */
	@media (max-width: 600px) {
		.bar .progress { display: flex; flex-direction: column; align-items: flex-end; font-size: 12px; line-height: 1.25; }
		.bar .progress .pg::before { content: none; }
	}
	.tabs { display: flex; gap: 4px; padding: 0 16px 8px; max-width: 1100px; margin: 0 auto; }
	.tabs a { flex: 1; text-align: center; padding: 7px 0; border-radius: 9px; color: var(--muted); text-decoration: none; font-weight: 600; font-size: 15px; }
	.tabs a[aria-current=page] { background: var(--sel); color: var(--fg); }
	/* Saved, Podcasts, Videos, Library: icons, so the text tabs get the room. */
	.tabs a.icon { flex: 0 0 52px; display: flex; align-items: center; justify-content: center; }
	.tabs a.icon svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

	.pop { position: fixed; z-index: 20; right: 16px; top: calc(env(safe-area-inset-top) + 56px); width: min(320px, calc(100vw - 32px));
		background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; box-shadow: 0 10px 30px rgba(0,0,0,.18); }
	.pop h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 8px; }
	.pop h2 + * { margin-bottom: 14px; }
	.seg { display: flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
	.seg button { flex: 1; border: 0; background: none; padding: 9px 4px; font-size: 14px; cursor: pointer; min-width: 0; }
	.seg button + button { border-left: 1px solid var(--line); }
	.seg button[aria-pressed=true] { background: var(--sel); font-weight: 600; }
	/* The theme picker: three across, the gaps drawn as lines. */
	.seg.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); }
	.seg.grid button { background: var(--card); white-space: nowrap; }
	.seg.grid button + button { border-left: 0; }
	.seg.grid button[aria-pressed=true] { background: var(--sel); }
	.menu { display: grid; gap: 8px; }
	.txt mark.hl { background: var(--hl); color: inherit; border-radius: 2px; cursor: pointer; }
	.txt mark.hl.noted { text-decoration: underline dotted; text-decoration-thickness: 2px; text-underline-offset: 3px; }
	.hlbar { position: fixed; z-index: 16; left: 50%; transform: translateX(-50%); bottom: calc(16px + env(safe-area-inset-bottom) + var(--lost, 0px)); display: flex; gap: 8px;
		background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.18); font-family: var(--sans); }
	body.has-pbar .hlbar { bottom: calc(106px + env(safe-area-inset-bottom) + var(--lost, 0px)); }
	.hlpop { font-family: var(--sans); width: min(400px, calc(100vw - 32px)); max-height: calc(100vh - 90px - env(safe-area-inset-top)); overflow: auto; }
	.hlquote { margin: 0 0 10px; padding: 2px 0 2px 10px; border-left: 3px solid var(--hl-edge); font: 15px/1.45 var(--serif); white-space: pre-line; overflow-wrap: anywhere; }
	.hlpop textarea { width: 100%; box-sizing: border-box; font: 15px/1.4 var(--sans); padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); resize: vertical; }
	.hlrow { display: flex; gap: 8px; margin-top: 10px; }
	.details label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 10px; }
	.details label input { margin-top: 4px; color: var(--fg); font-size: 16px; }
	.details .drow { display: grid; grid-template-columns: 1fr 84px; gap: 10px; }
	.details .dcover { display: flex; gap: 14px; align-items: center; margin-bottom: 12px; }
	.details .dcover .cover { width: 84px; flex: none; margin: 0; }
	.details .gencover { gap: 6px; padding: 12% 8%; }
	.details .gencover .gt { font-size: 11px; }
	.details .gencover .ga, .details .gencover .gk { display: none; }
	.details .dlook { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; }
	/* Here, not a style attribute: the page's CSP blocks those. */
	#dPages { width: 90px; }
	.details .drec { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 10px; }
	.details .drec h3 { font-size: 13px; margin: 0 0 8px; }
	.details label textarea { margin-top: 4px; }
	.lookhits { list-style: none; margin: 0 0 10px; padding: 0; border-top: 1px solid var(--line); }
	.lookhits button { display: flex; gap: 10px; align-items: center; width: 100%; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--line); padding: 8px 2px; color: inherit; font: inherit; cursor: pointer; }
	.lookhits button:hover, .lookhits button[aria-pressed=true] { background: var(--sel); }
	.lookhits img, .lookhits .noimg { width: 32px; height: 48px; object-fit: cover; border-radius: 3px; flex: none; background: var(--sel); }
	.lookhits .lt { font-weight: 600; font-size: 14px; display: block; }
	.lookhits .lm { font-size: 13px; color: var(--muted); display: block; }
	.lookcovers { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
	.lookcovers button { padding: 0; border: 2px solid transparent; border-radius: 5px; background: none; cursor: pointer; line-height: 0; }
	.lookcovers button[aria-pressed=true] { border-color: var(--accent); }
	.lookcovers img { width: 56px; height: 84px; object-fit: cover; border-radius: 3px; }
	.hlrow span { flex: 1; }
	.hlitems { list-style: none; margin: 0; padding: 0; }
	.hlitems li + li { border-top: 1px solid var(--line); }
	.hlgo { display: grid; gap: 4px; width: 100%; text-align: left; background: none; border: 0; padding: 10px 0; color: inherit; cursor: pointer; font: inherit; }
	.hlq { font: 15px/1.4 var(--serif); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; line-clamp: 4; overflow: hidden; border-left: 3px solid var(--hl-edge); padding-left: 8px; }
	.hln { font-size: 14px; }
	.hlm { font-size: 13px; color: var(--bad); }
	.findform { margin-bottom: 4px; }
	.findq { font: 15px/1.4 var(--serif); overflow-wrap: anywhere; }
	.findq mark { background: var(--hl); color: inherit; border-radius: 2px; }
	.findwhere { font-size: 13px; color: var(--muted); }
	::highlight(find) { background-color: var(--hl-edge); color: var(--bg); }
	.seg .fraunces { font-family: var(--display); }
	.seg .val { flex: 0 0 56px; display: grid; place-items: center; font-variant-numeric: tabular-nums; border-left: 1px solid var(--line); border-right: 1px solid var(--line); font-size: 14px; }

	.wrap { max-width: 1100px; margin: 0 auto; padding: 0 16px 64px; }
	.listview { display: block; }
	@media (min-width: 900px) {
		.listview { display: grid; grid-template-columns: 324px minmax(0, 1fr); gap: 36px; align-items: start; }
		/* The gutter keeps a classic scrollbar off the content; the right
		   padding does the same for overlay scrollbars, which reserve nothing.
		   The small left padding (pulled back by the margin) keeps a selected
		   tag's focus ring from being clipped. */
		.side { position: sticky; top: 112px; max-height: calc(100vh - 124px); overflow-y: auto;
			scrollbar-gutter: stable; padding: 0 12px 0 6px; margin-left: -6px; }
	}
	.side details { border-bottom: 1px solid var(--line); padding: 4px 0 12px; }
	.side summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; font-weight: 600; padding: 10px 0 6px; }
	.side summary::-webkit-details-marker { display: none; }
	.side summary::before { content: ""; width: 7px; height: 7px; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted);
		transform: rotate(-45deg); margin: 0 4px 0 2px; transition: transform .15s; }
	.side details[open] summary::before { transform: rotate(45deg); margin-top: -4px; }
	.add { margin: 6px 0 4px; }
	.addrow { display: flex; gap: 8px; margin-top: 8px; }
	.addrow select { flex: 1; min-width: 0; }
	.status { font-size: 14px; margin: 6px 0; padding: 8px 10px; border-radius: 8px; background: var(--sel); overflow-wrap: anywhere; }
	.status.err { color: var(--bad); }

	.tree { list-style: none; margin: 8px 0 0; padding: 0; }
	.tree li { display: block; }
	.row { display: flex; align-items: center; gap: 4px; min-height: 40px; }
	.row > a { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; color: inherit; text-decoration: none; padding: 7px 8px; border-radius: 8px; }
	.row > a[aria-current=true] { background: var(--sel); }
	.row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.row .n { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
	.row .tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 5px; padding: 0 4px; }
	.child > .row > a { padding-left: 40px; }
	.flat .child > .row > a { padding-left: 8px; }
	.tools { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 0 8px 40px; }
	.flat .tools { padding-left: 8px; }
	.ferr { font-size: 13px; color: var(--bad); padding: 0 8px 6px 40px; overflow-wrap: anywhere; }
	/* Edit sits up on the Feeds row, so a long list can't push it off the
	   bottom of a phone screen. It's a sibling of the summary (a button inside
	   one would also toggle the list), laid over the summary's right end. */
	.side details { position: relative; }
	.editbar { position: absolute; top: 9px; right: 0; display: flex; gap: 8px; }
	.tagbar { padding: 6px 0 8px; }
	.chips { display: flex; flex-wrap: wrap; gap: 6px; }
	.chip { appearance: none; -webkit-appearance: none; display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 4px 11px;
		border: 1px solid var(--line); border-radius: 999px; background: var(--card); color: var(--fg); text-decoration: none; font: inherit; font-size: 14px; cursor: pointer; }
	.chip .n { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
	/* Tag colors: the pastel rotation brandonj.ink uses for its tag and nav
	   pills (its Catppuccin-named accents at S 92% L 72%), with black text,
	   which clears 7:1 on every one. A tag keeps its color by id, stepping
	   3 through the 8 so tags made one after another get far-apart hues. */
	.c0 { --tc: #f976e4; } .c1 { --tc: #f9769b; } .c2 { --tc: #f99176; } .c3 { --tc: #f9c076; }
	.c4 { --tc: #76f9af; } .c5 { --tc: #76e9f9; } .c6 { --tc: #76d4f9; } .c7 { --tc: #7692f9; }
	.tagbar .chip, .chip[aria-pressed=true] { background: var(--tc, var(--sel)); border-color: var(--tc, var(--line)); color: #000; }
	.tagbar .chip .n { color: inherit; opacity: .7; }
	.tagbar.filtering .chip:not([aria-current=true]) { background: var(--card); color: var(--fg); }
	.tagbar.filtering .chip:not([aria-current=true])::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--tc); }
	.tagbar.filtering .chip.clear::before { content: none; }
	.chip[aria-current=true] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--fg); font-weight: 600; }
	.chip.untagged { --tc: var(--sel); color: var(--fg); }
	.chip[aria-pressed=false]::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--tc); }
	.chip.add { border-style: dashed; color: var(--muted); }
	.row .dots { display: inline-flex; gap: 3px; }
	.row .dots i { width: 8px; height: 8px; border-radius: 50%; background: var(--tc); }
	.tagbar .tools { padding: 8px 0 0; }
	.tagbar .hint { margin-top: 8px; }
	.feedtags { padding: 2px 0 8px 8px; }

	.listhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 16px 0 4px; }
	.listhead h2 { font-size: 22px; margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.items { list-style: none; margin: 0; padding: 0; }
	.items a { display: grid; grid-template-columns: 14px minmax(0, 1fr); column-gap: 8px; padding: 13px 0; border-bottom: 1px solid var(--line); color: inherit; text-decoration: none; }
	.items .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dot); margin-top: 8px; }
	.items .read .dot { visibility: hidden; }
	.items .t { font-weight: 600; font-size: 17px; line-height: 1.3; overflow-wrap: anywhere; }
	.items .read .t { font-weight: 400; color: var(--muted); }
	.items .m { grid-column: 2; font-size: 13px; color: var(--muted); margin-top: 3px; overflow-wrap: anywhere; }
	.items .story > a { border-bottom: 0; padding-bottom: 8px; }
	.items .rel { list-style: none; margin: 0; padding: 0 0 12px 22px; border-bottom: 1px solid var(--line); }
	.items .rel a { display: block; padding: 5px 0 5px 10px; border: 0; border-left: 2px solid var(--line); font-size: 15px; line-height: 1.3; overflow-wrap: anywhere; }
	.items .rel .read a { color: var(--muted); }
	#items > li { position: relative; }
	#items > li > a { padding-right: 44px; }
	.items .mark { position: absolute; top: 6px; right: -6px; width: 44px; height: 44px; border: 0; background: none; border-radius: 50%; color: var(--muted); display: flex; align-items: center; justify-content: center; cursor: pointer; }
	.items .mark svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
	.items .read > .mark { color: var(--accent); }
	.empty { color: var(--muted); padding: 24px 0; text-align: center; }

	.article { max-width: 68ch; margin: 0 auto; padding: 20px 16px 96px; font-family: var(--read); font-size: var(--reader-size); line-height: 1.65; }
	.article .title { font-size: 1.55em; line-height: 1.2; margin: 0 0 .35em; overflow-wrap: anywhere; }
	.article .meta { font: 14px/1.4 var(--sans); color: var(--muted); overflow-wrap: anywhere; }
	.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 22px; font-family: var(--sans); }
	.itemnav { display: flex; gap: 8px; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--line); font-family: var(--sans); }
	.itemnav .btn { flex: 1; }
	.itemnav .btn:disabled { visibility: hidden; }
	/* Desktop: the arrows float at the screen's sides, level with the middle
	   of the window, so the next item is one click away wherever you are. */
	@media (min-width: 1000px) and (hover: hover) and (pointer: fine) {
		.itemnav { border-top: 0; margin: 0; padding: 0; }
		.itemnav .btn { position: fixed; top: 50%; transform: translateY(-50%); z-index: 5; width: 52px; height: 52px; padding: 0;
			border-radius: 50%; font-size: 22px; box-shadow: 0 4px 14px rgba(0,0,0,.12); opacity: .75; transition: opacity .15s; }
		.itemnav .btn:hover, .itemnav .btn:focus-visible { opacity: 1; }
		#aPrev { left: max(16px, calc(50vw - 480px)); }
		#aNext { right: max(16px, calc(50vw - 480px)); }
		.itemnav .lbl { display: none; }
	}
	.prose { overflow-wrap: break-word; }
	.prose a { overflow-wrap: anywhere; }
	.prose a:not([href]) { color: inherit; }
	.prose img { max-width: 100%; height: auto; border-radius: 4px; }
	.prose figure { margin: 1.2em 0; }
	.prose figcaption { font-size: .8em; color: var(--muted); margin-top: .4em; }
	.prose blockquote { margin: 1.2em 0; padding-left: 1em; border-left: 3px solid var(--line); color: var(--muted); }
	.prose pre { overflow-x: auto; font-size: .78em; line-height: 1.5; background: var(--card); border: 1px solid var(--line); padding: 12px; border-radius: 8px; }
	.prose code { font-family: ui-monospace, Menlo, monospace; font-size: .88em; }
	.prose table { display: block; overflow-x: auto; border-collapse: collapse; font-size: .85em; }
	.prose td, .prose th { border: 1px solid var(--line); padding: 4px 8px; }
	.prose h1, .prose h2, .prose h3, .prose h4 { line-height: 1.25; margin: 1.4em 0 .5em; }
	.prose hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
	.prose .embed { font: 14px var(--sans); }
	.prose video, .prose audio { display: block; width: 100%; margin: 1.2em 0; }
	.prose video { max-height: 80vh; background: #000; border-radius: 6px; }
	.prose .player { margin: 1.2em 0; }
	.prose .player iframe { display: block; width: 100%; border: 0; border-radius: 8px; background: var(--card); }
	.prose .player.video iframe { aspect-ratio: 16 / 9; height: auto; }
	.prose .player.audio iframe { height: 352px; }
	.prose .player.short iframe { height: 166px; }
	.prose .player.chart iframe { height: 420px; background: #fff; }
	.prose svg.chart { display: block; max-width: 100%; height: auto; margin: 1.2em 0; background: #fff; color: #222; border-radius: 6px; }
	.prose svg.chart text { fill: currentColor; }
	.prose svg.chart path:not([fill]), .prose svg.chart polyline:not([fill]), .prose svg.chart line { fill: none; stroke: currentColor; }
	:root[data-theme=dark] .prose svg.chart, :root[data-theme=dracula] .prose svg.chart, :root[data-theme=kanagawa] .prose svg.chart, :root[data-theme=tokyonight] .prose svg.chart, :root[data-theme=gruvbox] .prose svg.chart, :root[data-theme=monokai] .prose svg.chart,
	:root[data-theme=dark] .prose .player.chart iframe, :root[data-theme=dracula] .prose .player.chart iframe, :root[data-theme=kanagawa] .prose .player.chart iframe, :root[data-theme=tokyonight] .prose .player.chart iframe, :root[data-theme=gruvbox] .prose .player.chart iframe, :root[data-theme=monokai] .prose .player.chart iframe { filter: invert(.88) hue-rotate(180deg); }
	@media (prefers-color-scheme: dark) { :root:not([data-theme]) .prose svg.chart, :root:not([data-theme]) .prose .player.chart iframe { filter: invert(.88) hue-rotate(180deg); } }
	.prose .bsky .bsky-media { margin-top: .6em; display: grid; gap: 8px; }
	.prose .bsky .bsky-media img { display: block; }
	.prose .bsky .by { font: 14px var(--sans); }
	.prose .bsky-video { display: grid; gap: 6px; font: 14px var(--sans); }
	.prose .bsky-card { display: grid; gap: 2px; border: 1px solid var(--line); border-radius: 8px; padding: 10px; color: inherit; text-decoration: none; font: 14px/1.4 var(--sans); }
	.prose .bsky-card img { margin-bottom: 6px; }
	.prose .bsky-card span { color: var(--muted); }

	.uploadrow { display: flex; gap: 8px; margin-top: 8px; }
	.uploadrow select { flex: 1; min-width: 0; }
	.libfind { display: flex; gap: 8px; margin: 10px 0 2px; }
	.libfind input { flex: 1; min-width: 0; }
	.libfind select { flex: none; }
	@media (max-width: 520px) { .libfind { flex-wrap: wrap; } .libfind input { flex-basis: 100%; } .libfind select { flex: 1; min-width: 0; } }
	/* The format icons on a book with an audiobook: an open book for an ebook, headphones for the audiobook. */
	.fmt { display: inline-flex; gap: 4px; vertical-align: -2px; color: var(--muted); }
	.fmt svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
	.covers .fmt { margin-top: 1px; }
	/* A book's Record: its cover, its formats with Read and Listen, then the jacket copy and appeal terms. */
	.rec { display: grid; grid-template-columns: minmax(0, 220px) minmax(0, 1fr); gap: 28px; align-items: start; margin-top: 18px; }
	.rcov .cover { margin: 0; }
	.reye, .rsec h3 { margin: 0; font: 600 12px/1.4 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
	.rtitle { margin: 4px 0 2px; font: 600 30px/1.15 var(--display); overflow-wrap: anywhere; }
	.rby { margin: 0; font: italic 19px/1.3 var(--display); }
	.rby:empty, .rseries:empty { display: none; }
	.rseries { margin: 4px 0 0; }
	.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 18px; margin: 16px 0 0; }
	.facts dt { font: 600 11px/1.9 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
	.facts dd { margin: 0; overflow-wrap: anywhere; }
	.racts { display: flex; flex-direction: column; gap: 10px; margin-top: 20px; max-width: 420px; }
	.racts > .btn { width: 100%; text-align: center; text-decoration: none; }
	.rtools { display: flex; flex-wrap: wrap; gap: 8px; }
	.rsec { border-top: 1px solid var(--line); margin-top: 28px; padding-top: 18px; }
	.blurb { font: 18px/1.6 var(--read); max-width: 40em; }
	.blurb p { margin: 12px 0 0; }
	.appeal { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px 20px; margin: 12px 0 0; padding: 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
	.appeal dt { font-weight: 600; font-family: var(--display); padding-top: 4px; }
	.appeal dd { margin: 0; display: flex; flex-wrap: wrap; gap: 6px; }
	.appeal .term { padding: 3px 11px; border: 1px solid var(--line); border-radius: 999px; font-size: 14px; }
	.chapters { list-style: none; margin: 10px 0 0; padding: 0; max-height: 360px; overflow-y: auto; border: 1px solid var(--line); border-radius: 10px; }
	.chapters li + li { border-top: 1px solid var(--line); }
	.chapters button { display: flex; justify-content: space-between; gap: 12px; width: 100%; padding: 9px 14px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
	.chapters button[aria-current] { background: var(--sel); font-weight: 600; }
	.chapters .chtime { color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
	/* The player page: an audiobook's square cover, the chapter playing and a slider across it, the controls, then every chapter. */
	.lplay { display: grid; grid-template-columns: minmax(0, 320px) minmax(0, 1fr); gap: 36px; align-items: center; margin-top: 18px; }
	.lpcov .cover { aspect-ratio: 1; margin: 0; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.18); }
	.lpcov .gencover .gt { font-size: 22px; }
	.lpcov .gencover .ga { font-size: 15px; }
	.lpmain { min-width: 0; font-family: var(--sans); }
	.lpchap { display: inline-block; max-width: 100%; margin: 16px 0 0; padding: 4px 0; border: 0; background: none; font: inherit; font-weight: 600; color: var(--accent); text-align: inherit; overflow-wrap: anywhere; cursor: pointer; }
	.lpchap::after { content: " \25BE"; font-size: .8em; }
	.lpchap[hidden] { display: none; }
	/* The chapter picker, from the chapter's name or the Chapters button. */
	.chapdlg { width: min(480px, calc(100vw - 32px)); max-height: min(560px, calc(100vh - 80px)); padding: 14px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); color: var(--fg); font-family: var(--sans); box-shadow: 0 10px 30px rgba(0,0,0,.25); }
	.chapdlg[open] { display: flex; flex-direction: column; }
	.chapdlg::backdrop { background: rgba(0,0,0,.4); }
	.chapdlghd { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
	.chapdlghd h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0; }
	.chapdlghd .btn { min-width: 40px; min-height: 40px; font-size: 20px; }
	#lpChapPick { flex: 1 1 auto; min-height: 0; max-height: none; background: var(--bg); }
	#lpSeek { display: block; width: 100%; margin: 14px 0 2px; accent-color: var(--accent); }
	.lptimes { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
	.lpctl { display: flex; align-items: center; justify-content: space-between; gap: 4px; max-width: 360px; margin: 14px 0 0; }
	.lpctl .btn { min-width: 48px; min-height: 48px; padding-inline: 6px; font-variant-numeric: tabular-nums; }
	.lpctl svg { width: 22px; height: 22px; fill: currentColor; display: block; margin: auto; }
	#lpPlay { flex: none; width: 68px; height: 68px; min-width: 0; padding: 0; border-radius: 50%; font-size: 22px; }
	.lpmore { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-top: 14px; font-size: 14px; color: var(--muted); }
	.lpmore #lpRate, .sleepbtn { font-variant-numeric: tabular-nums; }
	.sleepbtn.on, .voicebtn.on { border-color: var(--accent); color: var(--accent); }
	.lpsleep { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
	#lpChapters { max-height: 420px; }
	@media (max-width: 640px) {
		.lplay { grid-template-columns: minmax(0, 1fr); gap: 20px; margin-top: 8px; }
		.lpcov { width: 80%; max-width: 340px; margin: 0 auto; }
		.lpmain { text-align: center; }
		.lpctl { margin-inline: auto; }
		.lpmore, .lpsleep { justify-content: center; }
	}
	@media (max-width: 640px) {
		.rec { grid-template-columns: minmax(0, 1fr); gap: 18px; }
		.rcov { width: 52%; max-width: 200px; margin: 0 auto; }
		.racts { max-width: none; }
		.appeal { grid-template-columns: minmax(0, 1fr); gap: 4px; }
		.appeal dd + dt { margin-top: 8px; }
	}
	.libfind .btn { flex: none; min-height: 40px; }
	/* Covers view: a grid of covers, a drawn one where a book has none. */
	.covers { list-style: none; margin: 14px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 20px 14px; }
	.covers a { display: flex; flex-direction: column; gap: 3px; color: inherit; text-decoration: none; min-width: 0; }
	.cover { position: relative; aspect-ratio: 2 / 3; border-radius: 5px; overflow: hidden; background: var(--sel); box-shadow: 0 1px 4px rgba(0,0,0,.22); margin-bottom: 5px; }
	.cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
	.gencover { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; gap: 10px; padding: 16% 12%; text-align: center;
		color: #fbf7ee; font-family: var(--display); outline: 1px solid rgba(255,255,255,.35); outline-offset: -7px;
		background-image: linear-gradient(90deg, rgba(0,0,0,.28), rgba(0,0,0,0) 7%, rgba(255,255,255,.06) 9%, rgba(0,0,0,0) 12%); }
	.gencover .gt { font-weight: 600; font-size: 15px; line-height: 1.2; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
	.gencover .ga { font-size: 12px; font-style: italic; opacity: .85; overflow-wrap: anywhere; }
	.gencover .gk { position: absolute; bottom: 12px; left: 0; right: 0; font: 600 10px/1 var(--sans); letter-spacing: .08em; opacity: .6; }
	.cover .cdone { position: absolute; top: 6px; right: 6px; margin: 0; }
	.covers .ct { font-weight: 600; font-size: 14px; line-height: 1.25; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
	.covers .ca { font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.covers .bar-prog { margin-top: 3px; }
	.uploads { list-style: none; margin: 8px 0 0; padding: 0; font-size: 14px; }
	.uploads li { padding: 4px 0; overflow-wrap: anywhere; }
	.books .child > .row > a { flex-direction: column; align-items: stretch; gap: 2px; padding-left: 8px; }
	.books .tools { padding-left: 8px; }
	.books .row > .pick { flex: none; width: 20px; height: 20px; margin: 0 0 0 8px; align-self: center; accent-color: var(--accent); }
	.selbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 0 0 8px; font-size: 14px; }
	.selbar .n { color: var(--muted); margin-right: auto; }
	.pop.ctx { right: auto; top: 0; left: 0; width: 220px; padding: 6px; }
	.pop.ctx .menu { display: flex; flex-direction: column; gap: 2px; }
	.pop.ctx .btn { text-align: left; justify-content: flex-start; border: 0; background: none; padding: 9px 10px; width: 100%; border-radius: 8px; }
	.pop.ctx .btn:hover, .pop.ctx .btn:focus-visible { background: var(--line); }
	.pop.ctx .sep { height: 1px; background: var(--line); margin: 4px 6px; }
	.pop.ctx .menu { max-height: calc(100vh - 28px); overflow-y: auto; }
	.pop.ctx .cap { font-size: 12px; color: var(--muted); padding: 4px 10px 2px; }
	.pop.ctx .btn.vol { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.books .bt { font-weight: 600; overflow-wrap: anywhere; }
	/* A series in the Series sort: one entry that opens to its volumes. */
	.books .series .bt::after { content: " ›"; color: var(--muted); }
	.covers .series .cover { overflow: visible; }
	.covers .series .cover::before, .covers .series .cover::after { content: ""; position: absolute; inset: 0; border-radius: 5px; background: var(--line);
		box-shadow: 0 1px 3px rgba(0,0,0,.18); transform: translate(4px, -4px); z-index: -1; }
	.covers .series .cover::after { transform: translate(8px, -8px); opacity: .7; z-index: -2; }
	.covers .series .cover > * { border-radius: 5px; overflow: hidden; }
	.covers .series .cover { isolation: isolate; }
	.people li { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; padding: 12px 0; border-bottom: 1px solid var(--line); }
	.people .who { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
	.people .who b { display: block; font: 500 18px/1.25 var(--display); }
	.people .who span { color: var(--muted); font-size: 14px; }
	.people .acts { display: flex; gap: 8px; flex: none; }
	/* Library card requests waiting: a dot on the settings gear, a count on Family library. */
	#settingsBtn { position: relative; padding-inline: 10px; display: flex; align-items: center; }
	#settingsBtn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
	.reqdot { position: absolute; top: -3px; right: -3px; width: 12px; height: 12px; border-radius: 50%; background: var(--bad); border: 2px solid var(--bg); }
	.reqn { display: inline-block; min-width: 20px; margin-left: 6px; padding: 0 6px; border-radius: 999px; background: var(--bad); color: #fff; font-size: 12px; font-weight: 700; line-height: 20px; text-align: center; }
	.people .req { background: var(--sel); border-radius: 10px; padding: 12px; margin-bottom: 8px; border-bottom: 0; }
	.people .who q { display: block; margin-top: 4px; font-style: italic; font-size: 14px; overflow-wrap: anywhere; }
	.people .dlbtn { padding: 0; min-height: 28px; font-size: 14px; }
	.people .dlog { flex-basis: 100%; list-style: none; margin: 0; padding: 0 0 0 10px; border-left: 2px solid var(--line); font-size: 14px; }
	.people .dlog li { padding: 3px 0; overflow-wrap: anywhere; }
	.famlink { border: 1px solid var(--line); background: var(--card); border-radius: 10px; padding: 12px; margin: 12px 0; }
	.famlink input { margin: 8px 0; font-size: 14px; }
	.famlink .row { display: flex; gap: 8px; }
	.libup { display: inline-block; margin: 12px 0 -6px; font-size: 14px; color: var(--accent); text-decoration: none; }
	.badge { display: inline-block; margin-left: 2px; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; line-height: 1.45;
		vertical-align: 2px; background: var(--ok-bg); color: var(--ok); white-space: nowrap; }
	.books .ba { font-size: 14px; overflow-wrap: anywhere; }
	.books .bm { font-size: 13px; color: var(--muted); }
	.books .feedtags { padding-left: 8px; }
	.books .bt .dots { vertical-align: 1px; }
	.btn.danger { color: var(--bad); }
	.books .row > .dl { flex: none; min-width: 44px; margin-right: 4px; font-variant-numeric: tabular-nums; }
	.bar-prog { height: 3px; border-radius: 2px; background: var(--line); margin-top: 6px; overflow: hidden; }
	.bar-prog span { display: block; height: 100%; background: var(--accent); }

	.txt { max-width: 68ch; margin: 0 auto; padding: 24px 16px 45vh; font-family: var(--read); font-size: var(--reader-size); line-height: 1.65; overflow-wrap: break-word; }
	.txt p { margin: 0 0 .9em; white-space: pre-line; }
	.txt .chunk { content-visibility: auto; contain-intrinsic-size: auto 1500px; }
	/* An EPUB's blocks: the book's own styles aren't used, only its structure. */
	.epub .chunk > * { margin: 0 0 .9em; }
	.epub p { white-space: normal; }
	.epub .chunk > .estart { margin-top: 3em; }
	.epub h1, .epub h2, .epub h3, .epub h4, .epub h5, .epub h6 { line-height: 1.25; margin: 1.2em 0 .6em; }
	.epub h1 { font-size: 1.6em; } .epub h2 { font-size: 1.35em; } .epub h3 { font-size: 1.15em; } .epub h4, .epub h5, .epub h6 { font-size: 1em; }
	.epub .ec { text-align: center; } .epub .er { text-align: right; }
	.epub img { max-width: 100%; height: auto; vertical-align: middle; }
	.epub .eimg { text-align: center; }
	.epub .eimg img { max-height: 85vh; }
	.epub blockquote { margin-left: 1.2em; margin-right: 0; }
	.epub ul, .epub ol { padding-left: 1.4em; }
	.epub li { margin: .2em 0; }
	.epub pre { white-space: pre-wrap; font-size: .85em; }
	.epub table { display: block; overflow-x: auto; border-collapse: collapse; }
	.epub td, .epub th { padding: 2px 8px; vertical-align: top; }
	.epub hr { border: 0; border-top: 1px solid var(--line); margin: 1.5em 25%; }
	.epub sup, .epub sub { line-height: 0; }
	.tocgo { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 9px 0; color: inherit; cursor: pointer; font: 15px/1.35 var(--sans); }
	.tocgo[aria-current=true] { font-weight: 700; color: var(--accent); }
	.pdf { max-width: 920px; margin: 0 auto; padding: 16px 16px 45vh; }
	.pdfpage { position: relative; width: 100%; background: var(--pdf-page); margin: 0 auto 14px; box-shadow: 0 1px 4px rgba(0,0,0,.18); }
	.pdfpage canvas { display: block; width: 100%; height: 100%; }
	.pdfpage .pn { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); color: var(--muted); font-size: 14px; }
	:root[data-theme=dark] .pdfpage canvas:not(.art), :root[data-theme=dracula] .pdfpage canvas:not(.art), :root[data-theme=kanagawa] .pdfpage canvas:not(.art), :root[data-theme=tokyonight] .pdfpage canvas:not(.art), :root[data-theme=gruvbox] .pdfpage canvas:not(.art), :root[data-theme=monokai] .pdfpage canvas:not(.art) { filter: invert(.88) hue-rotate(180deg); }
	@media (prefers-color-scheme: dark) { :root:not([data-theme]) .pdfpage canvas:not(.art) { filter: invert(.88) hue-rotate(180deg); } }
	:root[data-theme=sepia] .pdfpage canvas { filter: sepia(.5) brightness(.96); }
	.cbz { display: flex; flex-direction: column; align-items: center; padding: 8px 0 24px; -webkit-user-select: none; user-select: none; }
	.cbzpage { width: 100%; min-height: 40vh; display: flex; align-items: center; justify-content: center; cursor: pointer; touch-action: pan-y pinch-zoom; }
	.cbzpage img { display: block; width: 100%; height: var(--cbz-h, 80vh); object-fit: contain; }
	.cbz.fitw .cbzpage img { height: auto; max-width: 1100px; }
	.cbz.guided .cbzpage { position: relative; height: var(--cbz-h, 80vh); overflow: hidden; touch-action: pan-y; }
	.cbz.guided .cbzpage img { position: absolute; left: 0; top: 0; max-width: none; object-fit: fill; transform-origin: 0 0; transition: transform .3s ease; }
	@media (prefers-reduced-motion: reduce) { .cbz.guided .cbzpage img { transition: none; } }
	.cbz.scroll { padding: 0 0 24px; }
	.cbzstrip { width: 100%; max-width: 800px; }
	.cbzstrip img { display: block; width: 100%; height: 100%; }
	.cbzbar { display: flex; align-items: center; gap: 10px; width: 100%; max-width: 640px; padding: 10px 16px 0; font-family: var(--sans); }
	.cbzbar input { flex: 1; min-width: 0; }
	.loading { color: var(--muted); text-align: center; padding: 40px 16px; font-family: var(--sans); }

	/* Podcasts: the shows' artwork, a drawn tile where a show has none, each
	   with its unread episodes in the corner. */
	.shows { list-style: none; margin: 14px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 20px 16px; }
	.shows a { display: flex; flex-direction: column; gap: 3px; color: inherit; text-decoration: none; min-width: 0; }
	.showart { position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--sel); box-shadow: 0 1px 4px rgba(0,0,0,.22); margin-bottom: 5px; }
	.showart img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
	.showart .gen { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 12%; text-align: center;
		color: #fbf7ee; font: 600 17px/1.2 var(--display); overflow-wrap: anywhere; }
	.showart .gen span { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; }
	.showart .gen svg { position: absolute; left: 10px; bottom: 10px; width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; opacity: .6; }
	.shows a:hover .showart, .shows a:focus-visible .showart { box-shadow: 0 0 0 2px var(--accent); }
	.unreadn { position: absolute; top: 6px; right: 6px; min-width: 24px; padding: 2px 7px; border-radius: 999px; background: var(--accent); color: var(--on-accent);
		font: 700 13px/20px var(--sans); text-align: center; font-variant-numeric: tabular-nums; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
	.shows .ct { font-weight: 600; font-size: 14px; line-height: 1.25; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
	.shows .ca { font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	@media (max-width: 520px) { .shows { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 12px; } }
	.ephead-btns { display: flex; gap: 6px; flex: none; }
	/* + Add on a gallery: search Apple's podcast directory, or paste a link. */
	.epadd { margin: 10px 0 4px; }
	.epaddrow { display: flex; gap: 8px; }
	.epaddrow input { flex: 1; min-width: 0; }
	.epaddrow .btn { flex: none; }
	.found { list-style: none; margin: 8px 0 0; padding: 0; }
	.found li { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); }
	.found img, .found .noart { flex: none; width: 52px; height: 52px; border-radius: 6px; object-fit: cover; background: var(--sel); }
	.found .fi { flex: 1; min-width: 0; display: grid; }
	.found .ft { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.found .fa { font-size: 13px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.found .btn { flex: none; }
	/* A show's name can be long: it wraps instead, and the buttons go under it if need be. */
	#podcastsView .listhead { flex-wrap: wrap; }
	#podcastsView .listhead h2 { white-space: normal; overflow-wrap: anywhere; }
	/* Podcasts: the episode list, the box atop an episode, the player bar. */
	.eps li { display: flex; flex-wrap: wrap; align-items: center; column-gap: 8px; border-bottom: 1px solid var(--line); }
	.eps .mark { position: static; width: 40px; height: 40px; }
	.eps .read .mark { color: var(--accent); }
	.eps .notes { flex: 1 0 100%; margin: -6px 0 0; padding: 0 0 12px 22px; border: 0; background: none; color: var(--muted); font: 14px/1.4 var(--sans);
		text-align: left; cursor: pointer; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
	.eps .notes.open { display: block; -webkit-line-clamp: none; line-clamp: none; }
	.shelfbox { grid-column: 1 / -1; min-width: 0; margin: 4px 0 0; }
	#libShelf { margin: 14px 0 6px; }
	.shelfbox .cl { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); }
	.shelf { list-style: none; margin: 8px -16px 0; padding: 4px 16px 8px; display: flex; gap: 12px; overflow-x: auto; scroll-snap-type: x proximity;
		-webkit-overflow-scrolling: touch; scrollbar-width: none; }
	.shelf::-webkit-scrollbar { display: none; }
	.shelf li { flex: none; width: 96px; scroll-snap-align: start; }
	.shelf a { display: flex; flex-direction: column; gap: 2px; color: inherit; text-decoration: none; }
	.shelf .gencover { gap: 6px; padding: 14% 9%; }
	.shelf .gencover .gt { font-size: 12px; }
	.shelf .gencover .ga { font-size: 10px; }
	.shelf .gencover .gk { display: none; }
	.shelf .ct { font-weight: 600; font-size: 13px; line-height: 1.25; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
	.shelf .ca { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.shelf .bar-prog { margin-top: 3px; }
	.cont { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin: 16px 0 0; }
	.ccard { display: grid; gap: 2px; min-width: 0; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--card);
		color: inherit; text-decoration: none; text-align: left; font: 15px/1.35 var(--sans); cursor: pointer; }
	.ccard .cl { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); }
	.ccard .ct, .ccard .cm { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.ccard .ct { font-weight: 600; }
	.ccard .cm { font-size: 13px; color: var(--muted); }
	.eps li > a { flex: 1; min-width: 0; border-bottom: 0; }
	.eps .ep-btns { display: flex; gap: 6px; flex: none; }
	.eps .ep-btns .btn { min-width: 44px; font-variant-numeric: tabular-nums; }
	.episode { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: -8px 0 22px; font-family: var(--sans); }
	.episode video { width: 100%; max-height: 70vh; background: #000; border-radius: 6px; }
	.episode .player { width: 100%; }
	.episode .player iframe { display: block; width: 100%; aspect-ratio: 16 / 9; height: auto; max-height: 70vh; border: 0; border-radius: 6px; background: #000; }
	.coverage { font: 15px/1.5 var(--sans); border: 1px solid var(--line); background: var(--card); border-radius: 12px; padding: 12px 14px; margin: -8px 0 22px; }
	.coverage .covhead { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
	.coverage .covhead .lbl { flex: 1 1 14em; color: var(--muted); font-size: 14px; }
	.coverage .covstatus { color: var(--muted); font-size: 14px; margin: 8px 0 0; }
	.coverage .covstatus.err { color: var(--bad); }
	.coverage h3 { font-size: 17px; line-height: 1.3; margin: 14px 0 2px; }
	.coverage h4 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 16px 0 6px; }
	.coverage h5 { font-size: 15px; margin: 12px 0 4px; }
	.coverage ul { margin: 0; padding-left: 1.2em; }
	.coverage li { margin: 0 0 8px; }
	.coverage .who { color: var(--muted); font-size: 13px; white-space: nowrap; }
	.coverage .kind { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-right: 4px; }
	.coverage .quote { display: block; margin-top: 2px; color: var(--muted); font-size: 14px; font-style: italic; overflow-wrap: anywhere; }
	.coverage .fine { color: var(--muted); font-size: 13px; margin: 12px 0 0; }
	.episode .lpsleep { width: 100%; margin-top: 0; }
	.episode .when { color: var(--muted); font-size: 14px; font-variant-numeric: tabular-nums; }
	.btn.on { border-color: var(--accent); color: var(--accent); }
	body.has-pbar { padding-bottom: calc(96px + env(safe-area-inset-bottom) + var(--lost, 0px)); }
	body.has-pbar .toast { bottom: calc(110px + env(safe-area-inset-bottom) + var(--lost, 0px)); }
	.pbar { position: fixed; left: 0; right: 0; bottom: var(--lost, 0px); z-index: 15; background: var(--card); border-top: 1px solid var(--line);
		padding: 4px 12px calc(6px + env(safe-area-inset-bottom)); box-shadow: 0 -4px 16px rgba(0,0,0,.08); }
	.pbar input[type=range] { display: block; width: 100%; max-width: 1076px; margin: 0 auto; accent-color: var(--accent); }
	.prow { display: flex; align-items: center; gap: 2px; max-width: 1076px; margin: 0 auto; }
	.ptitle { flex: 1; min-width: 0; display: grid; text-align: left; background: none; border: 0; padding: 4px; cursor: pointer; }
	.ptitle span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	#pName { font-weight: 600; font-size: 14px; }
	.ptime { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
	.prow .btn { min-width: 40px; padding-inline: 6px; font-variant-numeric: tabular-nums; }
	#pPlay { flex: none; width: 46px; height: 46px; min-width: 0; min-height: 0; padding: 0; border-radius: 50%; }
	/* The bar's and the player page's sliders: drawn here, so the thumb is a round dot in every browser and theme. */
	.seek { -webkit-appearance: none; appearance: none; height: 22px; background: none; cursor: pointer; --p: 0%; --ring: var(--card); }
	.seek::-webkit-slider-runnable-track { height: 6px; border-radius: 3px; background: linear-gradient(to right, var(--accent) var(--p), var(--line) var(--p)); }
	.seek::-moz-range-track { height: 6px; border-radius: 3px; background: var(--line); }
	.seek::-moz-range-progress { height: 6px; border-radius: 3px; background: var(--accent); }
	.seek::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 18px; height: 18px; margin-top: -6px; border-radius: 50%; background: var(--accent); border: 3px solid var(--ring); box-shadow: 0 0 0 1px var(--accent); }
	.seek::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 3px solid var(--ring); box-shadow: 0 0 0 1px var(--accent); }
	#lpSeek { --ring: var(--bg); }
	@media (max-width: 420px) { #pRate, #pClose { padding-inline: 2px; min-width: 32px; } .tabs a { font-size: 14px; } }
	/* The bookmark button in a book's top bar: filled once one is set. */
	#markBtn { padding-inline: 10px; display: flex; align-items: center; }
	#markBtn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linejoin: round; }
	#markBtn.on { color: var(--accent); }
	#markBtn.on svg { fill: currentColor; }
	/* "Back to furthest": under the header, so it's clear of the player, the
	   highlight bar and a comic's page bar. */
	.farpill { position: fixed; z-index: 15; left: 50%; transform: translateX(-50%); top: calc(max(6px, env(safe-area-inset-top)) + 58px);
		display: flex; align-items: center; background: var(--fg); color: var(--bg); border-radius: 999px; box-shadow: 0 4px 16px rgba(0,0,0,.2);
		font-size: 14px; max-width: calc(100vw - 32px); }
	.farpill button { background: none; border: 0; color: inherit; font: inherit; min-height: 40px; cursor: pointer; white-space: nowrap; }
	#farGo { padding: 8px 6px 8px 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
	#farX { padding: 8px 14px 8px 8px; opacity: .7; }
	.toast { position: fixed; left: 50%; bottom: calc(20px + env(safe-area-inset-bottom) + var(--lost, 0px)); transform: translateX(-50%); z-index: 30;
		background: var(--fg); color: var(--bg); padding: 10px 14px; border-radius: 10px; font-size: 14px; max-width: calc(100vw - 32px); }
	.toast.act { display: flex; align-items: center; width: max-content; }
	.toast button { flex: none; white-space: nowrap; margin-left: 12px; border: 0; border-radius: 8px; padding: 6px 10px; background: var(--bg); color: var(--fg); font-weight: 600; font-size: 14px; cursor: pointer; }
</style>
</head>
<body>
<form id="tokenForm" class="token" hidden>
	<h1><img class="logo" src="__ICON__" alt=""><span class="wordmark" role="img" aria-label="Reader">__WORDMARK__</span></h1>
	<label for="token">Access token</label>
	<input id="token" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false">
	<div class="hint">Only needed once on this device.</div>
	<div id="tokenErr" class="err hint" hidden></div>
	<button class="btn primary" type="submit">Continue</button>
</form>

<div id="app" hidden>
<header class="top" id="top">
	<div class="bar">
		<button id="back" class="btn ghost" type="button" hidden>&lsaquo; Back</button>
		<a id="home" class="home" href="/" title="Reload Reader"><img id="logo" class="logo" src="__ICON__" alt=""><span id="wordmark" class="wordmark" role="img" aria-label="Reader">__WORDMARK__</span></a>
		<h1 id="heading"></h1>
		<span id="progress" class="progress" hidden></span>
		<button id="markBtn" class="btn" type="button" aria-label="Bookmark this place" aria-pressed="false" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></button>
		<button id="refresh" class="btn" type="button">Refresh</button>
		<button id="bookMenuBtn" class="btn" type="button" aria-label="Book options" aria-expanded="false" aria-controls="bookMenu" hidden>&#8943;</button>
		<button id="settingsBtn" class="btn" type="button" aria-label="Display settings" aria-expanded="false" aria-controls="settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg><span class="reqdot" hidden></span></button>
	</div>
	<nav id="tabs" class="tabs" aria-label="Views">
		<a href="#/unread" data-view="unread">Unread</a>
		<a href="#/all" data-view="all">All</a>
		<a href="#/saved" data-view="saved" class="icon" aria-label="Saved" title="Saved"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></a>
		<a href="#/podcasts" data-view="podcasts" class="icon" aria-label="Podcasts" title="Podcasts"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg></a>
		<a href="#/videos" data-view="videos" class="icon" aria-label="Videos" title="Videos"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z"/></svg></a>
		<a href="#/library" data-view="library" class="icon" aria-label="Library" title="Library"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/></svg></a>
	</nav>
</header>

<div id="settings" class="pop" hidden>
	<h2>Theme</h2>
	<div class="seg grid" id="themes">
		<button type="button" data-theme="auto">Auto</button>
		<button type="button" data-theme="light">Light</button>
		<button type="button" data-theme="dark">Dark</button>
		<button type="button" data-theme="sepia">Sepia</button>
		<button type="button" data-theme="dracula">Dracula</button>
		<button type="button" data-theme="kanagawa">Kanagawa</button>
		<button type="button" data-theme="tokyonight">Tokyo Night</button>
		<button type="button" data-theme="gruvbox">Gruvbox</button>
		<button type="button" data-theme="monokai">Monokai</button>
	</div>
	<h2>Text size</h2>
	<div class="seg">
		<button id="smaller" type="button" aria-label="Smaller text">A&minus;</button>
		<span id="sizeVal" class="val">19</span>
		<button id="larger" type="button" aria-label="Larger text">A+</button>
	</div>
	<h2>Reading font</h2>
	<div class="seg" id="fonts">
		<button type="button" data-font="serif">System serif</button>
		<button type="button" data-font="fraunces" class="fraunces">Fraunces</button>
	</div>
	<h2>Mark read as I scroll</h2>
	<div class="seg" id="scrollRead">
		<button type="button" data-on="">Off</button>
		<button type="button" data-on="1">On</button>
	</div>
	<a href="#/family" id="familyLink" class="btn small">Family library<span class="reqn" hidden></span></a>
	<button id="forget" class="btn ghost small" type="button">Forget token on this device</button>
</div>

<div id="bookCtx" class="pop ctx" role="menu" hidden><div class="menu"></div></div>

<div id="bookMenu" class="pop" hidden>
	<h2>This book</h2>
	<div class="menu">
		<button id="bmToMark" class="btn" type="button" hidden>Go to bookmark</button>
		<button id="bmToFar" class="btn" type="button" hidden>Go to furthest</button>
		<button id="bmUnmark" class="btn" type="button" hidden>Remove bookmark</button>
		<button id="bmContents" class="btn" type="button" hidden>Contents</button>
		<button id="bmFind" class="btn" type="button" hidden>Search in book</button>
		<button id="bmHighlights" class="btn" type="button" hidden>Highlights</button>
		<div id="bmLayout" class="seg" role="group" aria-label="Layout" hidden>
			<button type="button" data-layout="pages">Pages</button>
			<button type="button" data-layout="scroll">Scroll</button>
			<button type="button" data-layout="rtl">Right to left</button>
		</div>
		<button id="bmGuided" class="btn" type="button" hidden aria-pressed="false">Guided view</button>
		<button id="bmDetails" class="btn" type="button">Edit details</button>
		<button id="bmFinish" class="btn" type="button">Mark finished</button>
		<button id="bmRestart" class="btn" type="button">Start over</button>
		<button id="bmDownload" class="btn" type="button">Download for offline</button>
		<button id="bmDelete" class="btn danger" type="button">Delete book</button>
	</div>
	<div id="bmNote" class="hint"></div>
</div>

<main>
<section id="listView" class="wrap listview" hidden>
	<aside class="side">
		<details id="feedsBox">
			<summary>Feeds <span id="feedCount" class="muted"></span></summary>
			<div class="editbar">
				<button id="newTag" class="btn small" type="button" hidden>New tag</button>
				<button id="editFeeds" class="btn ghost small" type="button">Edit</button>
			</div>
			<form id="addForm" class="add">
				<label class="vh" for="addUrl">Website or feed URL</label>
				<input id="addUrl" type="text" inputmode="url" placeholder="Add a website or feed URL" autocapitalize="off" autocorrect="off" spellcheck="false">
				<div class="addrow">
					<label class="vh" for="addTag">Tag</label>
					<select id="addTag"></select>
					<button id="addBtn" class="btn primary" type="submit">Add</button>
				</div>
			</form>
			<div id="addStatus" class="status" role="status" hidden></div>
			<ul id="feeds" class="tree flat"></ul>
		</details>
	</aside>
	<div>
		<div id="cont" class="cont" hidden></div>
		<div class="listhead">
			<h2 id="listTitle">Unread</h2>
			<button id="markAll" class="btn ghost small" type="button">Mark all read</button>
		</div>
		<ul id="items" class="items"></ul>
		<p id="empty" class="empty" hidden></p>
		<button id="more" class="btn wide" type="button" hidden>Load more</button>
	</div>
</section>

<section id="articleView" hidden>
	<article class="article">
		<h1 id="aTitle" class="title"></h1>
		<div id="aMeta" class="meta"></div>
		<div class="actions">
			<button id="aSave" class="btn small" type="button">Save</button>
			<button id="aRead" class="btn small" type="button">Mark unread</button>
			<button id="aShare" class="btn small" type="button">Share</button>
			<a id="aLink" class="btn small" target="_blank" rel="noopener noreferrer">Original &#8599;</a>
		</div>
		<div id="aEpisode" class="episode" hidden></div>
		<section id="aCoverage" class="coverage" aria-label="Coverage in other feeds" hidden></section>
		<div id="aBody" class="prose"></div>
		<button id="aFull" class="btn wide" type="button" hidden>Load full article</button>
		<nav id="aNav" class="itemnav" aria-label="Other items" hidden>
			<button id="aPrev" class="btn" type="button" aria-label="Previous">&#8592;<span class="lbl"> Previous</span></button>
			<button id="aNext" class="btn" type="button" aria-label="Next"><span class="lbl">Next </span>&#8594;</button>
		</nav>
	</article>
</section>

<section id="podcastsView" class="wrap" hidden>
	<a id="epUp" class="libup" href="#/podcasts" hidden>‹ Podcasts</a>
	<div class="listhead">
		<h2 id="epHead">Podcasts</h2>
		<div class="ephead-btns">
			<button id="epAdd" class="btn ghost small" type="button" aria-expanded="false" aria-controls="epAddBox" hidden>+ Add</button>
			<button id="epAllRead" class="btn ghost small" type="button" hidden>Mark all read</button>
			<button id="epFilter" class="btn ghost small" type="button" aria-pressed="false">Downloaded</button>
		</div>
	</div>
	<div id="epAddBox" class="epadd" hidden>
		<form id="epAddForm" class="epaddrow">
			<label class="vh" for="epAddUrl">Search, or paste a link</label>
			<input id="epAddUrl" type="search" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
			<button id="epAddGo" class="btn primary" type="submit">Search</button>
		</form>
		<div id="epAddStatus" class="status" role="status" hidden></div>
		<ul id="epFound" class="found"></ul>
	</div>
	<p id="epNote" class="hint" hidden></p>
	<ul id="shows" class="shows" hidden></ul>
	<ul id="episodes" class="items eps"></ul>
	<p id="epEmpty" class="empty" hidden></p>
	<button id="epMore" class="btn wide" type="button" hidden>Load more</button>
</section>

<section id="libraryView" class="wrap" hidden>
	<a id="libUp" class="libup" href="#/library" hidden>‹ Library</a>
	<div class="listhead">
		<h2 id="libTitle">Library</h2>
		<button id="editBooks" class="btn ghost small" type="button">Edit</button>
	</div>
	<div id="libUpload">
		<div class="uploadrow">
			<label class="vh" for="uploadTag">Tag for uploads</label>
			<select id="uploadTag"></select>
			<button id="uploadBtn" class="btn primary" type="button">Upload</button>
		</div>
		<input id="bookFile" class="vh" type="file" accept=".txt,.pdf,.cbz,.epub,text/plain,application/pdf,application/vnd.comicbook+zip,application/x-cbz,application/zip,application/epub+zip" multiple tabindex="-1" aria-hidden="true">
		<div class="hint">.txt, .pdf, DRM-free .epub, or .cbz comics. A file with the same name as a book here replaces that book's file. ⤓ keeps a book on this device for reading offline.</div>
		<ul id="uploads" class="uploads"></ul>
	</div>
	<p id="libNote" class="hint" hidden>You're offline. These are the books downloaded on this device; your place syncs when you're back online.</p>
	<div id="libShelf" class="shelfbox" hidden></div>
	<div id="bookTags" class="tagbar" hidden></div>
	<div class="libfind">
		<label class="vh" for="bookSearch">Search the Library</label>
		<input id="bookSearch" type="search" placeholder="Search title, author, series" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
		<label class="vh" for="bookSort">Sort</label>
		<select id="bookSort">
			<option value="recent">Recent</option>
			<option value="title">Title A–Z</option>
			<option value="author">Author</option>
			<option value="series">Series</option>
		</select>
		<label class="vh" for="bookFormat">Formats</label>
		<select id="bookFormat">
			<option value="">All formats</option>
			<option value="read">Ebooks</option>
			<option value="listen">Audiobooks</option>
		</select>
		<button id="libLayout" class="btn small" type="button" aria-pressed="false">Covers</button>
	</div>
	<div id="libSelBar" class="selbar" hidden>
		<span id="libSelN" class="n"></span>
		<button id="libSelAll" class="btn small" type="button">Select all</button>
		<button id="libSelNone" class="btn small" type="button">Clear</button>
		<button id="libSelGenres" class="btn small" type="button">Tag genres</button>
		<button id="libSelFill" class="btn small" type="button" title="Series, volume and title from each comic's ComicInfo.xml">Fill in details</button>
		<button id="libSelRecord" class="btn small" type="button" title="Jacket copy, pages and appeal terms for the family library's Record page">Look up records</button>
		<button id="libSelDel" class="btn small danger" type="button">Delete</button>
	</div>
	<ul id="books" class="tree books flat"></ul>
	<p id="booksEmpty" class="empty" hidden>No books yet. Upload a .txt, .pdf, .epub or .cbz to start.</p>
</section>

<section id="bookView" hidden>
	<div id="bookBody"></div>
</section>

<section id="recordView" class="wrap" hidden>
	<div class="rec">
		<div id="recCover" class="rcov"></div>
		<div class="rmain">
			<p class="reye">Record</p>
			<h2 id="recTitle" class="rtitle"></h2>
			<p id="recBy" class="rby"></p>
			<p id="recSeries" class="rseries"></p>
			<dl id="recFacts" class="facts"></dl>
			<div id="recActs" class="racts"></div>
		</div>
	</div>
	<section id="recChapSec" class="rsec" hidden>
		<h3>Chapters</h3>
		<ol id="recChapters" class="chapters"></ol>
	</section>
	<section id="recBlurbSec" class="rsec" hidden>
		<h3>From the jacket</h3>
		<div id="recBlurb" class="blurb"></div>
		<p id="recBlurbNote" class="hint" hidden></p>
	</section>
	<section id="recAppealSec" class="rsec" hidden>
		<h3>Appeal</h3>
		<dl id="recAppeal" class="appeal"></dl>
	</section>
</section>

<section id="listenView" class="wrap" hidden>
	<div class="lplay">
		<div id="lpCover" class="lpcov"></div>
		<div class="lpmain">
			<p class="reye">Listening</p>
			<h2 id="lpTitle" class="rtitle"></h2>
			<p id="lpBy" class="rby"></p>
			<button id="lpChap" class="lpchap" type="button" aria-haspopup="dialog" hidden></button>
			<input id="lpSeek" class="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Position in chapter">
			<div class="lptimes"><span id="lpPos"></span><span id="lpLeft"></span></div>
			<div class="lpctl">
				<button id="lpPrev" class="btn ghost" type="button" aria-label="Previous chapter"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2.2v14H6zM19 5v14L9.5 12z"/></svg></button>
				<button id="lpBack" class="btn ghost" type="button" aria-label="Back 15 seconds">&#8634;15</button>
				<button id="lpPlay" class="btn primary" type="button" aria-label="Play">&#9654;</button>
				<button id="lpFwd" class="btn ghost" type="button" aria-label="Forward 30 seconds">30&#8635;</button>
				<button id="lpNext" class="btn ghost" type="button" aria-label="Next chapter"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.8 5H18v14h-2.2zM5 5v14l9.5-7z"/></svg></button>
			</div>
			<div class="lpmore">
				<button id="lpRate" class="btn small" type="button" aria-label="Playback speed">1&times;</button>
				<button id="lpChapBtn" class="btn small" type="button" aria-haspopup="dialog" hidden>Chapters</button>
				<button id="lpSleep" class="btn small sleepbtn" type="button" aria-controls="lpSleepOpts">Sleep</button>
				<button id="lpVoice" class="btn small voicebtn" type="button" aria-label="Voice boost: off">Voice</button>
				<span id="lpBook"></span>
				<a id="lpRecord" href="#/library">Record</a>
			</div>
			<div id="lpSleepOpts" class="lpsleep" role="group" aria-label="Sleep timer" hidden>
				<button class="btn small" type="button" data-sleep="15">15 min</button>
				<button class="btn small" type="button" data-sleep="30">30 min</button>
				<button class="btn small" type="button" data-sleep="45">45 min</button>
				<button class="btn small" type="button" data-sleep="60">1 h</button>
				<button class="btn small" type="button" data-sleep="chapter">End of chapter</button>
				<button class="btn small" type="button" data-sleep="off">Off</button>
			</div>
		</div>
	</div>
	<section id="lpChapSec" class="rsec" hidden>
		<h3>Chapters</h3>
		<ol id="lpChapters" class="chapters"></ol>
	</section>
	<dialog id="lpChapDlg" class="chapdlg" aria-labelledby="lpChapDlgH">
		<div class="chapdlghd"><h2 id="lpChapDlgH">Chapters</h2><button id="lpChapClose" class="btn ghost" type="button" aria-label="Close">&times;</button></div>
		<ol id="lpChapPick" class="chapters"></ol>
	</dialog>
</section>

<section id="familyView" class="wrap" hidden>
	<p class="hint">The Back Alley Library is at <a href="/library" target="_blank" rel="noopener">/library</a>. Anyone can ask for a library card there; requests show here first. Each person gets their own link. It works once, on the device they open it on, and runs out after 7 days if it isn't used. They can browse the Library and download books; nothing else. Books tagged "Hide from family" stay out of it.</p>
	<form id="famForm" class="uploadrow">
		<label class="vh" for="famName">Name</label>
		<input id="famName" type="text" placeholder="Name" maxlength="60" autocomplete="off" autocapitalize="words">
		<button id="famMake" class="btn primary" type="submit">Make link</button>
	</form>
	<div id="famLink" class="famlink" hidden></div>
	<ul id="people" class="items people"></ul>
	<p id="famEmpty" class="empty" hidden>No one yet.</p>
</section>
</main>
<div id="pbar" class="pbar" hidden>
	<input id="pSeek" class="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Position in episode">
	<div class="prow">
		<button id="pTitle" class="ptitle" type="button"><span id="pName"></span><span id="pTime" class="ptime"></span></button>
		<button id="pBack" class="btn ghost" type="button" aria-label="Back 15 seconds">&#8634;15</button>
		<button id="pPlay" class="btn primary" type="button" aria-label="Play">&#9654;</button>
		<button id="pFwd" class="btn ghost" type="button" aria-label="Forward 30 seconds">30&#8635;</button>
		<button id="pRate" class="btn ghost small" type="button" aria-label="Playback speed">1&times;</button>
		<button id="pClose" class="btn ghost" type="button" aria-label="Close player">&times;</button>
	</div>
	<audio id="pAudio" preload="metadata"></audio>
</div>
<div id="hlBar" class="hlbar" hidden>
	<button id="hlAdd" class="btn primary" type="button">Highlight</button>
	<button id="hlNote" class="btn" type="button">Add note</button>
</div>
<div id="hlPop" class="pop hlpop" role="dialog" aria-label="Highlight" hidden>
	<h2>Highlight</h2>
	<blockquote id="hlQuote" class="hlquote"></blockquote>
	<label class="vh" for="hlNoteText">Note</label>
	<textarea id="hlNoteText" rows="4" placeholder="Add a note"></textarea>
	<div class="hlrow">
		<button id="hlDelete" class="btn danger" type="button">Delete</button>
		<span></span>
		<button id="hlClose" class="btn ghost" type="button">Cancel</button>
		<button id="hlSave" class="btn primary" type="button">Save</button>
	</div>
</div>
<div id="hlList" class="pop hlpop" role="dialog" aria-label="Highlights" hidden>
	<h2>Highlights</h2>
	<ul id="hlItems" class="hlitems"></ul>
	<p id="hlEmpty" class="hint" hidden></p>
	<div class="hlrow">
		<button id="hlExport" class="btn" type="button">Export Markdown</button>
		<span></span>
		<button id="hlListClose" class="btn ghost" type="button">Close</button>
	</div>
</div>
<div id="findList" class="pop hlpop" role="dialog" aria-label="Search in book" hidden>
	<h2>Search in book</h2>
	<form id="findForm" class="findform">
		<label class="vh" for="findQ">Words to find</label>
		<input id="findQ" type="search" placeholder="Words to find" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
	</form>
	<p id="findStatus" class="hint" hidden></p>
	<ul id="findItems" class="hlitems"></ul>
	<div class="hlrow">
		<span></span>
		<button id="findClose" class="btn ghost" type="button">Close</button>
	</div>
</div>
<div id="detailsBox" class="pop hlpop" role="dialog" aria-label="Book details" hidden>
	<h2>Edit details</h2>
	<form id="detailsForm" class="details">
		<label>Title <input id="dTitle" type="text" required maxlength="300" autocomplete="off"></label>
		<label>Author <input id="dAuthor" type="text" maxlength="300" autocomplete="off"></label>
		<div class="drow">
			<label>Series <input id="dSeries" type="text" maxlength="300" autocomplete="off"></label>
			<label>Volume <input id="dVolume" type="text" maxlength="20" autocomplete="off"></label>
		</div>
		<div class="dcover">
			<div id="dCover" class="cover"></div>
			<div class="menu">
				<button id="dCoverPick" class="btn small" type="button">Choose image…</button>
				<button id="dCoverAuto" class="btn small" type="button">Automatic cover</button>
				<input id="dCoverFile" class="vh" type="file" accept="image/jpeg,image/png,image/webp" tabindex="-1" aria-hidden="true">
			</div>
		</div>
		<div class="dlook">
			<button id="dLookup" class="btn small" type="button">Look up online</button>
			<button id="dGenres" class="btn small" type="button">Tag genres</button>
			<span id="dLookStatus" class="hint"></span>
		</div>
		<ul id="dHits" class="lookhits" hidden></ul>
		<div id="dCovers" class="lookcovers" hidden></div>
		<div id="dTags"></div>
		<div class="drec">
			<h3>Record <span class="hint">(the family library's page for this book)</span></h3>
			<label>Jacket copy <textarea id="dBlurb" rows="5" maxlength="4000"></textarea></label>
			<label>Catalog <span class="hint">(a line each: Published, Publisher, Language, Classification, ISBN)</span>
				<textarea id="dCatalog" rows="5" placeholder="Published: 1996&#10;Publisher: Bantam"></textarea></label>
			<label>Appeal terms <span class="hint">(a line each: Pacing, Tone, Writing style, Characters, Storyline)</span>
				<textarea id="dAppeal" rows="5" placeholder="Pacing: Fast-paced&#10;Tone: Suspenseful, Wry"></textarea></label>
			<div class="dlook">
				<label>Pages <input id="dPages" type="text" inputmode="numeric" maxlength="6" autocomplete="off"></label>
				<button id="dRecord" class="btn small" type="button">Look it up again</button>
				<span id="dRecStatus" class="hint"></span>
			</div>
		</div>
		<div class="hlrow">
			<button id="dCancel" class="btn ghost" type="button">Cancel</button>
			<span></span>
			<button id="dSave" class="btn primary" type="submit">Save</button>
		</div>
	</form>
</div>
<div id="tocList" class="pop hlpop" role="dialog" aria-label="Contents" hidden>
	<h2>Contents</h2>
	<ul id="tocItems" class="hlitems"></ul>
	<div class="hlrow">
		<span></span>
		<button id="tocClose" class="btn ghost" type="button">Close</button>
	</div>
</div>
<div id="farPill" class="farpill" hidden><button id="farGo" type="button"></button><button id="farX" type="button" aria-label="Hide">&times;</button></div>
<div id="toast" class="toast" role="status" hidden></div>
</div>

<script nonce="__NONCE__">
var $ = function (id) { return document.getElementById(id); };
var PDFJS = "__PDFJS__";
// For HLS (.m3u8) video where the browser can't play it itself (everything but Safari).
var HLSJS = { src: "https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js", integrity: "sha384-cciJ0zi8d1uMKC2zJd7jvPY4HQt7W4ByUI/FlMkltvBi31aW61rcpVBhpmW8/NwX" };
var PDFJS_DATA = "__PDFJS_DATA__";
var LIST_VIEWS = { unread: "Unread", saved: "Saved", all: "All" };
// Both share the Podcasts section: same gallery, list, downloads and player.
var MEDIA_TABS = { podcasts: "Podcasts", videos: "Videos" };
var STALE_MS = 5 * 60 * 1000; // auto-refresh skips feeds fetched this recently
var CHUNK = 50; // paragraphs per block in the .txt reader
var CHARS_PER_PAGE = 1650; // a printed page, for a .txt or .epub with no page count (the Worker's WORDS_PER_PAGE)
// A .txt book's YAML header; the Worker reads it (parseFrontMatter).
var FRONT_MATTER = /^\s*---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
var UNAUTH = "Unauthorized";

var state = {
	route: null, prev: null, fromList: false, lastList: "#/unread",
	view: "unread", feed: null, tag: null,
	episodes: [], epNext: null, epOffline: false, epDownloadedOnly: false, epKind: "podcasts", epFeed: null, itemEp: null, fromPodcasts: false,
	feeds: [], tags: [], books: null, bookTags: readJSON("readerBookTags") || [], libTag: null, libTags: [], libSearch: "", libSort: read("readerBookSort") || "recent", libFormat: read("readerBookFormat") || "", libScroll: 0, record: null, libView: read("readerBookView") === "covers" ? "covers" : "list",
	items: [], next: null, listKey: "", listScroll: 0, stale: true,
	refreshing: false, errors: {}, editFeeds: false, editBooks: false, libSel: {}, item: null
};
var session = null; // the open book
var started = false;

// ---------- small helpers

function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function readJSON(k) { try { return JSON.parse(read(k) || "null"); } catch (e) { return null; } }
function show(node, on) { node.hidden = !on; }
function h(tag, cls, text) {
	var e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
}
function button(label, cls, onClick) {
	var b = h("button", cls || "btn small", label);
	b.type = "button";
	b.addEventListener("click", onClick);
	return b;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u || ""; } }
function escapeHTML(s) { return String(s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
function pause() { return new Promise(function (r) { setTimeout(r, 0); }); }
function sameId(a, b) { return a == null ? b == null : b != null && Number(a) === Number(b); }

var toastTimer;
// act: {label, fn} for a button after the message (it stays up longer).
function toast(msg, act) {
	var t = $("toast");
	t.textContent = msg;
	t.classList.toggle("act", !!act);
	if (act) t.append(button(act.label, "tact", function () { show(t, false); act.fn(); }));
	show(t, true);
	clearTimeout(toastTimer);
	toastTimer = setTimeout(function () { show(t, false); }, act ? 9000 : 4500);
}
function fail(err) { if (err && err.message !== UNAUTH) toast(err.message || String(err)); }

function ago(ms) {
	if (!ms) return "";
	var s = (Date.now() - ms) / 1000;
	if (s < 60) return "now";
	if (s < 3600) return Math.floor(s / 60) + "m";
	if (s < 86400) return Math.floor(s / 3600) + "h";
	if (s < 7 * 86400) return Math.floor(s / 86400) + "d";
	var d = new Date(ms);
	var opts = { month: "short", day: "numeric" };
	if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
	return d.toLocaleDateString(undefined, opts);
}
function longDate(ms) {
	return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}
function bytes(n) {
	if (n < 1024) return n + " B";
	if (n < 1048576) return Math.round(n / 1024) + " KB";
	return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
}

// ---------- display settings (per device)

var fontSize = clamp(Number(read("readerFontSize")) || 19, 14, 30);
var readFont = read("readerFont") === "fraunces" ? "fraunces" : "serif";

// Auto follows the system; the rest are set on <html> as data-theme.
var THEMES = ["auto", "light", "dark", "sepia", "dracula", "kanagawa", "tokyonight", "gruvbox", "monokai"];
function applyTheme(t) {
	var root = document.documentElement;
	if (THEMES.indexOf(t) > 0) root.setAttribute("data-theme", t);
	else { root.removeAttribute("data-theme"); t = "auto"; }
	document.querySelectorAll("#themes button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.theme === t)); });
	var meta = document.querySelector("meta[name=theme-color]");
	if (meta) meta.content = getComputedStyle(root).getPropertyValue("--bg").trim();
}
function applySize(px) {
	var keep = session && session.capture ? session.capture() : null;
	fontSize = clamp(px, 14, 30);
	document.documentElement.style.setProperty("--reader-size", fontSize + "px");
	$("sizeVal").textContent = fontSize;
	if (keep != null && session.relayout) session.relayout(keep);
}
// Articles and books in the system serif (the default) or Fraunces.
function applyFont(f) {
	var keep = session && session.capture ? session.capture() : null;
	readFont = f === "fraunces" ? "fraunces" : "serif";
	document.documentElement.style.setProperty("--read", readFont === "fraunces" ? "var(--display)" : "var(--serif)");
	document.querySelectorAll("#fonts button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.font === readFont)); });
	if (keep != null && session.relayout) session.relayout(keep);
}
function openSettings(on) {
	if (on) openBookMenu(false);
	show($("settings"), on);
	$("settingsBtn").setAttribute("aria-expanded", String(on));
}
function openBookMenu(on) {
	if (on) { openSettings(false); renderBookMenu(); }
	show($("bookMenu"), on);
	$("bookMenuBtn").setAttribute("aria-expanded", String(on));
}

// ---------- API

function token() { return read("readerToken") || ""; }

async function api(path, opts) {
	opts = opts || {};
	var headers = { Authorization: "Bearer " + token() };
	var body = opts.body;
	if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.json); }
	var res = await fetch(path, { method: opts.method || "GET", headers: headers, body: body, keepalive: !!opts.keepalive });
	if (res.status === 401) {
		store("readerToken", null);
		askToken("That token didn't work.");
		throw new Error(UNAUTH);
	}
	return res;
}
async function apiJSON(path, opts) {
	var res = await api(path, opts);
	var data = await res.json().catch(function () { return {}; });
	if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
	return data;
}

// Fetch another site through the Worker, decoding it with its own charset.
async function proxyGet(url) {
	var res = await api("/api/fetch?url=" + encodeURIComponent(url));
	if (!res.ok) {
		var d = await res.json().catch(function () { return {}; });
		throw new Error(d.error || "HTTP " + res.status);
	}
	var type = res.headers.get("Content-Type") || "";
	var buf = await res.arrayBuffer();
	return { url: res.headers.get("X-Final-URL") || url, type: type, text: decodeBody(buf, type) };
}
function decodeBody(buf, type) {
	var b = new Uint8Array(buf);
	var cs = (/charset=["']?([\w.:-]+)/i.exec(type) || [])[1];
	if (!cs) {
		var head = new TextDecoder("windows-1252").decode(b.subarray(0, 2048));
		var m = /<\?xml[^>]*encoding=["']([\w.:-]+)/i.exec(head) || /<meta[^>]+charset=["']?([\w.:-]+)/i.exec(head);
		cs = m && m[1];
	}
	try { return new TextDecoder(cs || "utf-8").decode(b); } catch (e) { return new TextDecoder("utf-8").decode(b); }
}

// ---------- token

function askToken(msg) {
	closeBook();
	show($("app"), false);
	show($("tokenForm"), true);
	$("tokenErr").textContent = msg || "";
	show($("tokenErr"), !!msg);
	$("token").value = "";
	$("token").focus();
}

// ---------- parsing (all in inert DOMParser documents)

function parseHTML(text) { return new DOMParser().parseFromString(text, "text/html"); }
function plain(s) {
	if (!s) return "";
	s = String(s);
	if (/[<&]/.test(s)) s = parseHTML(s).body.textContent || "";
	return s.replace(/\s+/g, " ").trim();
}
function absUrl(href, base) {
	if (!href) return null;
	try {
		var u = new URL(String(href).trim(), base);
		return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
	} catch (e) { return null; }
}
function baseOf(doc, url) {
	var b = doc.querySelector("base[href]");
	return (b && absUrl(b.getAttribute("href"), url)) || url;
}
function kids(node, name) {
	var out = [];
	if (!node) return out;
	for (var c = node.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name) out.push(c);
	return out;
}
function kid(node, name) { return kids(node, name)[0] || null; }
function kidText(node, name) { var c = kid(node, name); return c ? c.textContent.trim() : ""; }
function toTime(s) { if (!s) return null; var t = Date.parse(s); return isNaN(t) ? null : t; }

function parseXML(text) {
	var p = new DOMParser();
	var doc = p.parseFromString(text, "application/xml");
	if (!doc.getElementsByTagName("parsererror").length) return doc;
	// The usual breakage is a bare "&" in a title or URL: escape and retry once.
	doc = p.parseFromString(text.replace(/&(?!(?:[a-zA-Z][\w.-]*|#\d+|#x[\da-fA-F]+);)/g, "&amp;"), "application/xml");
	return doc.getElementsByTagName("parsererror").length ? null : doc;
}

// -> {kind, title, siteUrl, items: [{guid, title, link, author, published_at, content}]} or null
function parseFeed(text, base) {
	var t = String(text || "").replace(/^﻿/, "").trim();
	var feed = null;
	if (t.charAt(0) === "{") {
		try { feed = parseJSONFeed(JSON.parse(t), base); } catch (e) { return null; }
	} else if (t.charAt(0) === "<" && !/^(<!--[\s\S]*?-->\s*)*<(!doctype\s+html|html[\s>])/i.test(t)) {
		var doc = parseXML(t);
		if (!doc) return null;
		var root = doc.documentElement, name = root.localName;
		var channel = kid(root, "channel");
		if (name === "rss" && channel) feed = parseRSS(channel, kids(channel, "item"), base, "RSS");
		else if (name === "RDF" && channel) feed = parseRSS(channel, kids(root, "item"), base, "RSS 1.0");
		else if (name === "feed") feed = parseAtom(root, base);
	}
	if (!feed) return null;
	feed.items = feed.items.filter(function (it) { return it.guid; }).map(function (it) {
		if (!it.title) it.title = plain(String(it.content || "").replace(/</g, " <")).slice(0, 90) || "Untitled";
		return it;
	});
	return feed;
}
function rssLink(node, base) {
	var links = kids(node, "link");
	for (var i = 0; i < links.length; i++) if (links[i].textContent.trim()) return absUrl(links[i].textContent.trim(), base);
	return atomLink(node, base);
}
// A podcast's artwork: <itunes:image href> (both it and RSS's own <image>
// have the local name image), else <image><url>.
function rssImage(channel, base) {
	var imgs = kids(channel, "image"), url = "";
	imgs.forEach(function (i) { if (!url && i.getAttribute("href")) url = i.getAttribute("href").trim(); });
	imgs.forEach(function (i) { if (!url && kidText(i, "url")) url = kidText(i, "url"); });
	return url ? absUrl(url, base) : null;
}
function parseRSS(channel, items, base, kind) {
	return {
		kind: kind, title: plain(kidText(channel, "title")), siteUrl: rssLink(channel, base) || base, image: rssImage(channel, base),
		items: items.map(function (it) {
			var link = rssLink(it, base);
			var g = kid(it, "guid"), guid = g ? g.textContent.trim() : "";
			if (!link && guid && g.getAttribute("isPermaLink") !== "false") link = absUrl(guid, base);
			var content = kidText(it, "encoded") || kidText(it, "description") || kidText(it, "summary");
			var media = pickMedia(kids(it, "enclosure").map(function (e) { return { url: e.getAttribute("url"), type: e.getAttribute("type") }; }), base)
				|| videoPage(link);
			return {
				media_url: media && media.url, media_type: media && media.type,
				guid: guid || link || plain(kidText(it, "title")), title: plain(kidText(it, "title")), link: link,
				author: plain(kidText(it, "creator") || kidText(it, "author")),
				published_at: toTime(kidText(it, "pubDate") || kidText(it, "date")), content: content || null
			};
		})
	};
}
function atomLink(node, base) {
	var links = kids(node, "link"), pick = null;
	links.forEach(function (l) {
		var rel = l.getAttribute("rel") || "alternate";
		if (!pick && rel === "alternate") pick = l;
	});
	return pick ? absUrl(pick.getAttribute("href"), base) : null;
}
function atomText(node) { return node ? plain(node.textContent) : ""; }
function atomHTML(node) {
	if (!node || node.getAttribute("src")) return "";
	var type = node.getAttribute("type") || "text";
	if (type === "xhtml") {
		var s = new XMLSerializer(), out = "";
		node.childNodes.forEach(function (c) { out += s.serializeToString(c); });
		return out.trim();
	}
	if (/html/.test(type)) return node.textContent.trim();
	var text = node.textContent.trim();
	return text ? escapeHTML(text).replace(/\n\s*\n/g, "</p><p>").replace(/^/, "<p>") + "</p>" : "";
}
function parseAtom(root, base) {
	return {
		kind: "Atom", title: atomText(kid(root, "title")), siteUrl: atomLink(root, base) || base,
		image: kidText(root, "logo") || kidText(root, "icon") ? absUrl(kidText(root, "logo") || kidText(root, "icon"), base) : null,
		items: kids(root, "entry").map(function (e) {
			var link = atomLink(e, base);
			var who = kid(e, "author") || kid(root, "author");
			var media = pickMedia(kids(e, "link").filter(function (l) { return l.getAttribute("rel") === "enclosure"; })
				.map(function (l) { return { url: l.getAttribute("href"), type: l.getAttribute("type") }; }), base)
				|| videoPage(/^[\w-]{11}$/.test(kidText(e, "videoId")) ? "https://www.youtube.com/watch?v=" + kidText(e, "videoId") : link);
			return {
				guid: kidText(e, "id") || link || "", title: atomText(kid(e, "title")), link: link,
				author: who ? plain(kidText(who, "name")) : "",
				published_at: toTime(kidText(e, "published") || kidText(e, "updated")),
				content: atomHTML(kid(e, "content")) || atomHTML(kid(e, "summary")) || youTubeEntry(e) || null,
				media_url: media && media.url, media_type: media && media.type
			};
		})
	};
}
// A podcast episode's audio (or video) file: the first enclosure that is one.
function pickMedia(files, base) {
	var f = files.filter(function (x) { return /^(audio|video)\//i.test(x.type || "") && absUrl(x.url, base); })[0];
	return f ? { url: absUrl(f.url, base), type: f.type.toLowerCase() } : null;
}
// An entry that is itself a YouTube, Twitch or Vimeo video (a channel's
// feed) goes in Videos. Stored as the video's page, with a made-up type
// saying whose player it needs.
function videoPage(link) {
	var u;
	try { u = new URL(link); } catch (e) { return null; }
	var host = u.hostname.replace(/^(www|m)\./, ""), path = u.pathname, m, id;
	if (host === "youtube.com") {
		m = /^\/(?:shorts|live)\/([\w-]{11})/.exec(path);
		id = m ? m[1] : path === "/watch" ? u.searchParams.get("v") : null;
	} else if (host === "youtu.be" && (m = /^\/([\w-]{11})/.exec(path))) id = m[1];
	if (id && /^[\w-]{11}$/.test(id)) return { url: "https://www.youtube.com/watch?v=" + id, type: "video/x-youtube" };
	if (host === "twitch.tv" && (m = /^\/(?:\w+\/)?videos\/(\d+)\/?$/.exec(path))) return { url: "https://www.twitch.tv/videos/" + m[1], type: "video/x-twitch" };
	if (host === "twitch.tv" && (m = /^\/\w+\/clip\/([\w-]+)\/?$/.exec(path))) return { url: "https://clips.twitch.tv/" + m[1], type: "video/x-twitch" };
	if (host === "clips.twitch.tv" && (m = /^\/([\w-]+)\/?$/.exec(path))) return { url: "https://clips.twitch.tv/" + m[1], type: "video/x-twitch" };
	if (host === "twitch.tv" && (m = /^\/(\w{3,25})\/?$/.exec(path)) && !/^(videos|directory|p|search|settings|downloads|jobs|turbo)$/.test(m[1]))
		return { url: "https://www.twitch.tv/" + m[1], type: "video/x-twitch" };
	if (host === "vimeo.com" && (m = /^\/(\d+)(?:\/(\w+))?\/?$/.exec(path))) return { url: "https://vimeo.com/" + m[1] + (m[2] ? "/" + m[2] : ""), type: "video/x-vimeo" };
	return null;
}
// YouTube channel feeds carry the video id and description, not HTML.
function youTubeEntry(e) {
	var id = kidText(e, "videoId");
	if (!/^[\w-]{11}$/.test(id)) return "";
	var desc = kidText(kid(e, "group"), "description");
	return '<iframe src="https://www.youtube.com/embed/' + id + '"></iframe>' +
		(desc ? "<p>" + escapeHTML(desc).replace(/\n\s*\n/g, "</p><p>").replace(/\n/g, "<br>") + "</p>" : "");
}
function parseJSONFeed(j, base) {
	if (!j || !/jsonfeed\.org\/version/.test(String(j.version)) || !Array.isArray(j.items)) return null;
	return {
		kind: "JSON Feed", title: plain(j.title), siteUrl: absUrl(j.home_page_url, base) || base,
		items: j.items.map(function (it) {
			var link = absUrl(it.url || it.external_url, base);
			var content = typeof it.content_html === "string" ? it.content_html
				: typeof it.content_text === "string" ? "<p>" + escapeHTML(it.content_text).replace(/\n\s*\n/g, "</p><p>") + "</p>"
				: typeof it.summary === "string" ? "<p>" + escapeHTML(it.summary) + "</p>" : "";
			var who = (Array.isArray(it.authors) && it.authors[0]) || it.author;
			var media = pickMedia((Array.isArray(it.attachments) ? it.attachments : []).map(function (a) {
				return { url: a && a.url, type: a && typeof a.mime_type === "string" ? a.mime_type : "" };
			}), base) || videoPage(link);
			return {
				media_url: media && media.url, media_type: media && media.type,
				guid: it.id != null ? String(it.id) : link || "", title: plain(it.title), link: link,
				author: who && who.name ? plain(who.name) : "",
				published_at: toTime(it.date_published || it.date_modified), content: content || null
			};
		})
	};
}

// Add-a-URL: is it a feed? does the page point to one? is there one at a
// usual address? If none of that, watch the page itself.
var COMMON_FEED_PATHS = ["/feed", "/feed/", "/rss", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml", "/feed.json"];

async function discover(input) {
	var url = /^https?:\/\//i.test(input) ? input : "https://" + input.replace(/^\/+/, "");
	var page = await proxyGet(url);
	var feed = parseFeed(page.text, page.url);
	if (feed) return found(feed, page.url, url);

	var doc = parseHTML(page.text), base = baseOf(doc, page.url), cands = [];
	doc.querySelectorAll("link[rel][href]").forEach(function (l) {
		var rel = " " + l.getAttribute("rel").toLowerCase() + " ";
		var type = (l.getAttribute("type") || "").toLowerCase().split(";")[0].trim();
		var href = absUrl(l.getAttribute("href"), base);
		if (!href || rel.indexOf(" alternate ") < 0) return;
		if (!/^application\/(rss\+xml|atom\+xml|feed\+json|rdf\+xml)$/.test(type) && !(type === "application/json" && /feed/i.test(href))) return;
		cands.push({ href: href, comments: /comment/i.test((l.getAttribute("title") || "") + " " + href) ? 1 : 0 });
	});
	cands.sort(function (a, b) { return a.comments - b.comments; });
	for (var i = 0; i < cands.length; i++) {
		var r = await tryFeed(cands[i].href, url);
		if (r) return r;
	}
	var origin = new URL(page.url).origin;
	var tries = await Promise.all(COMMON_FEED_PATHS.map(function (p) { return tryFeed(origin + p, url); }));
	for (var j = 0; j < tries.length; j++) if (tries[j]) return tries[j];

	var s = scrape(page.text, page.url);
	return { mode: "scrape", url: url, feed_url: null, title: s.title || hostOf(page.url), site_url: page.url, kind: "page", items: s.items };
}
async function tryFeed(feedUrl, typed) {
	try {
		var r = await proxyGet(feedUrl);
		var f = parseFeed(r.text, r.url);
		return f ? found(f, r.url, typed) : null;
	} catch (e) {
		if (e.message === UNAUTH) throw e;
		return null;
	}
}
function found(feed, feedUrl, typed) {
	return { mode: "feed", url: typed, feed_url: feedUrl, title: feed.title || hostOf(feed.siteUrl), site_url: feed.siteUrl, kind: feed.kind, image: feed.image || null, items: feed.items };
}

// Scrape mode: likely article links on a page with no feed.
var SKIP_PATH = /\/(tags?|categor(y|ies)|topics?|page|author|authors|users?|login|log-in|signin|sign-in|signup|sign-up|register|account|search|feed|rss|about|contact|privacy|terms|subscribe|archives?|cart|wp-login\.php)(\/|$|\.)/i;
var SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|pdf|zip|xml|json|mp3|mp4|css|js)$/i;
var NOISE = /^(nav|navbar|navigation|menu|sidebar|footer|site-footer|breadcrumbs?|share|sharing|social|pagination|pager|comments?|related|related-posts|promo|newsletter|cookie-banner)$/i;

function noisy(node) {
	for (var n = node; n && n.localName !== "body"; n = n.parentElement) {
		var words = ((n.getAttribute("class") || "") + " " + (n.id || "")).split(/\s+/);
		for (var i = 0; i < words.length; i++) if (words[i] && NOISE.test(words[i])) return true;
	}
	return false;
}
function scrape(html, pageUrl) {
	var doc = parseHTML(html), base = baseOf(doc, pageUrl), page = new URL(pageUrl);
	var host = page.hostname.replace(/^www\./, "");
	var self = (page.origin + page.pathname).replace(/\/$/, "") + page.search;
	var byUrl = {}, list = [];
	doc.querySelectorAll("a[href]").forEach(function (a) {
		if (a.closest("nav, aside, form, [role=navigation], [role=complementary]")) return;
		// The page's own header/footer, but not the header of an <article>.
		var hf = a.closest("header, footer, [role=banner], [role=contentinfo]");
		if (hf && !(hf.parentElement && hf.parentElement.closest("article, main, [role=main]"))) return;
		if (noisy(a)) return;
		var raw = a.getAttribute("href").trim();
		if (!raw || raw.charAt(0) === "#" || /^(mailto|tel|sms|javascript):/i.test(raw)) return;
		var u;
		try { u = new URL(raw, base); } catch (e) { return; }
		if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, "") !== host) return;
		u.hash = "";
		var key = (u.origin + u.pathname).replace(/\/$/, "") + u.search;
		if (key === self || (u.pathname === "/" && !u.search)) return;
		if (SKIP_PATH.test(u.pathname) || SKIP_EXT.test(u.pathname) || /[?&](page|replytocom|share)=/i.test(u.search)) return;
		var heading = a.closest("h1, h2, h3") || a.querySelector("h1, h2, h3");
		var text = plain((heading || a).textContent) || plain(a.getAttribute("title") || a.getAttribute("aria-label") || "");
		if (text.length < 15) return;
		var score = (heading ? 3 : 0) + (a.closest("article") ? 2 : 0) + (a.closest("main, [role=main]") ? 1 : 0);
		var prev = byUrl[key];
		if (prev) {
			if (score > prev.score) { prev.score = score; prev.title = text; }
			return;
		}
		var box = a.closest("article, li"), time = box && box.querySelector("time[datetime]");
		byUrl[key] = { guid: u.href, link: u.href, title: text, score: score, published_at: time ? toTime(time.getAttribute("datetime")) : null, content: null };
		list.push(byUrl[key]);
	});
	var strong = list.filter(function (x) { return x.score > 0; });
	if (strong.length >= 3) list = strong;
	return {
		title: plain(doc.title),
		items: list.slice(0, 50).map(function (x) { return { guid: x.guid, link: x.link, title: x.title, published_at: x.published_at, content: null }; })
	};
}

// Readability-lite: find the article on a page.
function textLen(n) { return (n.textContent || "").replace(/\s+/g, " ").trim().length; }
function extract(html, url) {
	var doc = parseHTML(html), base = baseOf(doc, url);
	var videos = pageVideos(doc, base);
	// Embed scripts that stand for a chart (Datawrapper's) become a marker the sanitizer turns into the chart.
	doc.querySelectorAll("script[src]").forEach(function (sc) {
		var id = dwId(sc.getAttribute("src"));
		if (id) { var m = doc.createElement("iframe"); m.setAttribute("src", "https://datawrapper.dwcdn.net/" + id + "/"); sc.replaceWith(m); }
	});
	doc.querySelectorAll("script, style, noscript, template, nav, header, footer, aside, form, button, dialog, [hidden], [aria-hidden=true]")
		.forEach(function (n) { n.remove(); });
	var root = pickRoot(doc);
	root.querySelectorAll("div, section, ul").forEach(function (n) {
		var words = ((n.getAttribute("class") || "") + " " + (n.id || "")).split(/\s+/);
		if (words.some(function (w) { return w && NOISE.test(w); })) n.remove();
	});
	var html = root.innerHTML;
	// The page's own video (from its structured data), when the text has no player.
	var hasVideo = root.querySelector("video") || [].some.call(root.querySelectorAll("iframe[src]"), function (f) {
		var pl = embedSrc(absUrl(f.getAttribute("src"), base) || "");
		return pl && pl.kind === "video";
	});
	if (videos.length && !hasVideo) html = videos.join("") + html;
	return { html: html, base: base };
}
// Videos a page declares in its JSON-LD (VideoObject: embedUrl or
// contentUrl), as markup the sanitizer then vets like any other.
function pageVideos(doc, base) {
	var out = [], seen = {};
	function walk(x, depth) {
		if (!x || typeof x !== "object" || depth > 6 || out.length >= 3) return;
		if (Array.isArray(x)) { x.forEach(function (y) { walk(y, depth + 1); }); return; }
		var type = [].concat(x["@type"] || []).join(" ");
		if (/VideoObject/.test(type)) {
			var embed = typeof x.embedUrl === "string" && absUrl(x.embedUrl, base);
			var file = typeof x.contentUrl === "string" && absUrl(x.contentUrl, base);
			var thumb = [].concat(x.thumbnailUrl || [])[0];
			var key = embed || file;
			if (key && !seen[key]) {
				seen[key] = 1;
				if (embed && embedSrc(embed)) out.push('<iframe src="' + escapeHTML(embed) + '"></iframe>');
				else if (file) out.push('<video src="' + escapeHTML(file) + '"' + (typeof thumb === "string" ? ' poster="' + escapeHTML(thumb) + '"' : "") + "></video>");
			}
		}
		Object.keys(x).forEach(function (k) { if (k !== "@context") walk(x[k], depth + 1); });
	}
	doc.querySelectorAll('script[type="application/ld+json"]').forEach(function (sc) {
		try { walk(JSON.parse(sc.textContent), 0); } catch (e) {}
	});
	return out;
}
function dwId(src) {
	var m = /^https:\/\/datawrapper\.dwcdn\.net\/(\w{5})\/(?:\d+\/)?embed\.js/.exec(String(src || ""));
	return m ? m[1] : null;
}
function pickRoot(doc) {
	var best = null, bestLen = 0;
	doc.querySelectorAll("article").forEach(function (a) { var L = textLen(a); if (L > bestLen) { best = a; bestLen = L; } });
	if (best && bestLen > 250) return best;
	var main = doc.querySelector("main, [role=main]");
	if (main && textLen(main) > 250) return main;
	// Otherwise: the element holding the most paragraph text (half credit to grandparents).
	var scores = new Map(), top = null, topScore = 0;
	doc.querySelectorAll("p, pre, blockquote").forEach(function (p) {
		var L = textLen(p);
		if (L < 25) return;
		[p.parentElement, p.parentElement && p.parentElement.parentElement].forEach(function (n, i) {
			if (!n) return;
			var v = (scores.get(n) || 0) + (i ? L / 2 : L);
			scores.set(n, v);
			if (v > topScore) { topScore = v; top = n; }
		});
	});
	return top || main || best || doc.body;
}

// ---------- sanitizer: rebuild untrusted HTML from an allow-list

var ALLOWED = {
	p: [], a: ["href", "title"], em: [], strong: [], b: [], i: [], u: [], s: [], blockquote: [], pre: [], code: [],
	ul: [], ol: ["start"], li: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
	img: ["src", "alt", "title", "width", "height"], figure: [], figcaption: [],
	table: [], caption: [], thead: [], tbody: [], tfoot: [], tr: [], th: ["colspan", "rowspan"], td: ["colspan", "rowspan"],
	hr: [], br: [], sup: [], sub: [], span: [], div: [],
	dl: [], dt: [], dd: [], small: [], mark: [], cite: [], abbr: ["title"], q: [], del: [], ins: [], kbd: []
};
// Dropped with everything inside them. Anything else not in ALLOWED is
// unwrapped (its children kept), e.g. <font>, <picture>, <time>.
var DROP = /^(script|style|noscript|template|iframe|frame|frameset|object|embed|applet|form|input|button|select|option|textarea|svg|math|canvas|video|audio|source|track|link|meta|base|title|head|dialog|slot|portal|map|area)$/;
var AS_DIV = /^(section|article|main|header|footer|aside|center|details|summary|address|hgroup)$/;

function sanitize(html, base) {
	var out = document.createDocumentFragment();
	cleanInto(parseHTML(String(html || "")).body, out, base, 0);
	return out;
}
function cleanInto(from, to, base, depth) {
	if (depth > 100) return;
	for (var n = from.firstChild; n; n = n.nextSibling) {
		if (n.nodeType === 3) { if (!SLIDE_COUNT.test(n.data) && !/^\s*\|\s*$/.test(n.data)) to.appendChild(document.createTextNode(n.data)); continue; }
		if (n.nodeType !== 1) continue;
		var tag = n.localName;
		if (tag === "iframe") { embedLink(n, to, base); continue; }
		if (tag === "video" || tag === "audio") { mediaInto(n, to, base); continue; }
		if (tag === "svg") { svgChart(n, to); continue; }
		if (tag === "script") { var dw = dwId(n.getAttribute("src")); if (dw) to.appendChild(playerFrame({ src: "https://datawrapper.dwcdn.net/" + dw + "/", kind: "chart" })); continue; }
		if (DROP.test(tag)) continue;
		if (shareJunk(n)) continue;
		if (bareEmbed(n, to) || widgetEmbed(n, to)) continue;
		if (AS_DIV.test(tag)) tag = "div";
		var allowed = ALLOWED[tag];
		if (!allowed) { cleanInto(n, to, base, depth + 1); continue; }
		var e = document.createElement(tag);
		if (tag === "img") {
			// Set before src, so nothing is requested until it's near the screen.
			e.setAttribute("loading", "lazy");
			e.setAttribute("decoding", "async");
			e.setAttribute("referrerpolicy", "no-referrer");
		}
		for (var i = 0; i < allowed.length; i++) {
			var name = allowed[i];
			var v = tag === "img" && name === "src" ? lazySrc(n) : n.getAttribute(name);
			if (v == null) continue;
			if (name === "href" || name === "src") { v = absUrl(v, base); if (!v) continue; }
			else if (/^(width|height|colspan|rowspan|start)$/.test(name) && !/^\d{1,5}$/.test(v.trim())) continue;
			e.setAttribute(name, v.slice(0, 2000));
		}
		if (tag === "img" && (!e.hasAttribute("src") || iconImg(e))) continue;
		if (tag === "a" && e.hasAttribute("href")) { e.setAttribute("target", "_blank"); e.setAttribute("rel", "noopener noreferrer"); }
		if (tag === "blockquote") { var bsky = bskyUri(n); if (bsky) { e.className = "bsky"; e.setAttribute("data-bsky", bsky); } }
		cleanInto(n, e, base, depth + 1);
		if (tag === "a" && shareLink(e.getAttribute("href"))) continue;
		if (galleryJunk(e, n)) continue;
		if ((tag === "ul" || tag === "ol") && shareList(e)) { dropShareLabel(to); continue; }
		to.appendChild(e);
	}
}
// An image's real address. Carousels and lazy loaders keep it in a data-
// attribute or a srcset until the slide is shown (AP's galleries use
// Flickity's data-flickity-lazyload), or only on the <picture>'s sources.
function lazySrc(img) {
	var c = ["data-flickity-lazyload", "data-flickity-lazyload-src", "data-src", "data-original", "data-lazy-src", "data-lazy", "src"], i, v;
	for (i = 0; i < c.length; i++) {
		v = img.getAttribute(c[i]);
		if (v && !/^\s*data:/i.test(v)) return v;
	}
	var sets = [img], pic = img.parentElement;
	if (pic && pic.localName === "picture") [].forEach.call(pic.children, function (s) { if (s.localName === "source") sets.push(s); });
	for (i = 0; i < sets.length; i++) {
		v = srcsetPick(sets[i].getAttribute("data-flickity-lazyload-srcset") || sets[i].getAttribute("data-srcset") ||
			sets[i].getAttribute("data-lazy-srcset") || sets[i].getAttribute("srcset"));
		if (v) return v;
	}
	return null;
}
// From a srcset, the widest candidate up to 1600px (else the narrowest), or the 1x one.
function srcsetPick(set) {
	var best = null, bestW = 0, small = null, smallW = Infinity;
	String(set || "").split(/,\s+/).forEach(function (part) {
		var m = /^\s*(\S+?),?(?:\s+([\d.]+)([wx]))?\s*$/.exec(part);
		if (!m || /^data:/i.test(m[1])) return;
		var w = m[3] === "w" ? +m[2] : m[3] === "x" ? +m[2] * 800 : 800;
		if (w <= 1600 && w > bestW) { best = m[1]; bestW = w; }
		if (w < smallW) { small = m[1]; smallW = w; }
	});
	return best || small;
}
// Gallery leftovers that mean nothing without the carousel: "2 of 5 |"
// counters and AP's "License this photo" links.
// A bare "3 of 5" counts only with the bar or a counter-ish class, so
// "<strong>3 of 5</strong> voters" stays.
var SLIDE_COUNT = /^\s*\d{1,3}\s+of\s+\d{1,3}\s*\|\s*$/i;
function galleryJunk(e, from) {
	if (e.querySelector("img, iframe, video, audio, svg")) return false;
	var t = e.textContent || "";
	return SLIDE_COUNT.test(t) || (/^\s*\d{1,3}\s+of\s+\d{1,3}\s*$/.test(t) && /count|number|index|pager|slide/i.test(from.getAttribute("class") || "")) ||
		(e.localName === "a" && /^\s*license this (photo|image|picture|video)\s*$/i.test(t));
}
function embedLink(frame, to, base) {
	var src = absUrl(frame.getAttribute("src") || frame.getAttribute("data-src"), base);
	if (!src) return;
	var player = embedSrc(src);
	if (player) { to.appendChild(playerFrame(player, frame.getAttribute("height"))); return; }
	var p = document.createElement("p"), a = document.createElement("a");
	p.className = "embed";
	a.href = src; a.target = "_blank"; a.rel = "noopener noreferrer";
	a.textContent = "Embedded content: " + hostOf(src) + " ↗";
	p.appendChild(a);
	to.appendChild(p);
}


// ---------- embeds
// Video and audio players from a short list of sites play in the article;
// any other embedded page stays a link. embedSrc turns a player or page
// address into the player's, or null. EMBED_HOSTS (Worker side) is the
// same list, for the page's frame-src.
function embedSrc(url) {
	var u;
	try { u = new URL(url); } catch (e) { return null; }
	if (u.protocol !== "https:" && u.protocol !== "http:") return null;
	var host = u.hostname.replace(/^(www|m)\./, ""), path = u.pathname, m;
	if (host === "youtube.com" || host === "youtube-nocookie.com") {
		m = /^\/(?:embed|shorts|live)\/([\w-]{11})/.exec(path);
		var id = m ? m[1] : path === "/watch" ? u.searchParams.get("v") : null;
		return id && /^[\w-]{11}$/.test(id) ? { src: "https://www.youtube.com/embed/" + id + ytStart(u), kind: "video" } : null;
	}
	if (host === "youtu.be") {
		m = /^\/([\w-]{11})/.exec(path);
		return m ? { src: "https://www.youtube.com/embed/" + m[1] + ytStart(u), kind: "video" } : null;
	}
	if (host === "player.vimeo.com" && /^\/video\/\d+/.test(path)) return { src: "https://player.vimeo.com" + path + u.search, kind: "video" };
	if (host === "vimeo.com" && (m = /^\/(\d+)(?:\/(\w+))?\/?$/.exec(path)))
		return { src: "https://player.vimeo.com/video/" + m[1] + (m[2] ? "?h=" + m[2] : ""), kind: "video" };
	if (host === "open.spotify.com" && (m = /^\/(?:embed\/)?(track|album|playlist|episode|show|artist)\/(\w+)/.exec(path)))
		return { src: "https://open.spotify.com/embed/" + m[1] + "/" + m[2], kind: /^(track|episode)$/.test(m[1]) ? "short" : "audio" };
	if (host === "w.soundcloud.com" && path.indexOf("/player") === 0) return { src: "https://w.soundcloud.com" + path + u.search, kind: "short" };
	if (host === "bandcamp.com" && path.indexOf("/EmbeddedPlayer") === 0) return { src: "https://bandcamp.com" + path + u.search, kind: "short" };
	if (host === "embed.podcasts.apple.com" || host === "embed.music.apple.com") return { src: "https://" + host + path + u.search, kind: "audio" };
	if (host === "cdn.jwplayer.com" && (m = /^\/players\/(\w{8}(?:-\w{8})?)\.(?:html|js)$/.exec(path))) return { src: "https://cdn.jwplayer.com/players/" + m[1] + ".html", kind: "video" };
	if (host === "datawrapper.dwcdn.net" && (m = /^\/(\w{5})\//.exec(path))) return { src: "https://datawrapper.dwcdn.net/" + m[1] + "/", kind: "chart" };
	if ((host === "flo.uri.sh" || host === "public.flourish.studio") && (m = /^\/(visualisation|story)\/(\d+)/.exec(path)))
		return { src: "https://flo.uri.sh/" + m[1] + "/" + m[2] + "/embed", kind: "chart" };
	return null;
}
function ytStart(u) {
	var t = u.searchParams.get("start") || u.searchParams.get("t") || "";
	var m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t), sec = m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
	return sec ? "?start=" + sec : "";
}
function playerFrame(player, height) {
	var box = document.createElement("div"), f = document.createElement("iframe");
	box.className = "player " + player.kind;
	f.setAttribute("loading", "lazy");
	f.setAttribute("allow", "encrypted-media; picture-in-picture; fullscreen");
	f.setAttribute("allowfullscreen", "");
	// Its own origin, but no top-level navigation of this page.
	f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-presentation");
	// YouTube refuses to play without knowing which site embeds it.
	f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
	var hgt = Number(height);
	if (player.kind !== "video" && hgt >= 80 && hgt <= (player.kind === "chart" ? 1600 : 600)) f.style.height = hgt + "px";
	f.src = player.src;
	box.appendChild(f);
	return box;
}
// WordPress sometimes leaves a bare player address in its embed wrapper
// instead of the iframe.
function bareEmbed(n, to) {
	if (!/\bwp-block-embed\b/.test(n.getAttribute("class") || "") || n.querySelector("iframe")) return false;
	var player = embedSrc((n.textContent || "").trim().split(/\s+/)[0]);
	if (!player) return false;
	to.appendChild(playerFrame(player));
	return true;
}
// Chart and player widgets that are a placeholder plus a script: Flourish's
// div, Datawrapper's div, and JW Player's element with a media id.
function widgetEmbed(n, to) {
	var cls = n.getAttribute("class") || "", ds = n.getAttribute("data-src") || "", m;
	if (/\bflourish-embed\b/.test(cls) && (m = /^(visualisation|story)\/(\d+)/.exec(ds))) {
		to.appendChild(playerFrame({ src: "https://flo.uri.sh/" + m[1] + "/" + m[2] + "/embed", kind: "chart" }));
		return true;
	}
	if ((m = /^datawrapper-vis-(\w{5})$/.exec(n.id || ""))) {
		var mh = /min-height:\s*(\d+)px/.exec(n.getAttribute("style") || "");
		to.appendChild(playerFrame({ src: "https://datawrapper.dwcdn.net/" + m[1] + "/", kind: "chart" }, mh && mh[1]));
		return true;
	}
	var media = n.getAttribute("data-media-id") || n.getAttribute("data-mediaid") || "";
	var jw = /jw-?player/i.test(n.localName + " " + cls) && /^\w{8}$/.test(media) ? media : null;
	if (jw) {
		var pl = n.getAttribute("data-player-id") || n.getAttribute("data-playerid") || "";
		to.appendChild(playerFrame({ src: "https://cdn.jwplayer.com/players/" + jw + (/^\w{8}$/.test(pl) ? "-" + pl : "") + ".html", kind: "video" }));
		return true;
	}
	return false;
}

// Charts drawn as inline SVG keep their shapes and text, rebuilt from an
// allow-list like everything else (no scripts, links, styles or external
// references). Small ones are icons and are dropped.
var SVG_NS = "http://www.w3.org/2000/svg";
var SVG_TAGS = /^(svg|g|path|rect|circle|ellipse|line|polyline|polygon|text|tspan|title|desc)$/;
var SVG_ATTRS = ["viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "transform",
	"fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity",
	"font-size", "font-weight", "text-anchor", "dominant-baseline", "dx", "dy", "preserveAspectRatio"];
var SVG_STYLE = /^(fill|stroke|stroke-width|stroke-dasharray|opacity|fill-opacity|stroke-opacity|font-size|font-weight|text-anchor)$/;
function svgSize(n) {
	var vb = (n.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
	var w = parseFloat(n.getAttribute("width")) || (vb.length === 4 ? vb[2] : 0), hgt = parseFloat(n.getAttribute("height")) || (vb.length === 4 ? vb[3] : 0);
	return { w: w, h: hgt };
}
function svgChart(n, to) {
	var size = svgSize(n);
	if (size.w < 200 || size.h < 100) return;
	var out = svgCopy(n, 0);
	if (!out || !out.querySelector("path, rect, circle, line, polyline, polygon")) return;
	out.setAttribute("class", "chart");
	if (!out.getAttribute("viewBox") && size.w && size.h) out.setAttribute("viewBox", "0 0 " + size.w + " " + size.h);
	out.removeAttribute("height");
	to.appendChild(out);
}
function svgCopy(n, depth) {
	var tag = n.localName;
	if (depth > 40 || !SVG_TAGS.test(tag)) return null;
	var e = document.createElementNS(SVG_NS, tag);
	SVG_ATTRS.forEach(function (a) {
		var v = n.getAttribute(a);
		if (v != null && svgValueOk(v)) e.setAttribute(a, v.slice(0, 20000));
	});
	(n.getAttribute("style") || "").split(";").forEach(function (decl) {
		var i = decl.indexOf(":"), k = decl.slice(0, i).trim().toLowerCase(), v = decl.slice(i + 1).trim();
		if (i > 0 && SVG_STYLE.test(k) && !e.hasAttribute(k) && svgValueOk(v) && v.length < 60) e.setAttribute(k, v);
	});
	for (var c = n.firstChild; c; c = c.nextSibling) {
		if (c.nodeType === 3 && /^(text|tspan|title|desc)$/.test(tag)) e.appendChild(document.createTextNode(c.data));
		else if (c.nodeType === 1) { var k2 = svgCopy(c, depth + 1); if (k2) e.appendChild(k2); }
	}
	return e;
}
function svgValueOk(v) { return !/url\(|javascript:|expression|[<>"]/i.test(v); }

// Sites' own share menus, social buttons and icons, which only make sense
// with their scripts: dropped. (The reader has its own Share button.)
var SHARE_WORD = /(^|[-_])(share|sharing|shares|social|socials|addtoany|a2a|sharedaddy|sharethis|page-?actions|print-?button|copy-?link)([-_]|$)/i;
var SHARE_NAMES = /^(share( on| to| via)?\s*)?(facebook|twitter|x|linkedin|bluesky|threads|mastodon|reddit|pinterest|flipboard|tumblr|whatsapp|telegram|pocket|email|e-mail|mail|print|copy|copy link|link copied|copied|sms|messenger|more|share)$/i;
function shareJunk(n) {
	var words = ((n.getAttribute("class") || "") + " " + (n.id || "")).split(/\s+/);
	if (!words.some(function (w) { return w && SHARE_WORD.test(w); })) return false;
	// Only small blocks: a "share" class on a whole article wrapper is not a menu.
	return (n.textContent || "").replace(/\s+/g, " ").trim().length < 300;
}
function shareLink(href) {
	return /^(https?:\/\/([\w-]+\.)?(facebook\.com\/sharer|twitter\.com\/(intent|share)|x\.com\/(intent|share)|linkedin\.com\/(sharearticle|shareArticle|share)|reddit\.com\/submit|pinterest\.com\/pin\/create|bsky\.app\/intent|share\.flipboard\.com|flipboard\.com\/bookmarklet|api\.whatsapp\.com\/send|wa\.me\/|t\.me\/share|tumblr\.com\/widgets\/share|threads\.net\/intent|mastodonshare\.com)|mailto:\?)/i.test(href || "");
}
// A list whose entries are mostly share targets ("Facebook", "Copy", "Print", …).
function shareList(list) {
	var items = [].filter.call(list.children, function (li) { return li.localName === "li"; });
	if (items.length < 3) return false;
	var hits = items.filter(function (li) {
		var t = (li.textContent || "").replace(/\s+/g, " ").trim();
		var a = li.querySelector("a[href]");
		return !t || SHARE_NAMES.test(t) || /^(copy|link copied)/i.test(t) || (a && shareLink(a.getAttribute("href")));
	}).length;
	return hits / items.length >= 0.7;
}
// The "Share" label just before a dropped share list.
function dropShareLabel(to) {
	var prev = to.lastChild;
	while (prev && prev.nodeType === 3 && !prev.data.trim()) prev = prev.previousSibling;
	if (prev && /^\s*share( this( article| story)?)?:?\s*$/i.test(prev.textContent || "")) prev.remove();
}
// Icons and tracking pixels: tiny declared sizes, or an SVG file with no real size.
function iconImg(img) {
	var w = Number(img.getAttribute("width")), hgt = Number(img.getAttribute("height"));
	if ((w && w <= 40) || (hgt && hgt <= 40)) return true;
	return /\.svg(\?|#|$)/i.test(img.getAttribute("src") || "") && !(w >= 120);
}

// <video>/<audio>, rebuilt: controls on, nothing plays or downloads until tapped.
function mediaInto(n, to, base) {
	var tag = n.localName, srcs = [], own = absUrl(n.getAttribute("src") || n.getAttribute("data-src"), base);
	if (own) srcs.push({ src: own, type: n.getAttribute("type") });
	n.querySelectorAll("source").forEach(function (x) {
		var u = absUrl(x.getAttribute("src"), base);
		if (u) srcs.push({ src: u, type: x.getAttribute("type") });
	});
	if (!srcs.length) return;
	var e = document.createElement(tag);
	e.controls = true;
	e.preload = tag === "video" ? "metadata" : "none";
	e.setAttribute("playsinline", "");
	var poster = tag === "video" && absUrl(n.getAttribute("poster"), base);
	if (poster) e.setAttribute("poster", poster);
	srcs.forEach(function (x) {
		var s = document.createElement("source");
		s.src = x.src;
		if (/^(audio|video|application)\/[\w.+-]+$/i.test(x.type || "")) s.type = x.type;
		e.appendChild(s);
	});
	var a = document.createElement("a");
	a.href = srcs[0].src; a.target = "_blank"; a.rel = "noopener noreferrer";
	a.textContent = "Open the " + tag + " file ↗";
	e.appendChild(a);
	to.appendChild(e);
}

// Bluesky's embed code is a quote of the post's text plus a script, which
// never runs here, so any picture, video or link card in the post is
// missing. The quote keeps the post's address (data-bsky) and, once it's on
// screen, Bluesky's public API fills those in.
var BSKY_URI = /^at:\/\/[\w.:%-]+\/app\.bsky\.feed\.post\/[\w~.-]+$/;
function bskyUri(n) {
	var v = n.getAttribute("data-bsky") || n.getAttribute("data-bluesky-uri");
	if (v && BSKY_URI.test(v)) return v;
	if (!/\bbluesky-embed\b/.test(n.getAttribute("class") || "")) return null;
	var links = n.querySelectorAll("a[href]");
	for (var i = 0; i < links.length; i++) {
		var m = /^https:\/\/bsky\.app\/profile\/([\w.:%-]+)\/post\/([\w~.-]+)/.exec(links[i].getAttribute("href"));
		if (m) return "at://" + m[1] + "/app.bsky.feed.post/" + m[2];
	}
	return null;
}
function enhanceEmbeds(root) {
	root.querySelectorAll("blockquote[data-bsky]").forEach(function (q) { bskyFill(q).catch(function () {}); });
	root.querySelectorAll("video").forEach(function (v) { fixVideo(v); });
}
// HLS streams play natively only in Safari; elsewhere hls.js plays them.
// Any video that still can't play is swapped for a link to the original.
var NATIVE_HLS = !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl");
function isHls(url, type) { return /\.m3u8(\?|#|$)/i.test(url || "") || /mpegurl/i.test(type || ""); }
function fixVideo(v, link) {
	if (v.dataset.fixed) return;
	v.dataset.fixed = "1";
	link = link || (state.item && state.item.link);
	var sources = [].slice.call(v.querySelectorAll("source"));
	var failed = function () { videoFailed(v, link); };
	sources.length ? sources[sources.length - 1].addEventListener("error", failed) : v.addEventListener("error", failed);
	var hls = sources.filter(function (s) { return isHls(s.src, s.type); })[0] || (isHls(v.src) ? { src: v.src } : null);
	if (!hls || NATIVE_HLS) return;
	var url = hls.src;
	sources.forEach(function (s) { s.remove(); });
	v.removeAttribute("src");
	loadHlsJs().then(function (Hls) {
		if (!Hls || !Hls.isSupported()) return failed();
		var player = new Hls();
		player.on(Hls.Events.ERROR, function (e, d) { if (d && d.fatal) { player.destroy(); failed(); } });
		player.loadSource(url);
		player.attachMedia(v);
	}).catch(failed);
}
var hlsLoading = null;
function loadHlsJs() {
	if (window.Hls) return Promise.resolve(window.Hls);
	if (!hlsLoading) hlsLoading = new Promise(function (resolve, reject) {
		var sc = document.createElement("script");
		sc.src = HLSJS.src;
		sc.integrity = HLSJS.integrity;
		sc.crossOrigin = "anonymous";
		sc.onload = function () { resolve(window.Hls); };
		sc.onerror = function () { hlsLoading = null; reject(new Error("hls.js didn't load")); };
		document.head.appendChild(sc);
	});
	return hlsLoading;
}
function videoFailed(v, link) {
	if (!v.isConnected || v.dataset.failed) return;
	v.dataset.failed = "1";
	var p = h("p", "embed");
	var a = h("a", "", "This video won't play here. Watch it on the original ↗");
	a.href = link || "#"; a.target = "_blank"; a.rel = "noopener noreferrer";
	p.append(a);
	v.after(p);
	v.remove();
}
async function bskyFill(q) {
	var res = await fetch("https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?depth=0&parentHeight=0&uri=" +
		encodeURIComponent(q.getAttribute("data-bsky")), { credentials: "omit", referrerPolicy: "no-referrer" });
	if (!res.ok) return;
	var data = await res.json(), post = data.thread && data.thread.post;
	if (!post || !q.isConnected || q.querySelector(".bsky-media")) return;
	var box = h("div", "bsky-media");
	bskyEmbed(post.embed, box, 0, postUrl(post));
	if (!box.firstChild) return;
	// The embed code's stand-in for what's now shown.
	q.querySelectorAll("a").forEach(function (a) { if (/^\[image or embed\]$/.test(a.textContent.trim())) a.remove(); });
	q.append(box);
}
function postUrl(p) {
	var m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(p.uri || "");
	return m ? "https://bsky.app/profile/" + m[1] + "/post/" + m[2] : "https://bsky.app/";
}
function httpsUrl(u) { return typeof u === "string" && /^https:\/\//.test(u) ? u : null; }
function bskyEmbed(v, to, depth, link) {
	if (!v || depth > 2) return;
	var t = String(v.$type || "");
	if (t === "app.bsky.embed.images#view") {
		(v.images || []).forEach(function (im) {
			var src = httpsUrl(im.fullsize) || httpsUrl(im.thumb);
			if (!src) return;
			var img = h("img");
			img.setAttribute("loading", "lazy");
			img.setAttribute("referrerpolicy", "no-referrer");
			img.alt = String(im.alt || "");
			if (im.aspectRatio && im.aspectRatio.width && im.aspectRatio.height) { img.width = im.aspectRatio.width; img.height = im.aspectRatio.height; }
			img.src = src;
			to.append(img);
		});
	} else if (t === "app.bsky.embed.video#view") {
		var poster = httpsUrl(v.thumbnail), list = httpsUrl(v.playlist);
		// The video is HLS: Safari plays it, hls.js elsewhere; if neither can, a link to the post.
		if (list) {
			var vid = h("video");
			vid.controls = true; vid.preload = "none"; vid.setAttribute("playsinline", "");
			if (poster) vid.poster = poster;
			vid.src = list;
			to.append(vid);
			fixVideo(vid, link);
		} else {
			var a = h("a", "bsky-video");
			a.href = link; a.target = "_blank"; a.rel = "noopener noreferrer";
			if (poster) { var still = h("img"); still.alt = String(v.alt || "Video"); still.src = poster; still.setAttribute("referrerpolicy", "no-referrer"); a.append(still); }
			a.append(h("span", "", "▶ Watch on Bluesky ↗"));
			to.append(a);
		}
	} else if (t === "app.bsky.embed.external#view" && v.external && httpsUrl(v.external.uri)) {
		var player = embedSrc(v.external.uri);
		if (player) { to.append(playerFrame(player)); return; }
		var card = h("a", "bsky-card");
		card.href = v.external.uri; card.target = "_blank"; card.rel = "noopener noreferrer";
		if (httpsUrl(v.external.thumb)) { var th = h("img"); th.alt = ""; th.src = v.external.thumb; th.setAttribute("referrerpolicy", "no-referrer"); card.append(th); }
		card.append(h("strong", "", v.external.title || hostOf(v.external.uri)), h("span", "", hostOf(v.external.uri)));
		to.append(card);
	} else if (t === "app.bsky.embed.recordWithMedia#view") {
		bskyEmbed(v.media, to, depth, link);
		bskyEmbed(v.record, to, depth, link);
	} else if (t === "app.bsky.embed.record#view" && v.record && v.record.$type === "app.bsky.embed.record#viewRecord") {
		// A quoted post: its text, who wrote it, and its own pictures.
		var r = v.record, bq = h("blockquote", "bsky"), who = r.author || {};
		if (r.value && r.value.text) bq.append(h("p", "", String(r.value.text)));
		var by = h("p", "by"), at = h("a", "", (who.displayName ? who.displayName + " " : "") + "@" + (who.handle || ""));
		at.href = postUrl(r); at.target = "_blank"; at.rel = "noopener noreferrer";
		by.append("— ", at);
		bq.append(by);
		(r.embeds || []).forEach(function (e) { bskyEmbed(e, bq, depth + 1, postUrl(r)); });
		to.append(bq);
	}
}

// Change a feed locally first so it shows at once, then save. If saving
// fails, it snaps back to how it was and the error shows.
async function optimistic(kind, change, save) {
	var snap = JSON.stringify(state.feeds);
	change();
	renderFeeds();
	try {
		await save();
	} catch (e) {
		state.feeds = JSON.parse(snap);
		renderFeeds();
		return fail(e);
	}
	renderFeeds();
}

// ---------- tags
// Feeds carry any number of tags. Picking a tag above the feed list narrows
// the feeds and the items to it; "Untagged" shows feeds with none. Each tag
// keeps one of 8 colors by its id, so adding or renaming one moves nothing.

async function loadTags() {
	var data = await apiJSON("/api/tags");
	state.tags = data.tags;
	fillTagSelect();
}
function tagById(id) { return state.tags.filter(function (t) { return t.id === Number(id); })[0] || null; }
function tagColor(id) { return "c" + ((Number(id) - 1) * 3) % 8; }
// id 0 means "no tags".
function hasTag(f, id) { return id === 0 ? !f.tags.length : f.tags.indexOf(id) >= 0; }
function tagName(id) { var t = tagById(id); return id === 0 ? "Untagged" : t ? t.name : ""; }
// A podcast or video channel: at least half its items are episodes or videos.
function isMediaFeed(f) { var m = (f.episodes || 0) + (f.videos || 0); return m > 0 && m >= (f.articles || 0); }
// A tag only podcast or video channels carry (adding one used to tag it with
// its own name, for a filter the galleries have since replaced). These stay
// out of the news tabs' tag list and switches.
function isChannelTag(id) {
	var on = state.feeds.filter(function (f) { return hasTag(f, id); });
	return on.length > 0 && on.every(isMediaFeed);
}
// The Add form's picker, set to the tag being viewed.
function fillTagSelect() {
	var sel = $("addTag");
	sel.textContent = "";
	sel.add(new Option("No tag", "0"));
	state.tags.forEach(function (t) { sel.add(new Option(t.name, String(t.id))); });
	sel.add(new Option("New tag…", "new"));
	sel.value = state.tag && tagById(state.tag) ? String(state.tag) : "0";
}
// Asks for a name and returns that tag (made now, or the one already
// called that), or null if cancelled.
async function promptTag() {
	var name = prompt("Name for the new tag");
	if (!name || !name.trim()) return null;
	var data = await apiJSON("/api/tags", { method: "POST", json: { name: name.trim() } });
	await loadTags();
	return data.tag;
}
async function newTag() {
	try { if (await promptTag()) renderFeeds(); } catch (e) { fail(e); }
}
async function renameTag(t) {
	var name = prompt("Rename tag", t.name);
	if (!name || !name.trim() || name.trim() === t.name) return;
	try { await apiJSON("/api/tags/" + t.id, { method: "PATCH", json: { name: name.trim() } }); await loadTags(); } catch (e) { return fail(e); }
	renderFeeds();
	renderListTitle();
}
async function deleteTag(t) {
	var n = state.feeds.filter(function (f) { return hasTag(f, t.id); }).length;
	var what = n ? "It comes off " + n + " feed" + (n === 1 ? "" : "s") + "; the feeds stay." : "No feeds have it.";
	if (!confirm("Delete the tag “" + t.name + "”? " + what)) return;
	try {
		await apiJSON("/api/tags/" + t.id, { method: "DELETE" });
		await Promise.all([loadTags(), loadFeeds()]);
		if (sameId(state.tag, t.id)) location.hash = listHash(state.view);
	} catch (e) { fail(e); }
}
// Put tag id on feed f, or take it off. Shows at once; saves the feed's
// whole set of tags.
function toggleTag(f, id) {
	var next = hasTag(f, id) ? f.tags.filter(function (x) { return x !== id; }) : f.tags.concat(id);
	return optimistic("feeds", function () { f.tags = next; }, async function () {
		await apiJSON("/api/feeds/" + f.id, { method: "PATCH", json: { tags: next } });
		if (state.tag != null && state.feed == null) await loadItems(false, true);
	});
}
function chip(name, cls) {
	var c = h("a", "chip " + cls);
	c.append(h("span", "name", name));
	return c;
}
// The filter above the feed list, with unread counts. Tapping the tag
// being viewed goes back to all feeds.
function tagBar(view) {
	var li = h("li", "tagbar"), box = h("div", "chips");
	// Channel tags show only in Edit, so they can still be renamed or deleted.
	var list = state.tags.filter(function (t) { return state.editFeeds || !isChannelTag(t.id) || sameId(state.tag, t.id); })
		.map(function (t) { return { id: t.id, name: t.name, cls: tagColor(t.id) }; });
	if (newsFeeds().some(function (f) { return !f.tags.length; })) list.push({ id: 0, name: "Untagged", cls: "untagged" });
	li.classList.toggle("filtering", state.tag != null);
	box.setAttribute("aria-label", "Tags");
	list.forEach(function (x) {
		var on = sameId(state.tag, x.id), c = chip(x.name, x.cls);
		var n = state.feeds.reduce(function (s, f) { return hasTag(f, x.id) ? s + f.unread : s; }, 0);
		if (n) c.append(h("span", "n", String(n)));
		c.href = on && state.feed == null ? listHash(view) : listHash(view, null, x.id);
		if (on) c.setAttribute("aria-current", "true");
		box.append(c);
	});
	li.append(box);
	if (state.editFeeds) {
		var t = state.tag ? tagById(state.tag) : null;
		if (t) {
			var tools = h("div", "tools");
			tools.append(
				button("Rename “" + t.name + "”", "btn small", function () { renameTag(t); }),
				button("Delete tag", "btn small", function () { deleteTag(t); })
			);
			li.append(tools);
		} else if (state.tags.length) li.append(h("div", "hint", "Pick a tag to rename or delete it."));
	}
	return li;
}
// Edit mode: every tag as a switch for this feed, plus "+ Tag".
function tagToggles(f) {
	var box = h("div", "chips feedtags");
	box.setAttribute("role", "group");
	box.setAttribute("aria-label", "Tags for " + (f.title || hostOf(f.url)));
	state.tags.forEach(function (t) {
		if (!isMediaFeed(f) && !hasTag(f, t.id) && isChannelTag(t.id)) return;
		var b = button(t.name, "chip " + tagColor(t.id), function () { toggleTag(f, t.id); });
		b.setAttribute("aria-pressed", String(hasTag(f, t.id)));
		box.append(b);
	});
	box.append(button("+ Tag", "chip add", async function () {
		try {
			var t = await promptTag();
			if (t && !hasTag(f, t.id)) await toggleTag(f, t.id); else renderFeeds();
		} catch (e) { fail(e); }
	}));
	return box;
}
function tagDots(f) {
	var d = h("span", "dots");
	f.tags.forEach(function (id) {
		var t = tagById(id);
		if (t) { var i = h("i", tagColor(id)); i.title = t.name; d.append(i); }
	});
	d.setAttribute("aria-label", "Tags: " + f.tags.map(tagName).filter(Boolean).join(", "));
	return d;
}

// ---------- feeds

async function loadFeeds() {
	var data = await apiJSON("/api/feeds");
	state.feeds = data.feeds;
	renderFeeds();
}
function listQuery(feed, tag) {
	var q = [];
	if (tag != null) q.push("tag=" + tag);
	if (feed != null) q.push("feed=" + feed);
	return q.length ? "?" + q.join("&") : "";
}
function listHash(view, feed, tag) { return "#/" + view + listQuery(feed, tag); }
// The feeds the news tabs list. Podcast and video channels live under
// Podcasts and Videos, so they show here only in Edit (to rename, retag or
// remove them) or while one is open.
function newsFeeds() {
	return state.feeds.filter(function (f) { return state.editFeeds || !isMediaFeed(f) || sameId(state.feed, f.id); });
}
// All feeds, or the ones with the tag being viewed; one flat list, A-Z.
function renderFeeds() {
	var ul = $("feeds"), view = LIST_VIEWS[state.view] ? state.view : "unread";
	ul.textContent = "";
	var total = state.feeds.reduce(function (n, f) { return n + f.unread; }, 0);
	var all = h("li"), allRow = h("div", "row"), allA = h("a");
	allA.href = listHash(view);
	if (state.feed == null && state.tag == null) allA.setAttribute("aria-current", "true");
	allA.append(h("span", "name", "All feeds"), h("span", "n", total ? String(total) : ""));
	allRow.append(allA);
	all.append(allRow);
	ul.append(all);
	if (state.tags.length) ul.append(tagBar(view));

	var feeds = newsFeeds(), shown = state.tag == null ? feeds : feeds.filter(function (f) { return hasTag(f, state.tag); });
	shown.forEach(function (f) { ul.append(feedRow(f, view)); });
	if (state.tag != null && !shown.length) ul.append(h("li", "hint", state.tag ? "No feeds have this tag." : "Every feed has a tag."));
	$("feedCount").textContent = feeds.length ? "(" + feeds.length + ")" : "";
	show($("newTag"), state.editFeeds);
	$("editFeeds").textContent = state.editFeeds ? "Done" : "Edit";
	if (!state.feeds.length) $("feedsBox").open = true;
}
function feedRow(f, view) {
	var li = h("li", "child"), row = h("div", "row"), a = h("a");
	a.href = listHash(view, f.id, state.tag);
	if (sameId(state.feed, f.id)) a.setAttribute("aria-current", "true");
	a.append(h("span", "name", f.title || hostOf(f.url)));
	if (f.email) a.append(h("span", "tag", "email"));
	else if (f.mode === "scrape") a.append(h("span", "tag", "page"));
	a.append(h("span", "n", f.unread ? String(f.unread) : ""));
	row.append(a);
	if (f.tags.length && !state.editFeeds) a.insertBefore(tagDots(f), a.lastChild);
	li.append(row);
	if (state.errors[f.id]) li.append(h("div", "ferr", "Couldn't refresh: " + state.errors[f.id]));
	if (state.editFeeds) {
		li.append(tagToggles(f));
		var t = h("div", "tools");
		t.append(
			button("Rename", "btn small", async function () {
				var name = prompt("Rename feed", f.title);
				if (!name || !name.trim()) return;
				try { await apiJSON("/api/feeds/" + f.id, { method: "PATCH", json: { title: name.trim() } }); await loadFeeds(); } catch (e) { fail(e); }
			}),
			button("Remove", "btn small", async function () {
				var ask = f.email
					? "Remove “" + f.title + "” and its items, and ignore any more mail for it? Saved items from it go too."
					: "Remove “" + (f.title || f.url) + "” and its items? Saved items from it go too.";
				if (!confirm(ask)) return;
				try {
					await apiJSON("/api/feeds/" + f.id, { method: "DELETE" });
					if (sameId(state.feed, f.id)) location.hash = "#/" + view;
					await loadFeeds();
					await loadItems(false);
				} catch (e) { fail(e); }
			})
		);
		li.append(t);
	}
	return li;
}

function addStatus(msg, bad) {
	var s = $("addStatus");
	s.textContent = msg;
	s.classList.toggle("err", !!bad);
	show(s, !!msg);
}
async function addFeed(e) {
	e.preventDefault();
	var input = $("addUrl").value.trim();
	if (!input) return;
	var tagId;
	try {
		tagId = await chosenTag($("addTag"));
	} catch (err) { return fail(err); }
	$("addBtn").disabled = true;
	addStatus("Looking for a feed…");
	try {
		var x = await follow(input, tagId ? [tagId] : []), r = x.found, data = x.data;
		var what = r.mode === "feed" ? "RSS feed found (" + r.kind + "): " : "No feed, watching the page: ";
		if (data.existing) { addStatus("Already following " + data.feed.title + "."); return; }
		addStatus(what + data.feed.title + " — " + x.inserted + " item" + (x.inserted === 1 ? "" : "s") + ".");
		$("addUrl").value = "";
		await loadFeeds();
		fillTagSelect();
		await loadItems(false);
	} catch (err) {
		if (err.message !== UNAUTH) addStatus("Couldn't add that: " + err.message, true);
	} finally {
		$("addBtn").disabled = false;
	}
}
// Find the feed at what was typed, save it and its items. Podcasts and
// Videos sort themselves out by the items' files, so both adds use this.
// feedOnly: a page with no feed isn't kept (the galleries' + Add).
async function follow(input, tags, feedOnly) {
	var r = await discover(input);
	if (feedOnly && r.mode !== "feed") throw new Error("there's no feed at that address");
	var data = await apiJSON("/api/feeds", { method: "POST", json: {
		url: r.url, feed_url: r.feed_url, mode: r.mode, title: r.title, site_url: r.site_url, tags: tags
	} });
	if (data.existing) return { found: r, data: data, inserted: 0 };
	var saved = await saveItems(data.feed.id, r.items, r.image || await channelImage(data.feed, r.items));
	return { found: r, data: data, inserted: saved.inserted };
}
// The Add form's tag: its id, or null for none. "New tag…" asks for a name.
async function chosenTag(sel) {
	if (sel.value !== "new") return Number(sel.value) || null;
	var t = await promptTag();
	return t ? t.id : null;
}
function saveItems(feedId, items, image) {
	var clean = items.filter(function (it) { return it.guid; }).slice(0, 200).map(function (it) {
		return {
			guid: String(it.guid).slice(0, 2000), title: it.title || "", link: it.link || null, author: it.author || null,
			published_at: it.published_at || null, content: it.content && it.content.length <= 400000 ? it.content : null,
			media_url: it.media_url || null, media_type: it.media_type || null
		};
	});
	return apiJSON("/api/items", { method: "POST", json: { feed_id: feedId, items: clean, image: image || undefined } });
}

// Refresh: every feed (or only stale ones on app open), three at a time.
// Newsletters arrive by email on their own, so there's nothing to fetch.
async function refreshAll(force) {
	if (state.refreshing || !state.feeds.length) return;
	var due = state.feeds.filter(function (f) {
		return !f.email && (force || !f.last_fetched_at || Date.now() - f.last_fetched_at > STALE_MS);
	});
	if (!due.length) return;
	state.refreshing = true;
	var btn = $("refresh"), done = 0, queue = due.slice();
	btn.disabled = true;
	btn.textContent = "0/" + due.length;
	async function worker() {
		while (queue.length) {
			await refreshFeed(queue.shift());
			btn.textContent = ++done + "/" + due.length;
		}
	}
	try {
		await Promise.all([worker(), worker(), worker()]);
		await loadFeeds();
		var failed = due.filter(function (f) { return state.errors[f.id]; }).length;
		if (failed) toast(failed + " feed" + (failed > 1 ? "s" : "") + " couldn't refresh. Details are in the feed list.");
		if (state.route && LIST_VIEWS[state.route.name]) await loadItems(false, true);
		else state.stale = true;
		if (state.route && MEDIA_TABS[state.route.name]) await reloadPodcasts();
	} catch (e) { fail(e); }
	finally {
		state.refreshing = false;
		btn.disabled = false;
		btn.textContent = "Refresh";
	}
}
async function refreshFeed(f) {
	try {
		var items;
		if (f.mode === "feed") {
			var r = await proxyGet(f.feed_url);
			var p = parseFeed(r.text, r.url);
			if (!p) throw new Error("that address no longer returns a feed");
			items = p.items;
			var image = p.image || await channelImage(f, items);
		} else {
			var pg = await proxyGet(f.site_url || f.url);
			items = scrape(pg.text, pg.url).items;
		}
		await saveItems(f.id, items, image);
		delete state.errors[f.id];
	} catch (e) {
		if (e.message === UNAUTH) throw e;
		state.errors[f.id] = e.message;
	}
}

// A video channel's picture: YouTube's feed has none, so it comes from the
// channel's page (its og:image, the channel's avatar), once.
async function channelImage(f, items) {
	if (f.image_url || !f.site_url || !items.some(function (it) { return /^video\//.test(it.media_type || ""); })) return null;
	try {
		var pg = await proxyGet(f.site_url);
		var m = parseHTML(pg.text).querySelector("meta[property='og:image'], meta[name='twitter:image']");
		var url = m && m.getAttribute("content");
		return url ? absUrl(url.trim(), pg.url) : null;
	} catch (e) { return null; }
}

// ---------- item list

var loadSeq = 0;
async function loadItems(append, keepScroll) {
	var seq = ++loadSeq;
	var q = "view=" + (LIST_VIEWS[state.view] ? state.view : "unread") + "&limit=50";
	if (state.feed != null) q += "&feed=" + state.feed;
	else if (state.tag != null) q += "&tag=" + state.tag;
	if (append && state.next) q += "&before=" + encodeURIComponent(state.next);
	var y = window.scrollY;
	if (!append && !state.items.length) { $("empty").textContent = "Loading…"; show($("empty"), true); }
	var data = await apiJSON("/api/items?" + q);
	if (seq !== loadSeq) return;
	if (!append) {
		await untouched();
		if (seq !== loadSeq) return;
	}
	state.items = append ? state.items.concat(data.items) : data.items;
	state.next = data.next;
	state.listKey = listKeyNow();
	state.stale = false;
	renderItems();
	if (keepScroll) window.scrollTo(0, y);
}
// A fresh list (after a refresh, or coming back to a list that changed) waits
// while a finger is on the screen and a moment after it lifts. Swapping the
// rows mid-tap loses the tap: Safari drops a tap when the page changes under
// it, and the row that was there is gone.
var touchDown = 0, touchUp = 0;
// No zooming, except in a PDF or comic, where a pinch is how small print gets
// read. Safari in a tab ignores user-scalable, so its pinch gesture is
// cancelled here too.
function zoomable(on) {
	document.documentElement.classList.toggle("zoomable", on);
	$("vp").content = "width=device-width, initial-scale=1" + (on ? "" : ", maximum-scale=1, user-scalable=no") + ", viewport-fit=cover";
}
document.addEventListener("gesturestart", function (e) { if (!document.documentElement.classList.contains("zoomable")) e.preventDefault(); });
["touchstart", "pointerdown"].forEach(function (t) {
	document.addEventListener(t, function (e) { if (t === "touchstart" || e.pointerType !== "mouse") touchDown = Date.now(); }, { capture: true, passive: true });
});
["touchend", "touchcancel", "pointerup", "pointercancel"].forEach(function (t) {
	document.addEventListener(t, function () { touchUp = Date.now(); }, { capture: true, passive: true });
});
function untouched() {
	return new Promise(function (done) {
		(function check() {
			var now = Date.now();
			if (touchDown > touchUp && now - touchDown < 5000) return setTimeout(check, 100);
			var wait = touchUp + 500 - now;
			if (wait > 0) return setTimeout(check, wait);
			done();
		})();
	});
}
function listKeyNow() { return state.view + "|" + state.feed + "|" + state.tag; }
function renderListTitle() {
	var t = LIST_VIEWS[state.view] || "Unread", sub = "";
	if (state.feed != null) {
		var f = state.feeds.filter(function (x) { return x.id === state.feed; })[0];
		sub = f ? f.title : "";
	} else if (state.tag != null) {
		sub = tagName(state.tag);
	}
	$("listTitle").textContent = sub ? t + " · " + sub : t;
}
function renderItems() {
	var ul = $("items"), frag = document.createDocumentFragment();
	ul.textContent = "";
	state.items.forEach(function (it) {
		var li = h("li", it.read ? "read" : ""), a = h("a");
		a.href = "#/item/" + it.id;
		var dot = h("span", "dot");
		dot.setAttribute("aria-label", it.read ? "" : "Unread");
		a.append(dot, h("span", "t", it.title || "Untitled"));
		var meta = [it.feed_title, ago(it.published_at || it.created_at)].filter(Boolean).join(" · ");
		a.append(h("span", "m", meta + (it.saved ? " · ★ Saved" : "")));
		li.append(a, markButton(it, li));
		// The rest of the story, under its newest item: one entry, one count.
		if (it.related && it.related.length) {
			li.classList.add("story");
			var rel = h("ul", "rel");
			it.related.forEach(function (r) {
				var ra = h("a", "", r.title || "Untitled");
				ra.href = "#/item/" + r.id;
				var rli = h("li", r.read ? "read" : "");
				rli.append(ra);
				rel.append(rli);
			});
			li.append(rel);
		}
		frag.append(li);
	});
	ul.append(frag);
	watchRows();
	var empty = !state.items.length;
	$("empty").textContent = !state.feeds.length ? "Add a website or feed to get started."
		: state.view === "saved" ? "Nothing saved yet." : state.view === "unread" ? "All caught up." : "No items yet.";
	show($("empty"), empty);
	show($("more"), !!state.next);
	show($("markAll"), state.view !== "saved" && !empty);
	renderListTitle();
}
// The checkmark beside each item: read or unread without opening it (a
// story's other items go with it, as when it's opened). The list stays put.
var CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16 9.8"/></svg>';
function markButton(it, li) {
	var b = h("button", "mark");
	b.type = "button";
	b.innerHTML = CHECK_SVG;
	var paint = function () {
		li.classList.toggle("read", !!it.read);
		b.setAttribute("aria-label", it.read ? "Mark unread" : "Mark read");
		b.title = it.read ? "Mark unread" : "Mark read";
		li.querySelectorAll(".rel li").forEach(function (r) { r.classList.toggle("read", !!it.read); });
	};
	paint();
	b.addEventListener("click", async function () {
		await setFlags(it, { read: it.read ? 0 : 1 });
		paint();
		renderFeeds();
	});
	return b;
}
// Mark read as I scroll (a setting on each device; Unread only): a row that
// has been on screen and then scrolls up past the header is read. Rows only
// dim, so the list doesn't jump, and its checkmark brings one back. Coming
// back from an article puts the list where it was, so for a moment after a
// render a row passing the header only stops counting as seen.
var scrollRead = read("readerScrollRead") === "1", rowIO = null, rowsAt = 0, readQueue = [], readTimer = 0;
function applyScrollRead(on) {
	scrollRead = on;
	document.querySelectorAll("#scrollRead button").forEach(function (b) { b.setAttribute("aria-pressed", String(!!b.dataset.on === on)); });
	if (state.route && LIST_VIEWS[state.route.name]) watchRows();
}
function watchRows() {
	if (rowIO) { rowIO.disconnect(); rowIO = null; }
	if (!scrollRead || state.view !== "unread" || !window.IntersectionObserver) return;
	rowsAt = Date.now();
	rowIO = new IntersectionObserver(rowsMoved, { rootMargin: -Math.round(headerBottom()) + "px 0px 0px 0px" });
	$("items").querySelectorAll(":scope > li").forEach(function (li, i) { li.dataset.i = i; rowIO.observe(li); });
}
function rowsMoved(entries) {
	if (!state.route || state.route.name !== "unread") return;
	entries.forEach(function (e) {
		var li = e.target, it = state.items[li.dataset.i];
		// A hidden list (an article open over it) reports every row as gone.
		if (!it || !e.rootBounds || !e.boundingClientRect.height) return;
		if (e.isIntersecting) { li.seen = true; return; }
		var passed = e.boundingClientRect.bottom <= e.rootBounds.top + 1;
		if (!passed || !li.seen) return;
		li.seen = false;
		if (it.read || Date.now() - rowsAt < 700) return;
		applyFlags(it, { read: 1 });
		li.classList.add("read");
		li.querySelectorAll(".rel li").forEach(function (r) { r.classList.add("read"); });
		var b = li.querySelector(".mark");
		if (b) { b.setAttribute("aria-label", "Mark unread"); b.title = "Mark unread"; }
		readQueue.push(it);
		if (!readTimer) readTimer = setTimeout(flushRead, 2000);
	});
}
function flushRead(leaving) {
	clearTimeout(readTimer);
	readTimer = 0;
	if (readQueue.length) {
		queueReads(readQueue.map(function (it) { return it.id; }));
		readQueue = [];
		renderFeeds();
	}
	sendPendingReads(!!leaving);
}
// Read marks the Worker hasn't confirmed yet (offline, a dropped request, the
// app put away mid-send) wait in localStorage and go again on the next
// chance, instead of being lost: a read here that never reached the Worker
// comes back unread on every other device.
function pendingReads() { return readJSON("readerPendingReads") || []; }
function keepPending(ids) { store("readerPendingReads", ids.length ? JSON.stringify(ids.slice(-500)) : null); }
function queueReads(ids) {
	var p = pendingReads();
	ids.forEach(function (id) { if (p.indexOf(id) < 0) p.push(id); });
	keepPending(p);
}
function dropPending(id) { keepPending(pendingReads().filter(function (x) { return x !== id; })); }
var sendingReads = false;
async function sendPendingReads(keepalive) {
	var ids = pendingReads();
	if (!ids.length || sendingReads || !token()) return;
	sendingReads = true;
	try {
		var res = await api("/api/items/mark-read", { method: "POST", json: { ids: ids }, keepalive: !!keepalive });
		if (res.ok) keepPending(pendingReads().filter(function (id) { return ids.indexOf(id) < 0; }));
	} catch (e) {
	} finally {
		sendingReads = false;
	}
}
function renderTabs(name) {
	var sub = listQuery(state.feed, state.tag);
	document.querySelectorAll("#tabs a").forEach(function (a) {
		var v = a.dataset.view;
		a.href = "#/" + v + (LIST_VIEWS[v] ? sub : v === "library" && state.libTags.length ? "?tag=" + state.libTags.join(",") : "");
		if (v === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
	});
}

// ---------- routing

function parseHash() {
	var hsh = location.hash.replace(/^#\/?/, ""), q = hsh.indexOf("?");
	var path = q < 0 ? hsh : hsh.slice(0, q), params = new URLSearchParams(q < 0 ? "" : hsh.slice(q + 1));
	var parts = path.split("/");
	var num = function (v) { return v != null && /^\d+$/.test(v) ? Number(v) : null; };
	return {
		name: parts[0] || "unread", id: num(parts[1]),
		feed: num(params.get("feed")), tag: num(params.get("tag")), series: params.get("series"),
		// The Library takes several: ?tag=3,7 is books with both.
		tags: (params.get("tag") || "").split(",").map(num).filter(function (x) { return x != null; })
	};
}
function showView(name) {
	["list", "article", "podcasts", "library", "book", "record", "listen", "family"].forEach(function (v) { show($(v + "View"), v === name); });
	if ($("lpChapDlg").open) $("lpChapDlg").close();
	var top = name === "list" || name === "podcasts" || name === "library";
	show($("tabs"), top);
	show($("back"), !top);
	show($("refresh"), name === "list" || name === "podcasts");
	show($("progress"), name === "book");
	show($("bookMenuBtn"), name === "book");
	show($("markBtn"), name === "book");
	$("heading").textContent = "";
	show($("home"), top);
}
async function route() {
	var r = parseHash(), prev = state.route;
	if (prev && LIST_VIEWS[prev.name]) state.listScroll = window.scrollY;
	// Stepping from item to item replaces the entry, so Back still goes to the list.
	if (!(prev && prev.name === "item" && r.name === "item")) {
		state.fromList = !!(prev && (LIST_VIEWS[prev.name] || prev.name === "library" || prev.name === "record" || MEDIA_TABS[prev.name]));
		if (prev && prev.name === "library") state.libScroll = window.scrollY;
		state.fromPodcasts = !!(prev && MEDIA_TABS[prev.name]);
	}
	state.prev = prev;
	state.route = r;
	videoBox.close();
	closeBook();
	openSettings(false);
	openBookMenu(false);
	if (details) closeDetails();
	closeBookCtx();
	flushRead();
	renderPlayer();
	state.item = null;
	try {
		if (LIST_VIEWS[r.name]) return await showList(r, prev);
		if (r.name === "library") return await showLibrary(r);
		if (MEDIA_TABS[r.name]) return await showPodcasts(r);
		if (r.name === "item" && r.id) return await openItem(r.id);
		if (r.name === "book" && r.id) return await openBook(r.id);
		if (r.name === "record" && r.id) return await showRecord(r.id);
		if (r.name === "listen" && r.id) return await showListen(r.id);
		if (r.name === "family") return await showFamily();
		location.replace("#/unread");
	} catch (e) { fail(e); }
}
async function showList(r, prev) {
	state.lastList = location.hash || "#/unread";
	state.view = r.name;
	state.feed = r.feed;
	state.tag = r.tag;
	showView("list");
	renderTabs(r.name);
	renderFeeds();
	fillTagSelect();
	loadContinue();
	var back = prev && prev.name === "item" && state.listKey === listKeyNow();
	if (back && !state.stale) {
		renderItems();
		window.scrollTo(0, state.listScroll);
		return;
	}
	if (!back) { window.scrollTo(0, 0); state.items = []; }
	await loadItems(false);
	if (back && state.route === r) window.scrollTo(0, state.listScroll);
}
// Continue listening and the Continue reading shelf, atop Unread and All (not
// a feed or tag): the episode part-way through (the one last played on this
// device if it is, else the server's pick), then every book opened and not
// finished, most recent first, and after them the next volume of each series
// you've finished one of. The shelf is worked out from the Library's list,
// fetched here if the Library hasn't been opened yet; it shows atop the
// Library too.
var contData = null;
function contShown() { return (state.view === "unread" || state.view === "all") && state.feed == null && state.tag == null; }
async function loadContinue() {
	renderContinue();
	if (!contShown()) return;
	var books = state.books ? null : loadBooks().catch(function () {});
	try { contData = await apiJSON("/api/continue"); } catch (e) { if (e.message === UNAUTH) return; }
	await books;
	renderContinue();
}
var SHELF_MAX = 12;
function shelfBooks(books) {
	var reading = books.filter(function (b) { return b.last_opened_at && !b.finished_at; })
		.sort(function (a, b) { return b.last_opened_at - a.last_opened_at || b.id - a.id; });
	var series = {}, next = [];
	books.forEach(function (b) { if (b.series) (series[fold(b.series)] = series[fold(b.series)] || []).push(b); });
	Object.keys(series).forEach(function (k) {
		var vols = sortBooks(series[k], "series"), last = -1, at = 0;
		vols.forEach(function (b, i) { if (b.finished_at) { last = i; at = Math.max(at, b.finished_at); } });
		if (last < 0 || vols.some(function (b) { return b.last_opened_at && !b.finished_at; })) return;
		var n = vols.slice(last + 1).filter(function (b) { return !b.finished_at; })[0];
		if (n) next.push({ book: n, at: at });
	});
	next.sort(function (a, b) { return b.at - a.at; });
	return reading.map(function (b) { return { book: b }; })
		.concat(next.map(function (x) { return { book: x.book, next: true }; })).slice(0, SHELF_MAX);
}
function shelfCard(x) {
	var b = x.book, li = h("li"), a = h("a"), pos = parsePos(b.position), pct = pos && pos.f ? Math.round(pos.f * 100) : 0;
	var where = x.next ? "Up next" + (b.volume ? " · Vol. " + b.volume : "")
		: pos && b.type !== "txt" && pos.page ? "p. " + pos.page + (pos.pages ? " of " + pos.pages : "") : pct ? pct + "%" : "Started";
	a.href = "#/book/" + b.id;
	a.setAttribute("aria-label", (x.next ? "Up next: " : "Continue reading: ") + b.title + ", " + where);
	var bar = h("div", "bar-prog"), fill = h("span");
	fill.style.width = (x.next ? 0 : pct) + "%";
	bar.append(fill);
	a.append(coverBox(b), h("span", "ct", b.title), h("span", "ca", where), bar);
	li.append(a);
	return li;
}
// The shelf into box (#contShelf on Unread and All, #libShelf in the Library); hidden when empty.
function renderShelf(box) {
	box.textContent = "";
	var list = shelfBooks((state.books || []).filter(function (b) { return !isAudiobook(b); }));
	if (!list.length) { show(box, false); return false; }
	var ul = h("ul", "shelf");
	list.forEach(function (x) { ul.append(shelfCard(x)); });
	box.append(h("span", "cl", "Continue reading"), ul);
	show(box, true);
	return true;
}
function contEpisode() {
	var mine = player.ep && !player.ep.book && isAudio(player.ep) ? player.ep : null;
	if (mine && epPos(mine) > 5 && !epPlayed(mine)) return mine;
	var ep = contData && contData.episode ? epFields(contData.episode) : null;
	return ep && !epPlayed(ep) && !(mine && mine.id === ep.id) ? ep : null;
}
function contBook() {
	var b = contData && contData.book;
	if (!b) return null;
	var mine = (state.books || []).filter(function (x) { return x.id === b.id; })[0];
	b = mine || Object.assign({}, b);
	if (!mine) applyPending([b], false);
	return b.finished_at ? null : b;
}
function contCard(tag, label, title, meta, pct) {
	var c = h(tag, "ccard"), bar = h("div", "bar-prog"), fill = h("span");
	fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
	bar.append(fill);
	c.append(h("span", "cl", label), h("span", "ct", title), h("span", "cm", meta), bar);
	return c;
}
function renderContinue() {
	var box = $("cont");
	box.textContent = "";
	if (!contShown()) { show(box, false); return; }
	var ep = contEpisode(), b = state.books ? null : contBook();
	if (ep) {
		var len = epLen(ep), c = contCard("button", "Continue listening", ep.title,
			[ep.feed_title, epStatus(ep)].filter(Boolean).join(" · "), len ? epPos(ep) / len * 100 : 0);
		c.type = "button";
		c.setAttribute("aria-label", "Continue listening: " + ep.title);
		c.addEventListener("click", function () { playEpisode(ep, true).then(renderContinue).catch(fail); });
		box.append(c);
	}
	var ab = player.ep && player.ep.book && player.ep.t > 5 && !$("pAudio").src ? player.ep : null;
	if (ab && !ep) {
		var left = Math.max(0, (ab.duration || 0) - ab.t), ac = contCard("button", "Continue listening", ab.title,
			[ab.feed_title, hours(left) + " left"].filter(Boolean).join(" · "), ab.duration ? ab.t / ab.duration * 100 : 0);
		ac.type = "button";
		ac.setAttribute("aria-label", "Continue listening: " + ab.title);
		ac.addEventListener("click", function () { playAudiobook(ab, true).then(renderContinue).catch(fail); });
		box.append(ac);
	}
	if (b) {
		var pos = parsePos(b.position), pct = pos && pos.f ? Math.round(pos.f * 100) : 0;
		var where = pos && b.type !== "txt" && pos.page ? "p. " + pos.page + (pos.pages ? " of " + pos.pages : "") : pct ? pct + "%" : "";
		var a = contCard("a", "Continue reading", b.title, [b.author, where].filter(Boolean).join(" · "), pct);
		a.href = "#/book/" + b.id;
		a.setAttribute("aria-label", "Continue reading: " + b.title);
		box.append(a);
	}
	var asks = contData && contData.requests;
	if (asks) {
		var r = contCard("a", "Back Alley Library", asks === 1 ? "1 library card request" : asks + " library card requests", "Approve or decline on the Family screen", 0);
		r.href = "#/family";
		r.querySelector(".bar-prog").remove();
		box.append(r);
	}
	var shelf = h("div", "shelfbox"), any = !!state.books && renderShelf(shelf);
	if (any) box.append(shelf);
	show(box, !!(ep || ab || b || any || asks));
}
// ---------- family library (the owner's side: who has a link)

async function showFamily() {
	showView("family");
	$("heading").textContent = "Family";
	window.scrollTo(0, 0);
	show($("famLink"), false);
	await loadPeople();
}
async function loadPeople() {
	var data = await apiJSON("/api/people");
	renderPeople(data.people || []);
	showRequests(data.people || []);
}
function personStatus(p) {
	var bits = [];
	if (p.signed_in) bits.push(p.last_seen_at ? "Last on " + ago(p.last_seen_at) : "Signed in");
	else if (p.invite_expires_at > Date.now()) bits.push("Link not used yet, runs out " + new Date(p.invite_expires_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
	else bits.push("Link ran out");
	return bits.join(" · ");
}
// Library card requests: checked when Reader opens, when it comes back to the
// front, and every 5 minutes while it's showing. Waiting ones put a dot on the gear,
// a count on Family library and (where the browser allows, as a Home Screen
// app with notifications allowed) on the app icon; one that's new since this
// device last looked gets a toast.
var reqCheckedAt = 0;
function showRequests(people) {
	var reqs = people.filter(function (p) { return p.requested_at; }), n = reqs.length;
	document.querySelectorAll(".reqdot").forEach(function (e) { show(e, n > 0); });
	document.querySelectorAll(".reqn").forEach(function (e) { e.textContent = n; show(e, n > 0); });
	try { if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(function () {}); } catch (e) {}
	var seen = readJSON("readerReqSeen") || [], fresh = reqs.filter(function (p) { return seen.indexOf(p.id) < 0; });
	store("readerReqSeen", JSON.stringify(reqs.map(function (p) { return p.id; })));
	if (!fresh.length || (state.route && state.route.name === "family")) return;
	toast(fresh.length === 1 ? fresh[0].name + " asked for a library card." : fresh.length + " new library card requests.",
		{ label: "See", fn: function () { location.hash = "#/family"; } });
}
async function checkRequests(force) {
	if (!token() || (!force && Date.now() - reqCheckedAt < 60000)) return;
	reqCheckedAt = Date.now();
	try { showRequests((await apiJSON("/api/people")).people || []); } catch (e) {}
}
document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") checkRequests(false); });
setInterval(function () { if (document.visibilityState === "visible") checkRequests(true); }, 5 * 60 * 1000);

// A library card request from the landing page: Approve makes their link to send, Decline drops it.
function requestRow(p) {
	var li = h("li", "req"), who = h("div", "who"), acts = h("div", "acts");
	who.append(h("b", null, p.name), h("span", null, "Asked for a library card " + ago(p.requested_at)));
	if (p.request_email) who.append(h("div", "muted", p.request_email));
	if (p.request_note) who.append(h("q", null, p.request_note));
	acts.append(
		button("Approve", "btn small primary", function () {
			apiJSON("/api/people/" + p.id + "/link", { method: "POST" }).then(function (d) {
				showInvite(d.person, d.code, p.request_email);
				if (p.request_email) location.href = inviteMail(p.name, p.request_email, inviteLink(d.code));
				window.scrollTo(0, 0);
				return loadPeople();
			}).catch(fail);
		}),
		button("Decline", "btn small danger", function () {
			if (!confirm("Decline " + p.name + "'s request?")) return;
			apiJSON("/api/people/" + p.id, { method: "DELETE" }).then(loadPeople).catch(fail);
		}));
	li.append(who, acts);
	return li;
}
function renderPeople(people) {
	var ul = $("people");
	ul.textContent = "";
	people.forEach(function (p) {
		if (p.requested_at) { ul.append(requestRow(p)); return; }
		var li = h("li"), who = h("div", "who");
		who.append(h("b", null, p.name), h("span", null, personStatus(p)));
		var log = h("ul", "dlog");
		log.hidden = true;
		if (p.downloads) who.append(h("br"), button(p.downloads + (p.downloads === 1 ? " download" : " downloads") + " ›", "btn ghost small dlbtn", function () {
			if (!log.hidden) { log.hidden = true; return; }
			apiJSON("/api/people/" + p.id + "/downloads").then(function (d) {
				log.textContent = "";
				d.downloads.forEach(function (x) {
					var row = h("li");
					row.append(h("span", "dt", x.title), h("span", "muted", " " + [x.author, ago(x.at)].filter(Boolean).join(" · ")));
					log.append(row);
				});
				log.hidden = false;
			}).catch(fail);
		}));
		var acts = h("div", "acts");
		acts.append(
			button("New link", "btn small", function () {
				if (p.signed_in && !confirm("Make a new link for " + p.name + "? Their old link and every device they're signed in on stop working.")) return;
				apiJSON("/api/people/" + p.id + "/link", { method: "POST" }).then(function (d) { showInvite(d.person, d.code, p.request_email); return loadPeople(); }).catch(fail);
			}),
			button("Remove", "btn small danger", function () {
				if (!confirm("Remove " + p.name + "? They're signed out at once, and their download history goes too.")) return;
				apiJSON("/api/people/" + p.id, { method: "DELETE" }).then(function () {
					if ($("famLink").dataset.person === String(p.id)) show($("famLink"), false);
					return loadPeople();
				}).catch(fail);
			}));
		li.append(who, acts, log);
		ul.append(li);
	});
	show($("famEmpty"), !people.length);
}
// The link is shown once: only its hash is kept, so "New link" is the way to get another.
function inviteLink(code) { return location.origin + "/library#invite=" + code; }
// A ready-to-send email in the owner's own mail app; nothing goes through the Worker.
function inviteMail(name, email, link) {
	var first = name.split(/\s+/)[0];
	var body = "Hi " + first + ",\n\n" +
		"Your library card came through. Here's your way into The Back Alley Library:\n\n" + link + "\n\n" +
		"It's yours alone: it works once, on the device you open it on, and runs out in 7 days. Open it on the phone or tablet you'll read on, then save the page so you can find your way back.\n\n" +
		"See you in the stacks.";
	return "mailto:" + email.replace(/[?&#%]/g, encodeURIComponent) + "?subject=" + encodeURIComponent("Your library card for The Back Alley Library") + "&body=" + encodeURIComponent(body);
}
function showInvite(person, code, email) {
	var box = $("famLink"), link = inviteLink(code);
	box.textContent = "";
	box.dataset.person = person.id;
	var input = h("input");
	input.type = "text";
	input.readOnly = true;
	input.value = link;
	input.setAttribute("aria-label", "Link for " + person.name);
	input.addEventListener("focus", function () { input.select(); });
	var row = h("div", "row");
	row.append(button("Copy", "btn small", function () {
		navigator.clipboard.writeText(link).then(function () { toast("Link copied."); }, function () { input.select(); });
	}));
	if (email) row.append(button("Email", "btn small", function () { location.href = inviteMail(person.name, email, link); }));
	if (navigator.share) row.append(button("Share", "btn small", function () {
		navigator.share({ title: "Reader library", text: "Here's your link to my library. It works once, on the device you open it on.", url: link }).catch(function () {});
	}));
	box.append(h("b", null, "Link for " + person.name), input, row,
		h("div", "hint", "Send it now; it isn't shown again. It works once and runs out in 7 days."));
	show(box, true);
}
$("famForm").addEventListener("submit", function (e) {
	e.preventDefault();
	var name = $("famName").value.trim();
	if (!name) { $("famName").focus(); return; }
	$("famMake").disabled = true;
	apiJSON("/api/people", { method: "POST", json: { name: name } }).then(function (d) {
		$("famName").value = "";
		showInvite(d.person, d.code);
		return loadPeople();
	}).catch(fail).then(function () { $("famMake").disabled = false; });
});

function goBack() {
	// The player page opens from the player bar, over whatever was showing.
	var listening = state.route && state.route.name === "listen";
	if (state.fromList || (listening && state.prev)) history.back();
	else if (listening) location.hash = "#/record/" + state.route.id;
	else location.hash = state.route && (state.route.name === "book" || state.route.name === "record") ? "#/library" : state.lastList;
}

// ---------- article view

async function openItem(id) {
	showView("article");
	window.scrollTo(0, 0);
	$("aTitle").textContent = "";
	$("aMeta").textContent = "";
	$("aBody").textContent = "";
	$("aBody").append(h("p", "loading", "Loading…"));
	show($("aFull"), false);
	show($("aNav"), false);
	show($("aEpisode"), false);
	$("aEpisode").textContent = "";
	show($("aCoverage"), false);
	$("aCoverage").textContent = "";
	var it;
	try {
		it = (await apiJSON("/api/items/" + id)).item;
	} catch (e) {
		// Offline, a downloaded video still opens (its text doesn't).
		if (e.message === UNAUTH || !downloads[id]) throw e;
		it = Object.assign({ read: 1, saved: 0 }, downloads[id]);
	}
	if (!state.route || state.route.id !== id) return;
	state.item = it;
	renderItemNav();
	renderEpisodeBox();
	document.title = (it.title || "Untitled") + " — Reader";
	$("aTitle").textContent = it.title || "Untitled";
	$("aMeta").textContent = [it.feed_title, it.author, longDate(it.published_at || it.created_at)].filter(Boolean).join(" · ");
	if (it.link) $("aLink").href = it.link; else $("aLink").removeAttribute("href");
	show($("aLink"), !!it.link);
	show($("aShare"), !!it.link);
	var row = storyRow(it);
	if (!it.read || (row && !row.read)) setFlags(it, { read: 1 });
	renderItemButtons();
	if (!it.media_url) loadCoverage(it);
	// Copies saved before gallery slides were read kept only the first photo
	// (and AP's "License this photo" links): fetched again once.
	if (it.content && !(it.link && /License this photo/i.test(it.content))) {
		$("aBody").textContent = "";
		$("aBody").append(sanitize(it.content, it.link || it.site_url || location.href));
		dropEpisodeCopy($("aBody"), it);
		enhanceEmbeds($("aBody"));
		show($("aFull"), !!it.link && $("aBody").textContent.trim().length < 600);
	} else if (it.link) {
		await loadFull(it);
	} else {
		$("aBody").textContent = "";
		$("aBody").append(h("p", "muted", "This item has no text."));
	}
}
async function loadFull(it) {
	var body = $("aBody");
	show($("aFull"), false);
	body.textContent = "";
	body.append(h("p", "loading", "Fetching the article…"));
	try {
		var page = await proxyGet(it.link);
		var ex = extract(page.text, page.url);
		var holder = h("div");
		holder.append(sanitize(ex.html, ex.base));
		if (holder.textContent.trim().length < 80) throw new Error("Couldn't find the article text on that page.");
		if (state.item !== it) return;
		var html = holder.innerHTML;
		body.textContent = "";
		while (holder.firstChild) body.appendChild(holder.firstChild);
		enhanceEmbeds(body);
		// Keep it, so the next open is instant (it's re-sanitized every time).
		if (html.length < 400000) {
			it.content = html;
			api("/api/items/" + it.id, { method: "PATCH", json: { content: html } }).catch(function () {});
		}
	} catch (e) {
		if (e.message === UNAUTH || state.item !== it) return;
		body.textContent = "";
		var p = h("p", "err", e.message + " ");
		body.append(p);
	}
}
// ---------- coverage
// When other feeds carry the same story, a box above the article names them
// and offers "Compare coverage": the Worker finds the matches (no AI), and
// comparing sends each article's full text to it for a digest from an AI
// model, which it saves (see "Coverage" in the Worker). The text is what reading
// the article would show: its saved copy, or for a feed that only sends a
// teaser, the page fetched and extracted (and saved, as opening it would).
// A saved digest opens at once, from any of the articles in it.

// Under this much text, a saved copy is taken for the feed's teaser.
var COVERAGE_PARTIAL = 1500;
async function loadCoverage(it) {
	var data;
	try { data = await apiJSON("/api/items/" + it.id + "/coverage"); } catch (e) { return; }
	if (state.item !== it) return;
	it.coverage = data;
	renderCoverage(it, false);
}
function renderCoverage(it, open, status, bad) {
	var data = it.coverage, box = $("aCoverage");
	box.textContent = "";
	var others = data.sources.filter(function (s) { return s.id !== it.id; });
	if (!others.length && !data.digest) { show(box, false); return; }
	show(box, true);
	var head = h("div", "covhead");
	var lbl = h("span", "lbl", others.length ? "Also covered by " : "Compared earlier");
	others.forEach(function (s, i) {
		if (i) lbl.append(i === others.length - 1 ? " and " : ", ");
		var a = h("a", null, s.feed_title);
		a.href = "#/item/" + s.id;
		a.title = s.title;
		lbl.append(a);
	});
	head.append(lbl);
	var busy = status && !bad;
	if (data.digest) {
		var toggle = h("button", "btn small", open ? "Hide digest" : "Show coverage digest");
		toggle.type = "button";
		toggle.disabled = busy;
		toggle.addEventListener("click", function () {
			if (open) readDigest(it);
			renderCoverage(it, !open);
		});
		head.append(toggle);
	}
	if (!data.digest || data.new_sources) {
		var go = h("button", "btn small" + (data.digest ? "" : " primary"),
			data.digest ? "Compare again (" + data.new_sources + " new)" : "Compare coverage");
		go.type = "button";
		go.disabled = busy;
		go.addEventListener("click", function () { compareCoverage(it).catch(fail); });
		head.append(go);
	}
	box.append(head);
	if (status) box.append(h("p", "covstatus" + (bad ? " err" : ""), status));
	if (open && data.digest) box.append(digestView(data.digest));
}
// Hiding the digest marks every article it compared as read: having read
// the comparison, there's no need to open each one.
function readDigest(it) {
	var data = it.coverage, byId = {};
	data.sources.forEach(function (s) { byId[s.id] = s; });
	(data.digest.articles || []).forEach(function (a) {
		var x = a.id === it.id ? it : byId[a.id] || { id: a.id };
		if (!x.read) setFlags(x, { read: 1 });
	});
}
function digestView(d) {
	var wrap = h("div"), byId = {};
	(d.articles || []).forEach(function (a) { byId[a.id] = a; });
	function name(id) { return byId[id] ? byId[id].feed_title : "?"; }
	wrap.append(h("h3", null, d.headline));
	if (d.summary.length) {
		wrap.append(h("h4", null, "What the sources agree on"));
		var ul = h("ul");
		d.summary.forEach(function (p) {
			var li = h("li", null, p.text + " ");
			li.append(h("span", "who", "(" + p.sources.map(name).join(", ") + ")"));
			ul.append(li);
		});
		wrap.append(ul);
	}
	if (d.perspectives.length) {
		wrap.append(h("h4", null, "What the sources are saying"));
		(d.articles || []).forEach(function (a) {
			var mine = d.perspectives.filter(function (p) { return p.source === a.id; });
			if (!mine.length) return;
			var h5 = h("h5"), link = h("a", null, a.feed_title);
			link.href = "#/item/" + a.id;
			link.title = a.title;
			h5.append(link);
			var ul = h("ul");
			mine.forEach(function (p) {
				var li = h("li");
				li.append(h("span", "kind", p.kind === "differs" ? "Differs" : "Only here"), p.text);
				var q = h(p.link ? "a" : "span", "quote", "“" + p.quote + "”" + (p.link ? " ↗" : ""));
				if (p.link) { q.href = p.link; q.target = "_blank"; q.rel = "noopener noreferrer"; q.title = "Open this passage at " + a.feed_title; }
				li.append(q);
				ul.append(li);
			});
			wrap.append(h5, ul);
		});
	} else if (d.summary.length) {
		wrap.append(h("p", "fine", "No source reported anything the others didn't."));
	}
	var fine = [];
	if (d.note) fine.push(d.note);
	d.excluded.forEach(function (e) { fine.push("Left out " + name(e.id) + ": " + e.reason); });
	if (d.partial.length) fine.push("Only an excerpt was available from " + d.partial.map(name).join(", ") + ", so it can't be said to leave anything out.");
	if (d.dropped) fine.push(d.dropped + (d.dropped === 1 ? " point was" : " points were") + " dropped because the quote backing it wasn't in the article.");
	fine.push("Compared " + longDate(d.created_at) + " by " + d.model + ". Check the quotes before relying on a point.");
	fine.forEach(function (t) { wrap.append(h("p", "fine", t)); });
	return wrap;
}
async function compareCoverage(it) {
	var sources = it.coverage.sources;
	renderCoverage(it, false, "Getting the full text of " + sources.length + " articles…");
	var texts = await Promise.all(sources.map(function (s) {
		return articleText(s.id === it.id ? it : s.id).catch(function () { return { text: "" }; });
	}));
	if (state.item !== it) return;
	renderCoverage(it, false, "Comparing " + sources.length + " sources. This can take a minute…");
	var res;
	try {
		res = await apiJSON("/api/items/" + it.id + "/coverage", {
			method: "POST",
			json: { sources: sources.map(function (s, i) { return { id: s.id, text: texts[i].text, partial: texts[i].partial }; }) },
		});
	} catch (e) {
		if (e.message === UNAUTH) throw e;
		if (state.item === it) renderCoverage(it, !!it.coverage.digest, e.message, true);
		return;
	}
	it.coverage.digest = res.digest;
	it.coverage.new_sources = 0;
	if (state.item === it) renderCoverage(it, true);
}
// An article's text for comparing, as {text, partial}: paragraphs as plain
// text, and whether it's only the feed's teaser because the page itself
// couldn't be fetched or had no article to find.
async function articleText(itemOrId) {
	var it = typeof itemOrId === "object" ? itemOrId : (await apiJSON("/api/items/" + itemOrId)).item;
	var holder = h("div");
	holder.append(sanitize(it.content || "", it.link || it.site_url || location.href));
	var text = blockText(holder);
	if (text.length >= COVERAGE_PARTIAL) return { text: text, partial: false };
	if (!it.link) return { text: text, partial: false };
	try {
		var page = await proxyGet(it.link), ex = extract(page.text, page.url), full = h("div");
		full.append(sanitize(ex.html, ex.base));
		var more = blockText(full);
		// Nothing found on the page means a paywall or an odd layout; the same or less, that the copy was whole.
		if (more.length < 80) return { text: text, partial: true };
		if (more.length <= text.length) return { text: text, partial: false };
		var html = full.innerHTML;
		if (html.length < 400000) {
			it.content = html;
			api("/api/items/" + it.id, { method: "PATCH", json: { content: html } }).catch(function () {});
		}
		return { text: more, partial: false };
	} catch (e) {
		if (e.message === UNAUTH) throw e;
		return { text: text, partial: true };
	}
}
// The article's text, a paragraph per block, for comparing. Leaves out what
// a page hangs on the end of a story: "Previously:" and "Related" lists, and
// teasers for other posts ("... READ THE REST"), so they aren't compared.
var OTHER_STORIES = /^(previously|related( stories| posts| articles| coverage| reading)?|more (from|on|stories)\b[^:]{0,40}|read (more|next|this next)|see also|further reading|recommended( for you| reading)?|you (may|might) also like|trending|popular)\s*:/i;
var TEASER_END = /(read the rest|read more|continue reading|keep reading|full story)\W*$/i;
function blockText(node) {
	var out = [], seen = 0;
	node.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, pre, td, dd").forEach(function (b) {
		if (b.querySelector("p, li")) return;
		var t = b.textContent.replace(/\s+/g, " ").trim();
		if (!t) return;
		seen += t.length;
		if (OTHER_STORIES.test(t) || TEASER_END.test(t) || linkShare(b, t) >= 0.6) return;
		out.push(t);
	});
	var joined = out.join("\n\n"), all = node.textContent.replace(/\s+/g, " ").trim();
	return seen >= all.length * 0.6 ? joined : all;
}
// How much of a block's text is link text: a list of links to other posts is nearly all.
function linkShare(b, t) {
	var n = 0;
	b.querySelectorAll("a").forEach(function (a) { n += a.textContent.replace(/\s+/g, " ").trim().length; });
	return t.length > 0 ? n / t.length : 0;
}

// ---------- next / previous item
// Steps through the list the article was opened from (state.items), by the
// buttons under it, the arrow or j/k keys, or a sideways swipe. Opened
// straight from a link, there's no list to step through, so none show.

function navList() { return state.fromPodcasts ? { items: state.episodes, next: state.epNext } : { items: state.items, next: state.next }; }
function itemIndex() {
	var it = state.item, list = navList().items;
	if (!it || !state.fromList) return -1;
	var story = it.story_id || it.id;
	for (var i = 0; i < list.length; i++) if (list[i].id === it.id || (list[i].story || list[i].id) === story) return i;
	return -1;
}
function renderItemNav() {
	var i = itemIndex(), nav = navList();
	show($("aNav"), i >= 0);
	$("aPrev").disabled = i <= 0;
	$("aNext").disabled = i < 0 || (i >= nav.items.length - 1 && !nav.next);
}
async function stepItem(dir) {
	var i = itemIndex();
	if (i < 0) return;
	if (dir > 0 && i >= navList().items.length - 1) {
		if (!navList().next) return;
		await (state.fromPodcasts ? loadEpisodes(true) : loadItems(true));
		i = itemIndex();
	}
	var to = navList().items[i + dir];
	if (to) location.replace("#/item/" + to.id);
}
function onArticle() { return !$("articleView").hidden && state.item; }
document.addEventListener("keydown", function (e) {
	if (!onArticle() || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
	if (e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
	var dir = e.key === "ArrowRight" || e.key === "j" ? 1 : e.key === "ArrowLeft" || e.key === "k" ? -1 : 0;
	if (!dir) return;
	e.preventDefault();
	stepItem(dir).catch(fail);
});
// A quick, mostly sideways swipe: left for next, right for previous. It
// ignores touches near the screen edges (iPhone's back swipe) and on
// anything that scrolls sideways itself, like a wide table or code block.
var swipe = null;
function scrollsSideways(node) {
	for (; node && node !== document.body; node = node.parentElement)
		if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return true;
	return false;
}
$("articleView").addEventListener("touchstart", function (e) {
	var t = e.touches[0];
	swipe = e.touches.length === 1 && t.clientX > 24 && t.clientX < window.innerWidth - 24 && !scrollsSideways(e.target)
		? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
}, { passive: true });
$("articleView").addEventListener("touchend", function (e) {
	if (!swipe) return;
	var t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y, quick = Date.now() - swipe.at < 700;
	swipe = null;
	if (!quick || Math.abs(dx) < 70 || Math.abs(dx) < 2 * Math.abs(dy)) return;
	if (String(window.getSelection() || "")) return;
	stepItem(dx < 0 ? 1 : -1).catch(fail);
}, { passive: true });
$("articleView").addEventListener("touchcancel", function () { swipe = null; }, { passive: true });
$("aPrev").addEventListener("click", function () { stepItem(-1).catch(fail); });
$("aNext").addEventListener("click", function () { stepItem(1).catch(fail); });

function renderItemButtons() {
	var it = state.item;
	if (!it) return;
	$("aSave").textContent = it.saved ? "★ Saved" : "Save";
	$("aSave").setAttribute("aria-pressed", String(!!it.saved));
	$("aRead").textContent = it.read ? "Mark unread" : "Mark read";
}
async function setFlags(it, patch) {
	var row = storyRow(it), before = { read: row ? row.read : it.read, saved: it.saved };
	applyFlags(it, patch);
	if (patch.read === 0) dropPending(it.id);
	try {
		await apiJSON("/api/items/" + it.id, { method: "PATCH", json: patch });
	} catch (e) {
		// Read stays read here and is sent again later (see pendingReads).
		if (e.message !== UNAUTH && patch.read === 1 && patch.saved == null) return queueReads([it.id]);
		applyFlags(it, before);
		fail(e);
	}
}
// Read or unread covers the item's whole story (the server does the same),
// and a story counts once.
function storyRow(it) {
	var story = it.story_id || it.id;
	return state.items.filter(function (x) { return x.id === it.id || (x.story || x.id) === story; })[0];
}
function applyFlags(it, patch) {
	var story = it.story_id || it.id, row = storyRow(it);
	var listed = state.items.filter(function (x) { return x.id === it.id; })[0];
	var feed = state.feeds.filter(function (f) { return f.id === it.feed_id; })[0];
	var wasRead = row ? row.read : it.read;
	// An episode or video counts toward its show's unread, not the feed list's.
	var count = !it.media_url ? "unread" : isAudio(it) ? "unread_episodes" : "unread_videos";
	if (patch.read != null && feed && !!patch.read !== !!wasRead) feed[count] = Math.max(0, (feed[count] || 0) + (patch.read ? -1 : 1));
	[it, listed].forEach(function (x) { if (x && patch.saved != null) x.saved = patch.saved; });
	if (patch.read != null) {
		it.read = patch.read;
		state.items.forEach(function (x) {
			if (x.id !== it.id && (x.story || x.id) !== story) return;
			x.read = patch.read;
			(x.related || []).forEach(function (r) { r.read = patch.read; });
		});
	}
	renderItemButtons();
}

// ---------- podcasts
// Any item whose feed entry has an audio or video file (an enclosure) is an
// episode. Audio plays in the bar at the bottom, which keeps going while you
// read and shows on the lock screen; video plays in the article, and is
// listed under Videos instead. So are YouTube, Twitch and Vimeo videos from
// a channel's feed (see videoPage); those play in their own player and
// can't be downloaded. Where you
// stopped is saved on the item (media_pos), so another device picks up there
// too. Download keeps the file in this browser's storage (Cache Storage) for
// listening offline; the list of what's downloaded is in localStorage, so
// the Podcasts tab can show it with no connection at all.

var EP_CACHE = "reader-episodes-v1";
var downloads = readJSON("readerDownloads") || {};
var positions = readJSON("readerPositions") || {};
var dlProgress = {};

function epKey(id) { return location.origin + "/episode/" + id; }
function isAudio(ep) { return !/^video\//.test(ep.media_type || ""); }
// YouTube, Twitch or Vimeo: no file to download, only their player.
function isHosted(ep) { return /^video\/x-(youtube|twitch|vimeo)$/.test(ep.media_type || ""); }
function inTab(ep) { return state.epKind === "videos" ? !isAudio(ep) : isAudio(ep); }
function epFields(it) {
	return { id: it.id, feed_id: it.feed_id, feed_title: it.feed_title || "", title: it.title || "Untitled", media_url: it.media_url,
		media_type: it.media_type || "audio/mpeg", media_pos: it.media_pos, media_len: it.media_len, published_at: it.published_at, created_at: it.created_at,
		notes: it.notes || null, feed_image: it.feed_image || null };
}
function saveDownloads() { store("readerDownloads", JSON.stringify(downloads)); }
// The furthest point reached on this device or saved on the item.
function epPos(ep) {
	var local = positions[ep.id] || 0, server = ep.media_pos || 0;
	return Math.max(local, server);
}
function epLen(ep) { return ep.media_len || (downloads[ep.id] && downloads[ep.id].media_len) || 0; }
function epPlayed(ep) { var len = epLen(ep); return len > 0 && epPos(ep) >= len - 30; }
function clock(sec) {
	sec = Math.max(0, Math.floor(sec || 0));
	var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
	return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(s).padStart(2, "0");
}
function epStatus(ep) {
	var len = epLen(ep), pos = epPos(ep);
	if (epPlayed(ep)) return "Played";
	if (len && pos > 5) return Math.max(1, Math.round((len - pos) / 60)) + " min left";
	if (len) return Math.round(len / 60) + " min";
	return "";
}

// Podcasts and Videos: the shows (or channels), as a gallery of their
// artwork (a drawn tile where one has none yet), each with its unread
// episodes in the corner; a show opens its own episodes
// (#/podcasts?feed=<id>). What's downloaded stays one newest-first list.
function galleryOn() { return state.epFeed == null && !state.epDownloadedOnly; }
async function showPodcasts(r) {
	var back = state.prev && state.prev.name === "item";
	var changed = !sameId(state.epFeed, r.feed) || state.epKind !== r.name;
	if (changed) state.episodes = [];
	if (state.epKind !== r.name) { openEpAdd(false); $("epFound").textContent = ""; epAddStatus(""); $("epAddUrl").value = ""; }
	state.epKind = r.name;
	state.epFeed = r.feed;
	showView("podcasts");
	renderTabs(r.name);
	renderEpHead();
	if (!(back && !changed)) window.scrollTo(0, 0);
	if (galleryOn()) return await loadShows();
	if (back && !changed && state.episodes.length) { renderEpisodes(); return; }
	await loadEpisodes(false);
}
function reloadPodcasts() { return galleryOn() ? loadShows() : loadEpisodes(false); }
// The show being viewed, if one is.
function epShow() {
	return state.epFeed == null ? null : state.feeds.filter(function (f) { return f.id === state.epFeed; })[0] || null;
}
// A feed's count, unread count and newest date for the tab being viewed.
function showStats(f) {
	return state.epKind === "videos" ? { n: f.videos || 0, unread: f.unread_videos || 0, latest: f.latest_video }
		: { n: f.episodes || 0, unread: f.unread_episodes || 0, latest: f.latest_episode };
}
function renderEpHead() {
	var f = epShow(), name = f ? f.title : MEDIA_TABS[state.epKind];
	$("epHead").textContent = name;
	document.title = name + " — Reader";
	var up = $("epUp");
	up.textContent = "‹ " + MEDIA_TABS[state.epKind];
	up.href = "#/" + state.epKind;
	show(up, state.epFeed != null);
	show($("epAllRead"), !!f && showStats(f).unread > 0);
	show($("epAdd"), galleryOn());
	if (!galleryOn()) openEpAdd(false);
}
// Shows the gallery from the feeds already here at once, then again with
// fresh counts (an episode opened since is read now).
async function loadShows() {
	renderShows();
	try {
		await loadFeeds();
		state.epOffline = false;
	} catch (e) {
		if (e.message === UNAUTH) return;
		state.epOffline = true;
	}
	if (!state.route || !MEDIA_TABS[state.route.name] || state.route.name !== state.epKind || !galleryOn()) return;
	// No connection and no shows to draw: what's downloaded still plays.
	if (state.epOffline && !podShows().length) return await loadEpisodes(false);
	renderEpHead();
	renderShows();
}
// Every feed with an episode (or a video) in it, newest first.
function podShows() {
	return state.feeds.filter(function (f) { return showStats(f).n > 0; })
		.sort(function (a, b) { return (showStats(b).latest || 0) - (showStats(a).latest || 0) || a.title.localeCompare(b.title); });
}
function renderShows() {
	var ul = $("shows"), videos = state.epKind === "videos";
	ul.textContent = "";
	podShows().forEach(function (f) {
		var li = h("li"), a = h("a"), art = h("div", "showart"), x = showStats(f);
		a.href = "#/" + state.epKind + "?feed=" + f.id;
		a.setAttribute("aria-label", f.title + (x.unread ? ", " + x.unread + " unread" : ""));
		showArt(art, f, videos);
		if (x.unread) art.append(h("span", "unreadn", x.unread > 99 ? "99+" : String(x.unread)));
		a.append(art, h("span", "ct", f.title),
			h("span", "ca", [x.n + (videos ? (x.n === 1 ? " video" : " videos") : x.n === 1 ? " episode" : " episodes"), ago(x.latest)].filter(Boolean).join(" · ")));
		li.append(a);
		ul.append(li);
	});
	show(ul, true);
	show($("episodes"), false);
	show($("epMore"), false);
	$("epEmpty").textContent = state.epOffline ? "You're offline."
		: videos ? "No videos yet. Add a YouTube channel, or another video feed, to get started."
		: "No podcasts yet. Add a podcast's feed to get started.";
	show($("epEmpty"), !ul.children.length);
	$("epNote").textContent = "You're offline. The counts are from when you were last online.";
	show($("epNote"), state.epOffline && !!ul.children.length);
	paintEpFilter();
}
// + Add on a gallery. Podcasts: words search Apple's podcast directory (no
// key needed), a link is followed as is (an Apple Podcasts page is looked up
// there for its feed). Videos: a channel's link or its @handle; YouTube has
// no search without an API key.
var ITUNES = "https://itunes.apple.com/";
function looksLikeLink(v) { return /^(https?:\/\/|www\.)|^[\w-]+(\.[\w-]+)+(\/|$)/i.test(v) || /^@[\w.-]+$/.test(v); }
function openEpAdd(on) {
	show($("epAddBox"), on);
	$("epAdd").setAttribute("aria-expanded", String(on));
	$("epAdd").classList.toggle("on", on);
	if (!on) return;
	var videos = state.epKind === "videos";
	$("epAddUrl").placeholder = videos ? "Paste a YouTube channel link or @handle" : "Search podcasts, or paste a feed link";
	paintEpAddGo();
	$("epAddUrl").focus();
}
function paintEpAddGo() {
	var v = $("epAddUrl").value.trim();
	$("epAddGo").textContent = state.epKind === "videos" || looksLikeLink(v) ? "Add" : "Search";
}
function epAddStatus(msg, bad) {
	var s = $("epAddStatus");
	s.textContent = msg;
	s.classList.toggle("err", !!bad);
	show(s, !!msg);
}
async function epAddSubmit(e) {
	e.preventDefault();
	var v = $("epAddUrl").value.trim();
	if (!v) return;
	$("epFound").textContent = "";
	if (state.epKind === "videos" || looksLikeLink(v)) return epFollow(await epLink(v));
	$("epAddGo").disabled = true;
	epAddStatus("Searching…");
	try {
		var res = await itunes("search?media=podcast&entity=podcast&limit=12&term=" + encodeURIComponent(v));
		var list = res.filter(function (x) { return x.feedUrl; });
		epAddStatus(list.length ? "" : "Nothing found for “" + v + "”. A feed link works too.");
		list.forEach(function (x) { $("epFound").append(foundRow(x)); });
	} catch (err) {
		if (err.message !== UNAUTH) epAddStatus("Couldn't search: " + err.message, true);
	} finally { $("epAddGo").disabled = false; }
}
async function itunes(path) {
	var r = await proxyGet(ITUNES + path);
	return JSON.parse(r.text).results || [];
}
// What a typed link means: an @handle is a YouTube channel, and an Apple
// Podcasts page's feed is in Apple's directory.
async function epLink(v) {
	if (/^@[\w.-]+$/.test(v)) return "https://www.youtube.com/" + v;
	var m = /podcasts\.apple\.com\/.*\/id(\d+)/.exec(v);
	if (m) {
		try {
			var hit = (await itunes("lookup?entity=podcast&id=" + m[1]))[0];
			if (hit && hit.feedUrl) return hit.feedUrl;
		} catch (e) {}
	}
	return v;
}
function foundRow(x) {
	var li = h("li"), info = h("div", "fi"), b = h("button", "btn small", "Add");
	var f = state.feeds.filter(function (y) { return y.feed_url === x.feedUrl; })[0];
	if (x.artworkUrl100) {
		var img = h("img");
		img.alt = "";
		img.loading = "lazy";
		img.src = x.artworkUrl100.replace(/^http:/, "https:");
		li.append(img);
	} else li.append(h("span", "noart"));
	info.append(h("span", "ft", x.collectionName || x.trackName || x.feedUrl), h("span", "fa", x.artistName || ""));
	b.type = "button";
	if (f) { b.textContent = "Added"; b.disabled = true; }
	b.addEventListener("click", function () { epFollow(x.feedUrl, b); });
	li.append(info, b);
	return li;
}
async function epFollow(link, btn) {
	if (btn) btn.disabled = true;
	$("epAddGo").disabled = true;
	epAddStatus("Looking for a feed…");
	try {
		// A page with no feed would be watched as news: not wanted here.
		var x = await follow(link, [], true), feed = x.data.feed;
		await loadFeeds();
		var mine = state.feeds.filter(function (y) { return y.id === feed.id; })[0] || feed;
		var where = mine.videos > 0 && state.epKind !== "videos" ? " It's under Videos." : mine.episodes > 0 && state.epKind !== "podcasts" ? " It's under Podcasts."
			: !mine.episodes && !mine.videos ? " It has no episodes or videos, so it's with the news feeds." : "";
		epAddStatus((x.data.existing ? "Already following " : "Added ") + feed.title + "." + where);
		if (btn) btn.textContent = "Added";
		else $("epAddUrl").value = "";
		renderShows();
	} catch (err) {
		if (btn) btn.disabled = false;
		if (err.message !== UNAUTH) epAddStatus("Couldn't add that: " + err.message, true);
	} finally { $("epAddGo").disabled = false; }
}

// A show's artwork; a tile with its name where it has none, or the picture
// doesn't load.
var SCREEN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10 9.5v5l4.5-2.5z"/></svg>';
function showArt(box, f, videos) {
	var draw = function () {
		var g = h("div", "gen");
		g.style.backgroundColor = coverColor(f.title);
		g.setAttribute("aria-hidden", "true");
		g.append(h("span", null, f.title));
		g.insertAdjacentHTML("beforeend", videos ? SCREEN_SVG : LISTEN_ICON);
		box.prepend(g);
	};
	if (!f.image_url) return draw();
	var img = h("img");
	img.alt = "";
	img.loading = "lazy";
	img.decoding = "async";
	img.addEventListener("error", function () { img.remove(); draw(); });
	img.src = f.image_url.replace(/^http:/, "https:");
	box.append(img);
}
async function loadEpisodes(append) {
	if (state.epDownloadedOnly) { state.episodes = downloadedList(); state.epNext = null; state.epOffline = false; renderEpisodes(); return; }
	if (!append && !state.episodes.length) { $("epEmpty").textContent = "Loading…"; show($("epEmpty"), true); show($("shows"), false); }
	try {
		var data = await apiJSON("/api/items?view=" + state.epKind + "&limit=50" + (state.epFeed != null ? "&feed=" + state.epFeed : "") +
			(append && state.epNext ? "&before=" + encodeURIComponent(state.epNext) : ""));
		state.episodes = (append ? state.episodes : []).concat(data.items.map(epFields));
		state.epNext = data.next;
		state.epOffline = false;
	} catch (e) {
		if (e.message === UNAUTH) return;
		// No connection: what's downloaded still plays.
		state.episodes = downloadedList();
		state.epNext = null;
		state.epOffline = true;
	}
	renderEpisodes();
}
function downloadedList() {
	return Object.keys(downloads).map(function (id) { return downloads[id]; })
		.filter(function (ep) {
			if (!inTab(ep)) return false;
			return state.epFeed == null || ep.feed_id === state.epFeed;
		})
		.sort(function (a, b) { return (b.published_at || b.created_at || 0) - (a.published_at || a.created_at || 0); });
}
// An episode's line under its title; inside a show, without the show's name.
function epMeta(ep) {
	return [state.epFeed != null ? "" : ep.feed_title, ago(ep.published_at || ep.created_at), epStatus(ep)].filter(Boolean).join(" · ");
}
function renderEpisodes() {
	var ul = $("episodes");
	ul.textContent = "";
	state.episodes.forEach(function (ep) {
		var li = h("li", epPlayed(ep) ? "read" : ""), a = h("a");
		li.dataset.id = ep.id;
		a.href = "#/item/" + ep.id;
		var dot = h("span", "dot");
		a.append(dot, h("span", "t", ep.title));
		a.append(h("span", "m", epMeta(ep)));
		var btns = h("div", "ep-btns");
		btns.append(playButton(ep, true));
		if (!isHosted(ep)) btns.append(downloadButton(ep, true));
		btns.append(playedButton(ep));
		li.append(a, btns);
		if (ep.notes) li.append(notesButton(ep.notes));
		ul.append(li);
	});
	show($("shows"), false);
	show(ul, true);
	$("epEmpty").textContent = state.epDownloadedOnly ? "Nothing downloaded on this device."
		: state.epOffline ? "You're offline, and nothing is downloaded on this device."
		: state.epFeed != null ? "No episodes from this show yet."
		: state.epKind === "videos" ? "No videos yet. Add a YouTube channel, or another video feed, to get started."
		: "No episodes yet. Add a podcast's feed to get started.";
	show($("epEmpty"), !state.episodes.length);
	show($("epMore"), !!state.epNext);
	$("epNote").textContent = state.epOffline ? "You're offline. These are the ones downloaded on this device." : "";
	show($("epNote"), state.epOffline && !!state.episodes.length);
	paintEpFilter();
}
function paintEpFilter() {
	$("epFilter").setAttribute("aria-pressed", String(!!state.epDownloadedOnly));
	$("epFilter").classList.toggle("on", !!state.epDownloadedOnly);
}
// The start of the show notes under the title, two lines until tapped.
function notesButton(text) {
	var b = h("button", "notes", text);
	b.type = "button";
	b.setAttribute("aria-expanded", "false");
	b.addEventListener("click", function () {
		var open = b.classList.toggle("open");
		b.setAttribute("aria-expanded", String(open));
	});
	return b;
}
// The checkmark beside an episode: played or not, without listening. Played
// means the spot is at the end; an episode never started has no length yet,
// so it gets a stand-in of one second, replaced once it's played for real.
function playedButton(ep) {
	var b = h("button", "mark");
	b.type = "button";
	b.dataset.played = ep.id;
	b.innerHTML = CHECK_SVG;
	paintPlayed(b, ep);
	b.addEventListener("click", function (e) { e.preventDefault(); setPlayed(ep, !epPlayed(ep)); });
	return b;
}
function paintPlayed(b, ep) {
	var on = epPlayed(ep);
	b.setAttribute("aria-label", (on ? "Mark unplayed: " : "Mark played: ") + ep.title);
	b.title = on ? "Mark unplayed" : "Mark played";
}
function setPlayed(ep, on) {
	var len = epLen(ep), audio = $("pAudio"), mine = player.ep && player.ep.id === ep.id && audio.src;
	var real = len >= 60 ? len : null;
	var pos = on ? real || 1 : 0, patch = { media_pos: pos };
	if (on && !real) patch.media_len = 1;
	if (!on && len && !real) patch.media_len = null;
	// Unplayed is new again: back in its show's unread count (and a read
	// mark still waiting to be sent mustn't undo that).
	patch.read = on ? 1 : 0;
	if (!on) dropPending(ep.id);
	if (mine) { audio.pause(); player.savedAt = Date.now(); }
	positions[ep.id] = pos;
	store("readerPositions", JSON.stringify(positions));
	[ep, findListed(ep.id), downloads[ep.id], player.ep && player.ep.id === ep.id ? player.ep : null].forEach(function (x) {
		if (!x) return;
		x.media_pos = pos;
		if ("media_len" in patch) x.media_len = patch.media_len;
	});
	if (downloads[ep.id]) saveDownloads();
	// The bar's own save on pause would put the old spot back.
	if (mine) { try { audio.currentTime = on && real ? real : 0; } catch (e) {} }
	repaintEpisode(ep.id);
	api("/api/items/" + ep.id, { method: "PATCH", json: patch, keepalive: true }).catch(fail);
}
function playButton(ep, small) {
	var b = h("button", "btn" + (small ? " small" : " primary"));
	b.type = "button";
	b.dataset.play = ep.id;
	paintPlay(b, ep, small);
	b.addEventListener("click", function (e) { e.preventDefault(); playEpisode(ep, true).catch(fail); });
	return b;
}
function paintPlay(b, ep, small) {
	var mine = player.ep && player.ep.id === ep.id, playing = mine && !$("pAudio").paused;
	if (!isAudio(ep)) { b.textContent = small ? "▶" : "▶ Play"; return; }
	b.textContent = playing ? (small ? "❚❚" : "❚❚ Pause") : small ? "▶" : epPos(ep) > 5 && !epPlayed(ep) ? "▶ Resume" : "▶ Play";
	b.setAttribute("aria-label", (playing ? "Pause " : "Play ") + ep.title);
}
function downloadButton(ep, small) {
	var b = h("button", "btn" + (small ? " small" : ""));
	b.type = "button";
	b.dataset.dl = ep.id;
	paintDownload(b, ep, small);
	b.addEventListener("click", function (e) {
		e.preventDefault();
		if (dlProgress[ep.id]) return;
		if (downloads[ep.id]) { if (confirm("Remove the download of “" + ep.title + "” from this device?")) removeDownload(ep.id); }
		else downloadEpisode(ep);
	});
	return b;
}
function paintDownload(b, ep, small) {
	var p = dlProgress[ep.id];
	b.classList.toggle("on", !!downloads[ep.id]);
	if (p) b.textContent = p.total ? Math.floor(p.got / p.total * 100) + "%" : Math.round(p.got / 1048576) + " MB";
	else if (downloads[ep.id]) b.textContent = small ? "✓" : "✓ Downloaded";
	else b.textContent = small ? "⤓" : "⤓ Download";
	b.setAttribute("aria-label", (downloads[ep.id] ? "Remove download of " : "Download ") + ep.title);
}
// Repaint every play/download button for an episode, wherever it's shown.
function repaintEpisode(id) {
	var ep = findEpisode(id);
	if (!ep) return;
	document.querySelectorAll("[data-play='" + id + "']").forEach(function (b) { paintPlay(b, ep, b.classList.contains("small")); });
	document.querySelectorAll("[data-dl='" + id + "']").forEach(function (b) { paintDownload(b, ep, b.classList.contains("small")); });
	document.querySelectorAll("#episodes li[data-id='" + id + "'] .m").forEach(function (m) {
		m.textContent = epMeta(ep);
	});
	document.querySelectorAll("#episodes li[data-id='" + id + "']").forEach(function (li) { li.classList.toggle("read", epPlayed(ep)); });
	document.querySelectorAll("[data-played='" + id + "']").forEach(function (b) { paintPlayed(b, ep); });
	var when = document.querySelector("#aEpisode .when");
	if (when && state.item && state.item.id === id) when.textContent = epStatus(ep);
}
function findEpisode(id) {
	if (player.ep && player.ep.id === id) return player.ep;
	if (state.item && state.item.id === id && state.item.media_url) return state.itemEp;
	return state.episodes.filter(function (e) { return e.id === id; })[0] || downloads[id] || null;
}

// The box atop an episode's article.
function renderEpisodeBox() {
	var it = state.item, box = $("aEpisode");
	box.textContent = "";
	state.itemEp = it && it.media_url ? (player.ep && player.ep.id === it.id ? player.ep : epFields(it)) : null;
	var ep = state.itemEp;
	show(box, !!ep);
	if (!ep) return;
	if (isAudio(ep)) {
		var sb = h("button", "btn small sleepbtn", "Sleep"), so = sleepOptions("End of episode");
		sb.type = "button";
		sb.dataset.ep = ep.id;
		so.id = "aSleepOpts";
		sb.setAttribute("aria-controls", so.id);
		sleepPicker(sb, so);
		var vb = h("button", "btn small voicebtn", "Voice");
		vb.type = "button";
		vb.addEventListener("click", voiceNext);
		box.append(playButton(ep, false), downloadButton(ep, false), sb, vb, h("span", "when", epStatus(ep)), so);
		paintSleep();
		paintVoice();
	}
	else if (isHosted(ep)) videoBox.hosted(box, ep);
	else videoBox.file(box, ep);
}
// Feeds stored before this had the file as an <audio> in the text, and
// YouTube's feed has the player in it; the box above plays it now.
function dropEpisodeCopy(body, it) {
	if (!it.media_url) return;
	var key = hostedKey(it);
	if (key) {
		body.querySelectorAll("iframe").forEach(function (f) {
			if ((f.getAttribute("src") || "").indexOf(key) >= 0) (f.closest(".player") || f).remove();
		});
		return;
	}
	body.querySelectorAll("audio, video").forEach(function (m) {
		var srcs = [m.getAttribute("src")].concat([].map.call(m.querySelectorAll("source"), function (x) { return x.getAttribute("src"); }));
		if (srcs.indexOf(it.media_url) >= 0) m.remove();
	});
}
function hostedKey(it) {
	var m = /[?&]v=([\w-]{11})|\/videos\/(\d+)|vimeo\.com\/(\d+)/.exec(isHosted(it) ? it.media_url : "");
	return m ? (m[1] ? "/embed/" + m[1] : m[2] ? "video=v" + m[2] : "/video/" + m[3]) : null;
}

// Videos, in the box atop the article. A file gets the podcast player's
// controls (back 15, ahead 30, speed) beside the video's own; YouTube,
// Twitch and Vimeo get their player, which tells this page how far along
// it is by postMessage. Either way the spot is saved like an episode's.
var VRATE_KEY = "readerVideoRate";
var videoBox = {
	now: null, // { ep, el or frame, savedAt, pos, len }
	file: function (box, ep) {
		var v = h("video"), at = epPlayed(ep) ? 0 : epPos(ep), rate = Number(read(VRATE_KEY)) || 1;
		var cur = videoBox.now = { ep: ep, el: v, savedAt: 0 };
		v.controls = true; v.preload = "metadata"; v.setAttribute("playsinline", "");
		v.addEventListener("loadedmetadata", function once() {
			v.removeEventListener("loadedmetadata", once);
			if (at > 0 && at < v.duration - 1) v.currentTime = at;
			v.playbackRate = rate;
		});
		var track = function (now) {
			if (!(v.currentTime > 0)) return;
			var len = isFinite(v.duration) ? v.duration : null;
			keepPos(cur, v.ended && len ? len : v.currentTime, len, v.ended, now);
		};
		v.addEventListener("timeupdate", function () { track(false); });
		v.addEventListener("pause", function () { track(true); });
		v.addEventListener("ended", function () { track(true); });
		v.addEventListener("play", function () { $("pAudio").pause(); setSession(ep); });
		episodeSrc(ep).then(function (src) { v.src = src; fixVideo(v, state.item && state.item.link); });
		var btn = function (label, aria, fn) {
			var b = h("button", "btn small", label);
			b.type = "button";
			b.setAttribute("aria-label", aria);
			b.addEventListener("click", fn);
			return b;
		};
		var sk = function (by) { if (v.readyState) v.currentTime = clamp(v.currentTime + by, 0, v.duration || 1e9); };
		var rb = btn(rate + "×", "Playback speed", function () {
			rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length] || 1;
			v.playbackRate = rate;
			store(VRATE_KEY, String(rate));
			rb.textContent = rate + "×";
		});
		box.append(v, btn("↺15", "Back 15 seconds", function () { sk(-15); }), btn("30↻", "Ahead 30 seconds", function () { sk(30); }), rb,
			downloadButton(ep, false), h("span", "when", epStatus(ep)));
	},
	hosted: function (box, ep) {
		var at = epPlayed(ep) ? 0 : Math.floor(epPos(ep)), src = hostedSrc(ep, at);
		if (!src) return;
		var fr = playerFrame({ src: src, kind: "video" }), f = fr.querySelector("iframe");
		f.removeAttribute("loading");
		var cur = videoBox.now = { ep: ep, frame: f, savedAt: 0 };
		// Ask the player to report its time (YouTube, Vimeo; Twitch always does).
		f.addEventListener("load", function () { videoBox.listen(cur); });
		box.append(fr, h("span", "when", epStatus(ep)));
	},
	listen: function (cur) {
		var w = cur.frame.contentWindow, t = cur.ep.media_type;
		if (!w) return;
		if (t === "video/x-youtube") w.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), "https://www.youtube.com");
		if (t === "video/x-vimeo") ["timeupdate", "pause", "ended", "play"].forEach(function (name) {
			w.postMessage(JSON.stringify({ method: "addEventListener", value: name }), "https://player.vimeo.com");
		});
	},
	// What a player says, as { pos, len, ended, playing, now }, or null.
	heard: function (e, cur) {
		var d = e.data, t = cur.ep.media_type, num = function (x) { return typeof x === "number" && isFinite(x) && x >= 0 ? x : null; };
		if (typeof d === "string") { try { d = JSON.parse(d); } catch (err) { return null; } }
		if (!d || typeof d !== "object") return null;
		if (t === "video/x-youtube" && e.origin === "https://www.youtube.com" && d.info && typeof d.info === "object") {
			var st = d.info.playerState;
			return { pos: num(d.info.currentTime), len: num(d.info.duration), ended: st === 0, playing: st === 1, now: st === 0 || st === 2 };
		}
		if (t === "video/x-vimeo" && e.origin === "https://player.vimeo.com") {
			if (d.event === "ready") { videoBox.listen(cur); return null; }
			var x = d.data && typeof d.data === "object" ? d.data : {};
			return { pos: num(x.seconds), len: num(x.duration), ended: d.event === "ended", playing: d.event === "play", now: d.event !== "timeupdate" };
		}
		if (t === "video/x-twitch" && /^https:\/\/(player|clips)\.twitch\.tv$/.test(e.origin) && d.params && typeof d.params === "object") {
			var p = d.params;
			return { pos: num(p.currentTime), len: num(p.duration), ended: p.ended === true || p.playback === "Ended",
				playing: p.playback === "Playing", now: p.playback === "Paused" || p.playback === "Ended" };
		}
		return null;
	},
	// Leaving the article: save where it got to.
	close: function () {
		var cur = videoBox.now;
		videoBox.now = null;
		if (!cur) return;
		if (cur.el) {
			if (cur.el.currentTime > 0) keepPos(cur, cur.el.currentTime, isFinite(cur.el.duration) ? cur.el.duration : null, cur.el.ended, true);
			cur.el.pause();
		} else if (cur.pos > 0) keepPos(cur, cur.pos, cur.len, false, true);
	}
};
window.addEventListener("message", function (e) {
	var cur = videoBox.now;
	if (!cur || !cur.frame || e.source !== cur.frame.contentWindow) return;
	var got = videoBox.heard(e, cur);
	if (!got) return;
	if (got.playing) $("pAudio").pause();
	var len = got.len || cur.len || null, pos = got.ended && len ? len : got.pos;
	if (pos == null || (len && pos > len + 5)) return;
	cur.pos = pos;
	cur.len = len;
	if (pos > 0 || got.ended) keepPos(cur, pos, len, got.ended, got.now);
});
// The player's address, starting at a second.
function hostedSrc(ep, at) {
	var u = ep.media_url, m, host = encodeURIComponent(location.hostname);
	if ((m = /[?&]v=([\w-]{11})/.exec(u)))
		return "https://www.youtube.com/embed/" + m[1] + "?enablejsapi=1&origin=" + encodeURIComponent(location.origin) + (at ? "&start=" + at : "");
	if ((m = /^https:\/\/www\.twitch\.tv\/videos\/(\d+)$/.exec(u)))
		return "https://player.twitch.tv/?video=v" + m[1] + "&parent=" + host + "&autoplay=false" + (at ? "&time=" + Math.floor(at / 3600) + "h" + Math.floor(at / 60) % 60 + "m" + at % 60 + "s" : "");
	if ((m = /^https:\/\/clips\.twitch\.tv\/([\w-]+)$/.exec(u))) return "https://clips.twitch.tv/embed?clip=" + m[1] + "&parent=" + host + "&autoplay=false";
	if ((m = /^https:\/\/www\.twitch\.tv\/(\w+)$/.exec(u))) return "https://player.twitch.tv/?channel=" + m[1] + "&parent=" + host + "&autoplay=false";
	if ((m = /^https:\/\/vimeo\.com\/(\d+)(?:\/(\w+))?$/.exec(u)))
		return "https://player.vimeo.com/video/" + m[1] + (m[2] ? "?h=" + m[2] : "") + (at ? "#t=" + at + "s" : "");
	return null;
}

// Downloads
async function episodeSrc(ep, bar) {
	if (downloads[ep.id] && window.caches) {
		try {
			var res = await (await caches.open(EP_CACHE)).match(epKey(ep.id));
			if (res) return URL.createObjectURL(await res.blob());
		} catch (e) {}
		// The browser cleared it (low on space, or unused for a while).
		delete downloads[ep.id];
		saveDownloads();
		repaintEpisode(ep.id);
	}
	// The player bar's through /media once it goes through Web Audio, or will (voice boost).
	if (bar && (voice.level || voice.src)) {
		try { return await voiceMedia(ep.media_url); } catch (e) {}
	}
	// An https page can't play from http (the browser would upgrade it anyway).
	return ep.media_url.replace(/^http:/, "https:");
}
async function downloadEpisode(ep) {
	if (!window.caches || !window.ReadableStream) return toast("This browser can't keep downloads.");
	dlProgress[ep.id] = { got: 0, total: 0 };
	repaintEpisode(ep.id);
	try {
		await askToKeep();
		var res = await api("/api/media?url=" + encodeURIComponent(ep.media_url));
		if (!res.ok) {
			var d = await res.json().catch(function () { return {}; });
			throw new Error(d.error || "HTTP " + res.status);
		}
		var p = dlProgress[ep.id];
		p.total = Number(res.headers.get("Content-Length")) || 0;
		var counted = counting(res, p, function () { repaintEpisode(ep.id); });
		var type = res.headers.get("Content-Type") || ep.media_type;
		await (await caches.open(EP_CACHE)).put(epKey(ep.id), new Response(counted, { headers: { "Content-Type": type } }));
		var keep = epFields(ep);
		keep.size = p.got;
		keep.saved_at = Date.now();
		downloads[ep.id] = keep;
		saveDownloads();
	} catch (e) {
		if (e.message !== UNAUTH) toast(/quota/i.test(e.name + e.message) ? "Not enough space on this device for that episode." : "Couldn't download it: " + e.message);
	} finally {
		delete dlProgress[ep.id];
		repaintEpisode(ep.id);
	}
}
// Asks the browser not to clear downloads when it's low on space.
async function askToKeep() {
	if (!navigator.storage || !navigator.storage.persist) return;
	var kept = await navigator.storage.persist().catch(function () { return false; });
	if (!kept && navigator.standalone === false && !read("readerPersistTip")) {
		store("readerPersistTip", "1");
		toast("Tip: add Reader to your Home Screen, or Safari may clear downloads after a week unused.");
	}
}
// A download's body, counting into p.got as it goes (tick at most 4x a second).
function counting(res, p, tick) {
	var reader = res.body.getReader(), last = 0;
	return new ReadableStream({
		async pull(ctl) {
			var r = await reader.read();
			if (r.done) { ctl.close(); return; }
			p.got += r.value.byteLength;
			if (Date.now() - last > 250) { last = Date.now(); tick(); }
			ctl.enqueue(r.value);
		},
		cancel(why) { reader.cancel(why); }
	});
}
async function removeDownload(id) {
	delete downloads[id];
	saveDownloads();
	try { await (await caches.open(EP_CACHE)).delete(epKey(id)); } catch (e) {}
	repaintEpisode(id);
	if (state.epDownloadedOnly && state.route && MEDIA_TABS[state.route.name]) loadEpisodes(false);
}

// Voice boost (the Voice button on the player page and an episode's page):
// voices brought forward and quiet speech lifted, through the Web Audio
// API. A cut below 90 Hz, a lift around 3 kHz where speech is clearest, a
// compressor that evens out loud and soft, the level made up again, and a
// limiter so it can't clip. "Voice +" is a little, "Voice ++" more. Kept on
// this device, as the speed is. The player only goes through Web Audio once
// something plays with boost on; turned off, it's passed straight through.
// An audio context starts only from a tap, so it starts with the first tap
// on a player or a Play button (not anywhere in the app, since a running
// one can stop music playing in another app).
// Web Audio hears only files from this site, so once the player goes
// through it, a podcast streamed from its own site comes through /media
// instead (signed like /listen/), or it would play silent.
var VOICE_LEVELS = [null, { eq: 4, thr: -24, ratio: 3, gain: 1.25 }, { eq: 6, thr: -30, ratio: 4, gain: 1.6 }];
var voice = { level: Number(read("readerVoice")) || 0, ctx: null, chain: null, src: null, media: {} };
if (!VOICE_LEVELS[voice.level]) voice.level = 0;
function voiceCtx() {
	var AC = window.AudioContext || window.webkitAudioContext;
	if (!voice.ctx && AC) {
		try { voice.ctx = new AC(); } catch (e) { return null; }
		// iOS: play as media, past the silent switch, as the audio element would.
		try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {}
		var c = voice.ctx, n = voice.chain = {
			hp: c.createBiquadFilter(), eq: c.createBiquadFilter(), comp: c.createDynamicsCompressor(),
			gain: c.createGain(), lim: c.createDynamicsCompressor(),
		};
		n.hp.type = "highpass";
		n.hp.frequency.value = 90;
		n.eq.type = "peaking";
		n.eq.frequency.value = 3000;
		n.eq.Q.value = 0.9;
		n.comp.knee.value = 10;
		n.comp.attack.value = 0.005;
		n.comp.release.value = 0.25;
		n.lim.threshold.value = -2;
		n.lim.knee.value = 0;
		n.lim.ratio.value = 20;
		n.lim.attack.value = 0.001;
		n.lim.release.value = 0.1;
		n.hp.connect(n.eq);
		n.eq.connect(n.comp);
		n.comp.connect(n.gain);
		n.gain.connect(n.lim);
		n.lim.connect(c.destination);
	}
	if (voice.ctx && voice.ctx.state !== "running") voice.ctx.resume().catch(function () {});
	return voice.ctx;
}
// The player, through the chain at this level or straight out.
function voiceRoute() {
	if (!voice.src) return;
	var v = VOICE_LEVELS[voice.level], n = voice.chain;
	if (v) {
		n.eq.gain.value = v.eq;
		n.comp.threshold.value = v.thr;
		n.comp.ratio.value = v.ratio;
		n.gain.gain.value = v.gain;
	}
	voice.src.disconnect();
	voice.src.connect(v ? n.hp : voice.ctx.destination);
}
// Playing a file from another site (a podcast streamed from its own).
function voiceForeign(audio) {
	var src = audio.currentSrc || audio.src;
	try { return !!src && new URL(src, location.href).origin !== location.origin; } catch (e) { return true; }
}
// On play: the player goes through, if boost is on, the context is running
// (it isn't before a tap, and then it plays as it is) and the file is this site's.
function voiceWire(audio) {
	if (voice.ctx && voice.ctx.state !== "running") voice.ctx.resume().catch(function () {});
	if (!voice.level || voice.src || !voice.ctx || voice.ctx.state !== "running" || voiceForeign(audio)) return;
	try { voice.src = voice.ctx.createMediaElementSource(audio); } catch (e) { return; }
	voiceRoute();
}
// A podcast episode's /media address (fresh ones near the end of theirs).
async function voiceMedia(url) {
	var c = voice.media[url];
	if (c && c.expires - Date.now() > 10 * 60 * 1000) return c.url;
	c = voice.media[url] = await apiJSON("/api/media/listen?url=" + encodeURIComponent(url));
	return c.url;
}
// Boost turned on while a podcast streams from its own site: the same
// place, through /media, so the boost reaches it.
async function voiceSwap() {
	var audio = $("pAudio"), ep = player.ep;
	if (!ep || ep.book || !audio.src || !voiceForeign(audio)) return;
	var src = await voiceMedia(ep.media_url).catch(function () { return null; });
	if (!src || player.ep !== ep || !voiceForeign(audio)) return;
	var at = audio.currentTime, play = !audio.paused;
	player.url = src;
	audio.src = src;
	audio.playbackRate = player.rate;
	audio.addEventListener("loadedmetadata", function once() {
		audio.removeEventListener("loadedmetadata", once);
		if (at > 0) audio.currentTime = at;
	});
	audio.load();
	if (play) audio.play().catch(playFailed);
}
// The Voice buttons: off, a little, more, and round again.
function voiceNext() {
	var audio = $("pAudio");
	voice.level = (voice.level + 1) % VOICE_LEVELS.length;
	store("readerVoice", String(voice.level));
	paintVoice();
	var c = voice.level ? voiceCtx() : voice.ctx;
	if (!c) return;
	c.resume().then(function () {
		if (voice.level) voiceSwap().catch(function () {});
		if (!audio.paused) voiceWire(audio);
		voiceRoute();
	}, function () {});
}
function paintVoice() {
	document.querySelectorAll(".voicebtn").forEach(function (b) {
		b.textContent = ["Voice", "Voice +", "Voice ++"][voice.level];
		b.setAttribute("aria-label", "Voice boost: " + ["off", "a little", "more"][voice.level]);
		b.classList.toggle("on", voice.level > 0);
	});
}
(function () {
	$("pAudio").addEventListener("play", function () { voiceWire(this); });
	$("lpVoice").addEventListener("click", voiceNext);
	paintVoice();
	document.addEventListener("click", function (e) {
		if (voice.level && e.target.closest && e.target.closest("#listenView, #pbar, #aEpisode, [data-play]")) voiceCtx();
	}, true);
})();

// The player bar
var player = { ep: null, url: null, savedAt: 0, rate: Number(read("readerRate")) || 1 };
// The sleep timer, set on an audiobook's player page or a podcast episode's
// page: pause after some minutes of listening (the last 10 seconds fade out
// where the browser lets a page set the volume), or at the end of the
// chapter playing (of the episode, for a podcast). It counts only while
// something plays, and goes with the bar's ×.
// Up here with the player because the bar paints it, and the bar is
// restored ("Back where you left off") as the page starts.
var sleep = { left: null, end: null, last: 0, timer: null };
var RATES = [0.8, 1, 1.2, 1.5, 1.75, 2];
async function playEpisode(ep, start) {
	var audio = $("pAudio");
	if (voice.level) voiceCtx();
	if (ep.book) return playAudiobook(ep, start);
	if (!isAudio(ep)) { location.hash = "#/item/" + ep.id; return; }
	if (player.ep && player.ep.id === ep.id && audio.src) {
		if (start && audio.paused) await audio.play().catch(playFailed); else if (start) audio.pause();
		return;
	}
	if (player.ep) saveEpisodePos(true);
	player.ep = ep;
	player.ab = null;
	store("readerNowPlaying", JSON.stringify(ep));
	var src = await episodeSrc(ep, true);
	if (player.ep !== ep) return;
	if (player.url && player.url.indexOf("blob:") === 0) URL.revokeObjectURL(player.url);
	player.url = src;
	var at = epPlayed(ep) ? 0 : epPos(ep);
	audio.src = src;
	audio.playbackRate = player.rate;
	// Safari only seeks once it knows the length.
	audio.addEventListener("loadedmetadata", function once() {
		audio.removeEventListener("loadedmetadata", once);
		if (at > 0 && at < audio.duration - 1) audio.currentTime = at;
	});
	audio.load();
	if (start) await audio.play().catch(playFailed);
	setSession(ep);
	renderPlayer();
	repaintEpisode(ep.id);
}
function playFailed(e) {
	if (e && e.name === "AbortError") return;
	if (player.ep && player.ep.book) return toast("Couldn't play this audiobook. The home server may be offline, so try again later.");
	toast(navigator.onLine === false && !downloads[player.ep && player.ep.id] ? "You're offline, and this episode isn't downloaded." : "Couldn't play this episode.");
}
function renderPlayer() {
	var ep = player.ep, audio = $("pAudio");
	paintSleep();
	// The player page has the bar's controls, so the bar steps aside there.
	// It only shows with the things it plays: Podcasts, Videos (and an episode
	// opened from them or from the bar) and the Library, not the feed lists or articles.
	var bar = !!ep && barHere() && !(onListen() && ep.book === state.route.id);
	show($("pbar"), bar);
	document.body.classList.toggle("has-pbar", bar);
	renderListen();
	if (!ep) return;
	var dur = ep.book ? abTotal(ep) : audio.duration || epLen(ep), pos = ep.book ? abNow() : audio.currentTime || 0;
	$("pName").textContent = ep.title;
	$("pTime").textContent = (ep.feed_title ? ep.feed_title + " · " : "") + clock(pos) + (dur ? " / " + clock(dur) : "");
	if (!state.seeking) $("pSeek").value = dur ? Math.round(pos / dur * 1000) : 0;
	seekFill($("pSeek"));
	$("pPlay").innerHTML = audio.paused ? "&#9654;" : "&#10074;&#10074;";
	$("pPlay").setAttribute("aria-label", audio.paused ? "Play" : "Pause");
	$("pRate").textContent = player.rate + "×";
}
var BAR_ROUTES = { podcasts: 1, videos: 1, library: 1, record: 1, listen: 1 };
function barHere() {
	var r = state.route;
	return !!r && (!!BAR_ROUTES[r.name] || (r.name === "item" && (state.fromPodcasts || (!!player.ep && player.ep.id === r.id))));
}
// The played part of a slider (0 to 1000), for browsers that draw only the track.
function seekFill(el) { el.style.setProperty("--p", el.value / 10 + "%"); }
// What the lock screen and Control Center show. An audiobook's cover goes
// with it, so the phone can show it large; as a data: URL, since the phone
// fetches artwork itself, without the token, and a blob: URL isn't always
// shown. A podcast's is its feed's artwork, on the podcast's own site.
var sessionArt = {};
function setSession(ep) {
	if (!("mediaSession" in navigator)) return;
	var meta = { title: ep.title, artist: ep.feed_title || "", album: "Reader" };
	var art = ep.book ? sessionArt[ep.book] : ep.feed_image ? { src: ep.feed_image } : null;
	try {
		navigator.mediaSession.metadata = new MediaMetadata(art ? Object.assign(meta, { artwork: [art] }) : meta);
	} catch (e) {}
	if (ep.book && art === undefined) sessionCover(ep);
}
async function sessionCover(ep) {
	sessionArt[ep.book] = null;
	try {
		var res = await api("/api/books/" + ep.book + "/cover");
		if (!res.ok) return;
		var blob = await res.blob(), type = blob.type || "image/jpeg";
		var src = await new Promise(function (ok, no) {
			var fr = new FileReader();
			fr.onload = function () { ok(fr.result); };
			fr.onerror = no;
			fr.readAsDataURL(blob);
		});
		var img = new Image();
		img.src = src;
		await img.decode();
		var size = img.naturalWidth + "x" + img.naturalHeight;
		sessionArt[ep.book] = { src: src, sizes: size, type: type };
		if (player.ep === ep) setSession(ep);
	} catch (e) {}
}
function skip(by) {
	var audio = $("pAudio");
	if (!audio.src) return;
	if (player.ep && player.ep.book) return abSeek(abNow() + by, !audio.paused);
	audio.currentTime = clamp(audio.currentTime + by, 0, audio.duration || 1e9);
	renderPlayer();
}
// On this device at once; on the item every 15 seconds of listening, and on
// pause, end, or leaving the page.
function saveEpisodePos(now) {
	var audio = $("pAudio");
	if (player.ep && player.ep.book) return keepListening(now);
	if (!player.ep || !audio.src || !(audio.currentTime > 0)) return;
	keepPos(player, audio.ended ? audio.duration : audio.currentTime, isFinite(audio.duration) ? audio.duration : null, audio.ended, now);
}
// who: the player bar, or the video now showing ({ep, savedAt}).
function keepPos(who, pos, len, ended, now) {
	var ep = who.ep;
	len = len || ep.media_len || null;
	positions[ep.id] = pos;
	var ids = Object.keys(positions);
	if (ids.length > 300) delete positions[ids[0]];
	store("readerPositions", JSON.stringify(positions));
	[ep, findListed(ep.id), downloads[ep.id]].forEach(function (x) { if (x) { x.media_pos = pos; if (len) x.media_len = len; } });
	if (downloads[ep.id]) saveDownloads();
	if (who !== player) repaintEpisode(ep.id);
	if (!now && Date.now() - who.savedAt < 15000) return;
	who.savedAt = Date.now();
	var patch = { media_pos: pos };
	if (len) patch.media_len = len;
	if (ended) patch.read = 1;
	api("/api/items/" + ep.id, { method: "PATCH", json: patch, keepalive: true }).catch(function () {});
}
function findListed(id) { return state.episodes.filter(function (e) { return e.id === id; })[0] || null; }

(function () {
	var audio = $("pAudio");
	["play", "pause", "loadedmetadata", "durationchange"].forEach(function (t) {
		audio.addEventListener(t, function () { renderPlayer(); if (player.ep && !player.ep.book) repaintEpisode(player.ep.id); repaintRecord(); });
	});
	// An audiobook's next file starts where the bar says.
	audio.addEventListener("loadedmetadata", function () {
		var ab = player.ab;
		if (ab && ab.pending != null) { if (ab.pending > 0) audio.currentTime = ab.pending; ab.pending = null; }
	});
	audio.addEventListener("error", function () {
		if (player.ab && audio.error) playFailed();
	});
	audio.addEventListener("timeupdate", function () { renderPlayer(); saveEpisodePos(false); });
	audio.addEventListener("pause", function () { saveEpisodePos(true); });
	audio.addEventListener("ended", function () {
		var ab = player.ab;
		if (ab && player.ep && player.ep.book) {
			if (ab.cur + 1 < ab.files.length) abLoad(ab.cur + 1, 0, true);
			else keepListening(true, true);
			return;
		}
		saveEpisodePos(true);
		if (player.ep) repaintEpisode(player.ep.id);
		// A podcast has no chapters: its end-of-chapter timer is the episode's end.
		if (sleep.end != null) sleepNow();
	});
	audio.addEventListener("ratechange", renderPlayer);
	$("pPlay").addEventListener("click", function () {
		if (!player.ep) return;
		if (!audio.src) return playEpisode(player.ep, true).catch(fail);
		if (audio.paused) audio.play().catch(playFailed); else audio.pause();
	});
	$("pBack").addEventListener("click", function () { skip(-15); });
	$("pFwd").addEventListener("click", function () { skip(30); });
	$("pRate").addEventListener("click", function () {
		player.rate = RATES[(RATES.indexOf(player.rate) + 1) % RATES.length] || 1;
		audio.playbackRate = player.rate;
		store("readerRate", String(player.rate));
		renderPlayer();
	});
	$("pClose").addEventListener("click", function () {
		saveEpisodePos(true);
		audio.pause();
		var id = player.ep && !player.ep.book && player.ep.id;
		player.ep = null;
		player.ab = null;
		audio.removeAttribute("src");
		audio.load();
		store("readerNowPlaying", null);
		renderPlayer();
		if (id) repaintEpisode(id);
		repaintRecord();
	});
	$("pTitle").addEventListener("click", function () { if (player.ep) location.hash = player.ep.book ? "#/listen/" + player.ep.book : "#/item/" + player.ep.id; });
	$("pSeek").addEventListener("input", function () {
		state.seeking = true;
		seekFill(this);
		var dur = player.ep && player.ep.book ? abTotal(player.ep) : audio.duration || epLen(player.ep || {});
		if (dur) $("pTime").textContent = clock(this.value / 1000 * dur) + " / " + clock(dur);
	});
	$("pSeek").addEventListener("change", function () {
		state.seeking = false;
		if (player.ep && player.ep.book) abSeek(this.value / 1000 * abTotal(player.ep), !audio.paused);
		else if (audio.duration) audio.currentTime = this.value / 1000 * audio.duration;
	});
	$("epMore").addEventListener("click", function () { loadEpisodes(true).catch(fail); });
	$("epFilter").addEventListener("click", function () {
		state.epDownloadedOnly = !state.epDownloadedOnly;
		state.episodes = [];
		reloadPodcasts().catch(fail);
	});
	$("epAdd").addEventListener("click", function () { openEpAdd($("epAddBox").hidden); });
	$("epAddForm").addEventListener("submit", function (e) { epAddSubmit(e).catch(fail); });
	$("epAddUrl").addEventListener("input", paintEpAddGo);
	// Clears a show's unread count; the episodes stay unplayed.
	$("epAllRead").addEventListener("click", async function () {
		var f = epShow();
		if (!f) return;
		try {
			await apiJSON("/api/items/mark-read", { method: "POST", json: { feed: f.id } });
			f[state.epKind === "videos" ? "unread_videos" : "unread_episodes"] = 0;
			renderEpHead();
			await loadFeeds();
		} catch (e) { fail(e); }
	});
	if ("mediaSession" in navigator) {
		var on = function (name, fn) { try { navigator.mediaSession.setActionHandler(name, fn); } catch (e) {} };
		on("play", function () { audio.play().catch(playFailed); });
		on("pause", function () { audio.pause(); });
		on("seekbackward", function (d) { skip(-((d && d.seekOffset) || 15)); });
		on("seekforward", function (d) { skip((d && d.seekOffset) || 30); });
		on("seekto", function (d) {
			if (!d || d.seekTime == null) return;
			if (player.ep && player.ep.book) abSeek(d.seekTime, !audio.paused); else audio.currentTime = d.seekTime;
		});
	}
	window.addEventListener("pagehide", function () { saveEpisodePos(true); videoBox.close(); });
	// Back where you left off: the last episode, paused.
	var last = readJSON("readerNowPlaying");
	if (last && (last.book || (last.id && last.media_url))) { player.ep = last; renderPlayer(); }
})();

// ---------- library

// Online: the server's list (downloaded books' details are refreshed from
// it). Offline: the books downloaded on this device.
async function loadBooks() {
	var fromServer = false;
	try {
		var data = await apiJSON("/api/books");
		state.books = data.books;
		state.libOffline = false;
		fromServer = true;
		refreshBookDownloads(data.books);
	} catch (e) {
		if (e.message === UNAUTH || !isOffline(e)) throw e;
		state.books = downloadedBooks();
		state.libOffline = true;
	}
	applyPending(state.books, fromServer);
	renderBooks();
	if (fromServer) syncBooks();
}
function parsePos(s) {
	try { var p = JSON.parse(s); return p && typeof p === "object" ? p : null; } catch (e) { return null; }
}
async function showLibrary(r) {
	// Untagged (0) can't be combined with a tag.
	state.libTags = r.tags.indexOf(0) >= 0 ? [0] : r.tags.filter(function (x, i, a) { return a.indexOf(x) === i; });
	state.libTag = state.libTags.length ? state.libTags[0] : null;
	if ((r.series || null) !== (state.libSeries || null)) window.scrollTo(0, 0);
	state.libSeries = r.series || null;
	fillUploadTag(state.libTag);
	showView("library");
	renderTabs("library");
	document.title = "Library — Reader";
	var back = state.prev && state.prev.name === "record" ? state.libScroll : null;
	if (state.books) { renderBooks(); if (back != null) window.scrollTo(0, back); }
	await Promise.all([loadBooks(), loadBookTags()]);
	if (back != null && state.route.name === "library") window.scrollTo(0, back);
}

// ---------- formats and the Record
// A book here as an ebook and as an audiobook (from Audiobookshelf) is one
// entry in the Library, as in the family library: the audiobook joins the
// ebook with the same title (before any subtitle) and an author sharing a
// word, as b.audio. The ebook's own details (as edited here) are the
// entry's. An audiobook with no ebook is an entry of its own. Each entry
// opens its Record (#/record/<id>): both formats, with Read and Listen, then
// the jacket copy and appeal terms. Audiobooks play in the player bar.
function isAudiobook(b) { return b.type === "audiobook"; }
// From Audiobookshelf (an audiobook, or an ebook kept there): removed there, not here.
function fromHome(b) { return isAudiobook(b) || !!b.home; }
function audioOf(b) { return isAudiobook(b) ? b : b.audio || null; }
function titleKey(b) { return fold(b.title).split(/[:(\[]/)[0].replace(/[^a-z0-9]+/g, " ").trim(); }
function authorWords(b) { return fold(b.author).replace(/[^a-z]+/g, " ").trim().split(" ").filter(function (w) { return w.length > 1; }); }
function libEntries(books) {
	var ebooks = {};
	books.forEach(function (b) {
		delete b.audio;
		var k = titleKey(b);
		if (!isAudiobook(b) && k) (ebooks[k] = ebooks[k] || []).push(b);
	});
	var list = books.filter(function (b) {
		if (!isAudiobook(b)) return true;
		var words = authorWords(b), e = (ebooks[titleKey(b)] || []).filter(function (x) {
			var theirs = authorWords(x);
			return !x.audio && (!words.length && !theirs.length || words.some(function (w) { return theirs.indexOf(w) >= 0; }));
		})[0];
		if (!e) return true;
		e.audio = b;
		return false;
	});
	// Recent: a pair goes by whichever format was opened last.
	var when = function (b) { return Math.max(b.last_opened_at || b.created_at || 0, b.audio ? b.audio.last_opened_at || b.audio.created_at || 0 : 0); };
	return list.sort(function (a, b) { return when(b) - when(a) || b.id - a.id; });
}
// The entry a book is in (an audiobook joined to an ebook is in the ebook's).
function libEntry(id) {
	return libEntries(state.books || []).filter(function (b) { return b.id === id || (b.audio && b.audio.id === id); })[0] || null;
}
var LIB_FORMATS = {
	read: function (b) { return !isAudiobook(b); },
	listen: function (b) { return !!audioOf(b); }
};
var READ_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 4.5h6a4 4 0 0 1 4 4V20a3 3 0 0 0-3-3H2zM22 4.5h-6a4 4 0 0 0-4 4V20a3 3 0 0 1 3-3h7z"/></svg>';
var LISTEN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>';
function fmtIcons(b) {
	var f = h("span", "fmt");
	f.innerHTML = (isAudiobook(b) ? "" : READ_ICON) + LISTEN_ICON;
	f.title = isAudiobook(b) ? "Audiobook" : "Ebook and audiobook";
	return f;
}
// 33,120 seconds -> "9 h 12 min"
function hours(sec) {
	var m = Math.round((sec || 0) / 60);
	return m < 60 ? Math.max(1, m) + " min" : Math.floor(m / 60) + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
}

var KIND = { epub: "EPUB", pdf: "PDF", cbz: "Comic", txt: "Text", audiobook: "Audiobook" };
var recCache = {};
async function showRecord(id) {
	showView("record");
	window.scrollTo(0, 0);
	if (!state.books) await loadBooks();
	var b = libEntry(id);
	if (!b) {
		toast(state.libOffline ? "You're offline, and that book isn't downloaded on this device." : "That book isn't in the library any more.");
		location.replace("#/library");
		return;
	}
	if (b.id !== id) { location.replace("#/record/" + b.id); return; }
	state.record = b;
	document.title = b.title + " — Reader";
	renderRecord(b);
	loadRecordDetails(b);
	if (audioOf(b) && !state.libOffline) loadChapters(b);
}
function onRecord(b) { return state.route && state.route.name === "record" && state.record === b; }
function renderRecord(b) {
	var au = audioOf(b), e = isAudiobook(b) ? null : b;
	$("recCover").textContent = "";
	$("recCover").append(coverBox(b));
	$("recTitle").textContent = b.title;
	$("recBy").textContent = b.author ? "by " + b.author : "";
	var sr = $("recSeries");
	sr.textContent = "";
	if (b.series) {
		var link = h("a", null, b.series);
		link.href = "#/library?series=" + encodeURIComponent(b.series);
		if (b.volume) sr.append("Book " + b.volume + " of ");
		sr.append(link);
	}
	recordFacts(b, recCache[b.id]);
	var acts = $("recActs"), off = !!state.libOffline;
	acts.textContent = "";
	if (e) {
		var pos = parsePos(e.position), pct = pos && pos.f ? Math.round(pos.f * 100) : 0;
		var read = h("a", "btn primary", e.finished_at ? "Read again" : pct ? "Continue reading · " + pct + "%" : "Read");
		read.href = "#/book/" + e.id;
		acts.append(read);
	}
	if (au) {
		var listen = button(listenLabel(au), "btn" + (e ? "" : " primary"), function () { listenTo(au); });
		listen.id = "recListen";
		if (off) listen.disabled = true;
		acts.append(listen);
	}
	var tools = h("div", "rtools");
	if (!off) tools.append(button("Edit details", "btn small", function () { openDetails(b); }));
	if (e && window.caches) tools.append(bookDlButton(e));
	if (au && !off) tools.append(button("Player", "btn small", function () { location.hash = "#/listen/" + au.id; }));
	if (au && !off) tools.append(button("Download audiobook", "btn small", function () {
		listenInfo(au.id).then(function (d) { location.href = d.download; }, fail);
	}));
	if (tools.children.length) acts.append(tools);
}
function recordFacts(b, rec) {
	var dl = $("recFacts"), add = function (k, v) { if (v) dl.append(h("dt", null, k), h("dd", null, v)); };
	var au = audioOf(b), e = isAudiobook(b) ? null : b;
	dl.textContent = "";
	if (e) add("Format", KIND[e.type] + " · " + bytes(e.size));
	if (au) add(e ? "Audiobook" : "Format", (e ? "" : "Audiobook · ") + hours(au.duration) + (au.size ? " · " + bytes(au.size) : ""));
	if (au) add("Narrator", au.narrator);
	if (e && rec && rec.pages) add("Length", (rec.from.pages === "estimate" ? "About " : "") + rec.pages.toLocaleString() + (rec.pages === 1 ? " page" : " pages"));
	var c = rec && rec.catalog || {};
	add("Published", c.year);
	add("Publisher", c.publisher);
	add("Language", c.language);
	add("Tags", bookTagsOf(b).map(function (id) { return bookTagById(id).name; }).join(", "));
	add("Call number", c.classification);
	add("Subjects", (c.subjects || []).join("; "));
	add("ISBN", c.isbn);
	if (e && e.finished_at) add(au ? "Finished reading" : "Finished", longDate(e.finished_at));
	if (au && au.finished_at) add(e ? "Finished listening" : "Finished", longDate(au.finished_at));
}
// A book with an audiobook too, as in the family library: the audiobook's
// description wins over any but one edited by hand, and its publisher, year
// and so on (the recording's) only fill the ebook's gaps.
function withAudio(rec, audio) {
	if (!audio) return rec;
	var out = Object.assign({}, rec, { from: Object.assign({}, rec.from), catalog: Object.assign({}, rec.catalog) });
	if (audio.blurb && audio.from.blurb === "file" && rec.from.blurb !== "edited") {
		out.blurb = audio.blurb;
		out.from.blurb = "abs";
	}
	Object.keys(audio.catalog || {}).forEach(function (k) {
		if (k !== "isbn" && !out.catalog[k]) out.catalog[k] = audio.catalog[k];
	});
	if (!rec.appeal && audio.appeal) out.appeal = audio.appeal;
	return out;
}
async function loadRecordDetails(b) {
	var au = audioOf(b), e = isAudiobook(b) ? null : b;
	if (recCache[b.id]) recordDetails(recCache[b.id]);
	else {
		$("recBlurbSec").hidden = !!state.libOffline;
		$("recBlurb").innerHTML = '<p class="hint">Looking this book up…</p>';
		$("recBlurbNote").hidden = $("recAppealSec").hidden = true;
	}
	if (state.libOffline) return;
	var get = function (x) { return apiJSON("/api/books/" + x.id + "/record?fill=1").then(function (d) { return d.record; }); };
	try {
		var r = await Promise.all([get(e || au), e && au ? get(au).catch(function () { return null; }) : null]);
		var rec = recCache[b.id] = withAudio(r[0], r[1]);
		if (onRecord(b)) { recordFacts(b, rec); recordDetails(rec); }
	} catch (err) {
		if (err.message === UNAUTH) return;
		if (onRecord(b) && !recCache[b.id]) $("recBlurb").innerHTML = '<p class="hint">Couldn\'t look this book up just now.</p>';
	}
}
function recordDetails(rec) {
	var box = $("recBlurb"), note = $("recBlurbNote"), who = function (m) { return /^claude/.test(m || "") ? "Claude" : "an AI model"; };
	box.textContent = "";
	(rec.blurb || "").split(/\n\s*\n/).forEach(function (p) { if (p.trim()) box.append(h("p", null, p.trim())); });
	var said = { openlibrary: "From Open Library.", google: "From Google Books.", abs: "From the audiobook's details.",
		ai: "This one had no jacket copy, so " + who(rec.from.blurb_model) + " wrote this summary." }[rec.from.blurb];
	note.textContent = said || "";
	note.hidden = !said || !rec.blurb;
	$("recBlurbSec").hidden = !rec.blurb;
	var dl = $("recAppeal"), any = false;
	dl.textContent = "";
	Object.keys(APPEAL_LABELS).forEach(function (k) {
		var terms = rec.appeal && rec.appeal[k];
		if (!terms || !terms.length) return;
		var dd = h("dd");
		terms.forEach(function (t) { dd.append(h("span", "term", t)); });
		dl.append(h("dt", null, APPEAL_LABELS[k]), dd);
		any = true;
	});
	$("recAppealSec").hidden = !any;
}
// The chapters, to start listening from any of them.
async function loadChapters(b) {
	var au = audioOf(b), ol = $("recChapters");
	$("recChapSec").hidden = true;
	ol.textContent = "";
	var d;
	try { d = await listenInfo(au.id); } catch (e) { return; }
	if (!onRecord(b) || (d.chapters || []).length < 2) return;
	d.chapters.forEach(function (c, i) {
		var li = h("li"), btn = h("button");
		btn.type = "button";
		btn.dataset.start = c.start;
		btn.append(h("span", null, c.title || "Chapter " + (i + 1)), h("span", "chtime", clock(c.start)));
		btn.addEventListener("click", function () { listenTo(au, c.start); });
		li.append(btn);
		ol.append(li);
	});
	$("recChapSec").hidden = false;
	repaintRecord();
}
// The Record's Listen button and the chapter playing, as the player goes.
function repaintRecord() {
	var b = state.record;
	if (!b || !onRecord(b) || !audioOf(b)) return;
	var au = audioOf(b), btn = $("recListen");
	if (btn) btn.textContent = listenLabel(au);
	var t = audioPos(au), here = null;
	$("recChapters").querySelectorAll("button").forEach(function (x) { if (Number(x.dataset.start) <= t + 0.5) here = x; });
	$("recChapters").querySelectorAll("button").forEach(function (x) {
		if (x === here && playingBook(au)) x.setAttribute("aria-current", "true"); else x.removeAttribute("aria-current");
	});
}

// ---------- audiobooks in the player bar
// player.ep for an audiobook is {book: id, title, feed_title: its author,
// duration, t: the place}; player.ab holds its parts once they're fetched:
// the signed addresses of its files (good for some hours), and where each
// starts in the whole book. The bar's slider, time and skips run across the
// whole book; a book in several files plays them in turn. The place is saved
// on the book (position {t, f, at}) like a reading place, so it syncs.
var listenCache = {};
async function listenInfo(id) {
	var c = listenCache[id];
	if (c && c.expires - Date.now() > 10 * 60 * 1000) return c;
	return listenCache[id] = await apiJSON("/api/books/" + id + "/listen");
}
function playingBook(au) { return !!(player.ep && player.ep.book === au.id); }
function audioPos(au) {
	if (playingBook(au)) return abNow();
	var p = parsePos(au.position);
	return (p && p.t) || 0;
}
function listenLabel(au) {
	if (playingBook(au) && !$("pAudio").paused) return "Pause";
	var t = audioPos(au);
	if ((au.duration && t >= au.duration - 1) || (au.finished_at && t <= 5)) return "Listen again";
	return t > 5 ? "Resume listening · " + hours(Math.max(0, (au.duration || 0) - t)) + " left" : "Listen";
}
function listenTo(au, at) {
	var audio = $("pAudio");
	if (voice.level) voiceCtx();
	if (at == null && playingBook(au) && player.ab && audio.src && !audio.ended) {
		if (audio.paused) audio.play().catch(playFailed); else audio.pause();
		return;
	}
	var t = at != null ? at : listenLabel(au) === "Listen again" ? 0 : audioPos(au);
	playAudiobook({ book: au.id, title: au.title, feed_title: au.author || "", duration: au.duration, t: t }, true, t).catch(fail);
}
function abNow() {
	var ab = player.ab, audio = $("pAudio");
	if (ab && ab.cur >= 0 && ab.pending == null) return ab.starts[ab.cur] + (audio.currentTime || 0);
	if (ab && ab.cur >= 0) return ab.starts[ab.cur] + ab.pending;
	return (player.ep && player.ep.t) || 0;
}
function abTotal(ep) { return player.ab && player.ab.ep === ep ? player.ab.total : ep.duration || 0; }
async function playAudiobook(ep, start, at) {
	var audio = $("pAudio");
	if (player.ep && player.ep.book === ep.book && player.ab && audio.src) {
		if (at != null) return abSeek(at, start);
		if (start && audio.paused) await audio.play().catch(playFailed); else if (start) audio.pause();
		return;
	}
	if (player.ep) saveEpisodePos(true);
	audio.pause();
	player.ep = ep;
	player.ab = null;
	store("readerNowPlaying", JSON.stringify(ep));
	renderPlayer();
	var d = await listenInfo(ep.book);
	if (player.ep !== ep) return;
	var starts = [], total = 0;
	d.files.forEach(function (f) { starts.push(total); total += f.duration || 0; });
	player.ab = { ep: ep, id: ep.book, files: d.files, starts: starts, total: total || ep.duration || 0, cur: -1, pending: null };
	// Listening counts as opening it: it moves up in Recent.
	var b = (state.books || []).filter(function (x) { return x.id === ep.book; })[0];
	if (b) b.last_opened_at = Date.now();
	queueBook(ep.book, { opened: 1 });
	sendPending(ep.book).catch(function () {});
	abSeek(at != null ? at : ep.t || 0, start);
	setSession(ep);
	renderPlayer();
}
// A place in the whole book -> the file it's in, and the time in that file.
function abSeek(t, play) {
	var ab = player.ab, audio = $("pAudio");
	if (!ab) return;
	t = clamp(t, 0, Math.max(0, ab.total - 1));
	var n = 0;
	while (n + 1 < ab.files.length && ab.starts[n + 1] <= t) n++;
	if (n !== ab.cur) abLoad(n, t - ab.starts[n], play);
	else if (ab.pending != null) {
		// Still loading: it starts there instead.
		ab.pending = t - ab.starts[n];
		if (play) audio.play().catch(playFailed);
	} else {
		audio.currentTime = t - ab.starts[n];
		if (play) audio.play().catch(playFailed);
	}
	player.ep.t = t;
	if (sleep.end != null) sleep.end = sleepChapterEnd(t);
	renderPlayer();
}
async function abLoad(n, at, play) {
	var ab = player.ab, audio = $("pAudio");
	// The addresses last some hours; near the end, fresh ones.
	var c = listenCache[ab.id];
	if (!c || c.expires - Date.now() < 10 * 60 * 1000) {
		try {
			var d = await listenInfo(ab.id);
			if (player.ab !== ab) return;
			ab.files.forEach(function (f, i) { if (d.files[i]) f.url = d.files[i].url; });
		} catch (e) {}
	}
	ab.cur = n;
	ab.pending = at;
	audio.src = ab.files[n].url;
	audio.playbackRate = player.rate;
	audio.load();
	if (play) await audio.play().catch(playFailed);
}
// Saved like a reading place: here at once, on the book every 15 seconds and
// on pause, the end, or leaving the page.
function keepListening(now, ended) {
	var ep = player.ep, ab = player.ab;
	if (!ep || !ab || ab.cur < 0) return;
	var t = ended ? ab.total : abNow();
	if (!(t > 0)) return;
	ep.t = t;
	store("readerNowPlaying", JSON.stringify(ep));
	repaintRecord();
	if (!now && Date.now() - player.savedAt < 15000) return;
	player.savedAt = Date.now();
	var b = (state.books || []).filter(function (x) { return x.id === ep.book; })[0] || { id: ep.book };
	setPosition(b, JSON.stringify({ t: Math.floor(t), f: ab.total ? Math.min(1, t / ab.total) : 0, at: Date.now() }), true);
	if (ended) setFinished(b, true).then(repaintRecord, function () {});
}

// ---------- the player page
// #/listen/<id>, opened from the player bar's title (or a Record's Player
// button): the audiobook's square cover, the chapter playing with a slider
// across just that chapter, the controls, and every chapter to jump to. It
// drives the same audio as the bar, which steps aside while it shows. Opened
// for a book that isn't in the bar, it shows that book's saved place, and
// its controls start it.
function onListen() { return !!(state.route && state.route.name === "listen" && state.listen); }
async function showListen(id) {
	showView("listen");
	window.scrollTo(0, 0);
	state.listen = null;
	if (!state.books) await loadBooks();
	var au = (state.books || []).filter(function (b) { return b.id === id && isAudiobook(b); })[0];
	if (!au) {
		toast("That audiobook isn't in the library any more.");
		location.replace("#/library");
		return;
	}
	var lp = state.listen = { au: au, chapters: [], cur: -1 };
	document.title = au.title + " — Reader";
	$("lpCover").textContent = "";
	$("lpCover").append(coverBox(au));
	$("lpTitle").textContent = au.title;
	$("lpBy").textContent = au.author ? "by " + au.author : "";
	$("lpRecord").href = "#/record/" + (libEntry(au.id) || au).id;
	$("lpChapters").textContent = $("lpChapPick").textContent = "";
	$("lpChapSec").hidden = $("lpChapBtn").hidden = true;
	// Nothing in the bar, or this book back from last time: ready to play from its place.
	if (!player.ep || (playingBook(au) && !player.ab)) {
		var t = listenLabel(au) === "Listen again" ? 0 : audioPos(au);
		playAudiobook({ book: au.id, title: au.title, feed_title: au.author || "", duration: au.duration, t: t }, false, t).catch(fail);
	}
	renderPlayer();
	var d;
	try { d = await listenInfo(au.id); } catch (e) { return; }
	if (state.listen !== lp) return;
	lp.chapters = d.chapters || [];
	if (lp.chapters.length > 1) {
		// The same list twice: under the controls, and in the picker.
		[$("lpChapters"), $("lpChapPick")].forEach(function (ol) {
			lp.chapters.forEach(function (c, i) {
				var li = h("li"), btn = h("button");
				btn.type = "button";
				btn.append(h("span", null, c.title || "Chapter " + (i + 1)), h("span", "chtime", clock(c.start)));
				btn.addEventListener("click", function () {
					if ($("lpChapDlg").open) $("lpChapDlg").close();
					listenGo(c.start, true);
				});
				li.append(btn);
				ol.append(li);
			});
		});
		$("lpChapSec").hidden = $("lpChapBtn").hidden = false;
	}
	renderListen();
}
// Keep a chapter list's current one in view inside the list, not the page.
function chapterInView(ol) {
	var on = ol.querySelector("[aria-current]");
	if (on) ol.scrollTop = on.parentNode.offsetTop - ol.offsetTop - ol.clientHeight / 3;
}
// Here: the page's book is the one in the bar, loaded.
function listenHere() { var lp = state.listen; return !!(lp && playingBook(lp.au) && player.ab); }
function listenGo(t, play) {
	var lp = state.listen, audio = $("pAudio");
	if (!lp) return;
	if (listenHere()) abSeek(t, play != null ? play : !audio.paused);
	else listenTo(lp.au, clamp(t, 0, Math.max(0, (lp.au.duration || 0) - 1)));
}
// The chapter at t: {i, start, end} (the whole book when it has no chapters).
function listenChapter(t, total) {
	var cs = state.listen.chapters, i = -1;
	cs.forEach(function (c, n) { if (c.start <= t + 0.5) i = n; });
	if (i < 0) return { i: -1, start: 0, end: total };
	return { i: i, start: cs[i].start, end: cs[i + 1] ? cs[i + 1].start : total };
}
function renderListen() {
	if (!onListen()) return;
	var lp = state.listen, au = lp.au, audio = $("pAudio"), here = listenHere();
	var t = audioPos(au), total = here ? player.ab.total : au.duration || 0, playing = here && !audio.paused;
	var ch = listenChapter(t, total), len = Math.max(0, ch.end - ch.start), n = lp.chapters.length;
	var c = lp.chapters[ch.i];
	$("lpChap").textContent = n > 1 && c ? (c.title || "Chapter " + (ch.i + 1)) : "";
	$("lpChap").hidden = !(n > 1 && c);
	$("lpChap").setAttribute("aria-label", n > 1 && c ? "Chapter: " + $("lpChap").textContent + ". Choose a chapter" : "");
	if (!state.lpSeeking) {
		$("lpSeek").value = len ? Math.round((t - ch.start) / len * 1000) : 0;
		seekFill($("lpSeek"));
		$("lpPos").textContent = clock(Math.max(0, t - ch.start));
		$("lpLeft").textContent = "−" + clock(Math.max(0, ch.end - t));
	}
	$("lpSeek").setAttribute("aria-label", n > 1 ? "Position in chapter" : "Position in book");
	$("lpPlay").innerHTML = playing ? "&#10074;&#10074;" : "&#9654;";
	$("lpPlay").setAttribute("aria-label", playing ? "Pause" : "Play");
	$("lpNext").disabled = !(n > 1 && ch.i + 1 < n);
	$("lpRate").textContent = player.rate + "×";
	paintSleep();
	$("lpBook").textContent = (n > 1 && ch.i >= 0 ? "Chapter " + (ch.i + 1) + " of " + n + " · " : "") + hours(Math.max(0, total - t)) + " left";
	if (ch.i !== lp.cur) {
		lp.cur = ch.i;
		[$("lpChapters"), $("lpChapPick")].forEach(function (ol) {
			ol.querySelectorAll("button").forEach(function (x, k) { if (k === ch.i) x.setAttribute("aria-current", "true"); else x.removeAttribute("aria-current"); });
			chapterInView(ol);
		});
	}
}
// Previous: back to this chapter's start, or the one before when it's only
// just begun. Next: the next chapter's start.
function chapterStep(by) {
	var lp = state.listen;
	if (!lp) return;
	var t = audioPos(lp.au), ch = listenChapter(t, Infinity), cs = lp.chapters;
	if (by < 0) listenGo(t - ch.start > 3 || ch.i <= 0 ? ch.start : cs[ch.i - 1].start);
	else if (cs[ch.i + 1]) listenGo(cs[ch.i + 1].start);
}
(function () {
	var audio = $("pAudio");
	$("lpPlay").addEventListener("click", function () {
		var lp = state.listen;
		if (!lp) return;
		if (!playingBook(lp.au)) return listenTo(lp.au);
		if (!audio.src) return playEpisode(player.ep, true).catch(fail);
		if (audio.paused) audio.play().catch(playFailed); else audio.pause();
	});
	$("lpBack").addEventListener("click", function () { if (state.listen) listenGo(audioPos(state.listen.au) - 15); });
	$("lpFwd").addEventListener("click", function () { if (state.listen) listenGo(audioPos(state.listen.au) + 30); });
	$("lpPrev").addEventListener("click", function () { chapterStep(-1); });
	$("lpNext").addEventListener("click", function () { chapterStep(1); });
	$("lpRate").addEventListener("click", function () { $("pRate").click(); });
	// The chapter's name and the Chapters button open the picker.
	var dlg = $("lpChapDlg"), pick = function () {
		if (!state.listen || state.listen.chapters.length < 2) return;
		dlg.showModal();
		chapterInView($("lpChapPick"));
	};
	$("lpChap").addEventListener("click", pick);
	$("lpChapBtn").addEventListener("click", pick);
	$("lpChapClose").addEventListener("click", function () { dlg.close(); });
	// A tap on the dimmed page around it closes it.
	dlg.addEventListener("click", function (e) {
		var r = dlg.getBoundingClientRect();
		if (e.target === dlg && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) dlg.close();
	});
	var at = function (v) {
		var lp = state.listen, here = listenHere();
		var ch = listenChapter(audioPos(lp.au), here ? player.ab.total : lp.au.duration || 0);
		return { ch: ch, t: ch.start + v / 1000 * (ch.end - ch.start) };
	};
	$("lpSeek").addEventListener("input", function () {
		if (!state.listen) return;
		state.lpSeeking = true;
		seekFill(this);
		var x = at(this.value);
		$("lpPos").textContent = clock(x.t - x.ch.start);
		$("lpLeft").textContent = "−" + clock(Math.max(0, x.ch.end - x.t));
	});
	$("lpSeek").addEventListener("change", function () {
		state.lpSeeking = false;
		if (state.listen) listenGo(at(this.value).t);
	});
})();

// Where the chapter at t ends in the whole book (its end, with no chapters).
function sleepChapterEnd(t) {
	var ab = player.ab, cs = (player.ep && listenCache[player.ep.book] || {}).chapters || [];
	var next = cs.filter(function (c) { return c.start > t + 0.5; })[0];
	return next ? next.start : ab ? ab.total : (player.ep && player.ep.duration) || 0;
}
function setSleep(v) {
	var audio = $("pAudio");
	clearInterval(sleep.timer);
	sleep.left = sleep.end = sleep.timer = null;
	audio.volume = 1;
	if (v === "chapter" && player.ep) sleep.end = player.ep.book ? sleepChapterEnd(abNow()) : player.ep.duration || 0;
	else if (v !== "off" && v != null) {
		sleep.left = Number(v) * 60;
		sleep.last = Date.now();
		sleep.timer = setInterval(sleepTick, 1000);
	}
	paintSleep();
	renderListen();
}
// Every Sleep button showing (the player page's, an episode's) says what's set.
// An episode's shows only while that episode is the one in the player.
function paintSleep() {
	var end = player.ep && !player.ep.book ? "end of episode" : "end of chapter";
	document.querySelectorAll(".sleepbtn").forEach(function (b) {
		if (b.dataset.ep) {
			var here = !!player.ep && String(player.ep.id) === b.dataset.ep;
			show(b, here);
			if (!here) { show($(b.getAttribute("aria-controls")), false); b.setAttribute("aria-expanded", "false"); }
		}
		b.textContent = sleep.left != null ? "Sleep · " + clock(Math.ceil(sleep.left)) : sleep.end != null ? "Sleep · " + end : "Sleep";
		b.classList.toggle("on", sleep.left != null || sleep.end != null);
	});
}
// The choices under a Sleep button, as on the player page.
function sleepOptions(endLabel) {
	var box = h("div", "lpsleep");
	box.setAttribute("role", "group");
	box.setAttribute("aria-label", "Sleep timer");
	box.hidden = true;
	[["15", "15 min"], ["30", "30 min"], ["45", "45 min"], ["60", "1 h"], ["chapter", endLabel], ["off", "Off"]].forEach(function (o) {
		var b = h("button", "btn small", o[1]);
		b.type = "button";
		b.dataset.sleep = o[0];
		box.append(b);
	});
	return box;
}
// A Sleep button opens its choices; picking one sets it and closes them.
function sleepPicker(btn, opts) {
	btn.setAttribute("aria-expanded", "false");
	btn.addEventListener("click", function () {
		var open = opts.hidden;
		show(opts, open);
		btn.setAttribute("aria-expanded", String(open));
	});
	opts.addEventListener("click", function (e) {
		var b = e.target.closest("button");
		if (!b) return;
		setSleep(b.dataset.sleep);
		show(opts, false);
		btn.setAttribute("aria-expanded", "false");
	});
}
function sleepTick() {
	var audio = $("pAudio"), now = Date.now();
	if (!audio.paused) sleep.left -= (now - sleep.last) / 1000;
	sleep.last = now;
	if (sleep.left <= 0) return sleepNow();
	audio.volume = clamp(sleep.left / 10, 0, 1);
	paintSleep();
	renderListen();
}
function sleepNow() {
	$("pAudio").pause();
	setSleep("off");
	toast("Sleep timer: paused.");
}
(function () {
	var audio = $("pAudio");
	audio.addEventListener("timeupdate", function () {
		if (sleep.end != null && !audio.paused && player.ab && abNow() >= sleep.end - 0.3) sleepNow();
	});
	$("pClose").addEventListener("click", function () { setSleep("off"); });
	sleepPicker($("lpSleep"), $("lpSleepOpts"));
})();

// ---------- book tags
// Books have their own tags, apart from the feed tags, with the same colors
// and chips. Picking one above the Library shows just the books carrying it
// ("Untagged": books with none). They replaced book folders in 0005. Edit
// mode puts every tag as a switch under each book. The names are kept in
// localStorage so downloaded books still show theirs offline.

async function loadBookTags() {
	try {
		state.bookTags = (await apiJSON("/api/booktags")).tags;
		store("readerBookTags", JSON.stringify(state.bookTags));
	} catch (e) {
		if (e.message === UNAUTH || !isOffline(e)) throw e;
	}
	renderBooks();
}
function bookTagById(id) { return state.bookTags.filter(function (t) { return t.id === Number(id); })[0] || null; }
function bookTagsOf(b) { return (b.tags || []).filter(bookTagById); }
function hasBookTag(b, id) { return id === 0 ? !bookTagsOf(b).length : (b.tags || []).indexOf(id) >= 0; }
// The Upload picker: a tag to put on new books, starting on the one being viewed.
function fillUploadTag(value) {
	var sel = $("uploadTag");
	if (value === undefined) value = sel.value && sel.value !== "new" ? Number(sel.value) : state.libTag;
	sel.textContent = "";
	sel.add(new Option("No tag", ""));
	state.bookTags.forEach(function (t) { sel.add(new Option(t.name, String(t.id))); });
	sel.add(new Option("New tag…", "new"));
	sel.value = value && bookTagById(value) ? String(value) : "";
}
// Picking tags narrows, like a filter on a shop: the books are the ones
// with every tag picked, and only the tags those books also carry stay in
// the bar (with how many of them have each), so a second pick narrows
// further. Tap a picked tag to drop it. Tags no book has are hidden except
// in Edit, where they can be renamed or deleted.
function libHash(ids) { return ids.length ? "#/library?tag=" + ids.join(",") : "#/library"; }
function libFiltered(books) {
	var sel = state.libTags;
	return sel.length ? books.filter(function (b) { return sel.every(function (id) { return hasBookTag(b, id); }); }) : books;
}
function renderBookTags() {
	fillUploadTag();
	var box = $("bookTags"), edit = state.editBooks, sel = state.libTags, books = libEntries(state.books || []);
	var pool = libFiltered(books);
	box.textContent = "";
	var list = state.bookTags.map(function (t) { return { id: t.id, name: t.name, cls: tagColor(t.id) }; });
	if (!sel.length && list.length && books.some(function (b) { return !bookTagsOf(b).length; })) list.push({ id: 0, name: "Untagged", cls: "untagged" });
	list = list.map(function (x) { return Object.assign(x, { on: sel.indexOf(x.id) >= 0, n: pool.filter(function (b) { return hasBookTag(b, x.id); }).length }); })
		.filter(function (x) { return x.on || x.n || (edit && !sel.length); });
	list.sort(function (a, b) { return b.on - a.on; });
	show(box, list.length > 0 || edit);
	box.classList.toggle("filtering", sel.length > 0);
	var chips = h("div", "chips");
	chips.setAttribute("aria-label", "Book tags");
	list.forEach(function (x) {
		var c = chip(x.name, x.cls);
		if (x.n) c.append(h("span", "n", String(x.n)));
		c.href = libHash(x.on ? sel.filter(function (id) { return id !== x.id; }) : x.id === 0 ? [0] : sel.concat(x.id));
		if (x.on) c.setAttribute("aria-current", "true");
		chips.append(c);
	});
	if (sel.length > 1) {
		var clear = chip("Clear", "untagged clear");
		clear.href = "#/library";
		chips.append(clear);
	}
	box.append(chips);
	if (!edit) return;
	var t = sel.length === 1 && sel[0] ? bookTagById(sel[0]) : null, tools = h("div", "tools");
	if (t) tools.append(
		button("Rename “" + t.name + "”", "btn small", function () { renameBookTag(t); }),
		button("Delete tag", "btn small", function () { deleteBookTag(t); })
	);
	tools.append(button("New tag", "btn small", function () { promptBookTag().then(function () { renderBooks(); }, fail); }));
	box.append(tools);
	if (!t && state.bookTags.length) box.append(h("div", "hint", sel.length ? "Pick just one tag to rename or delete it." : "Pick a tag to rename or delete it."));
}
async function promptBookTag() {
	var name = prompt("Name for the new book tag");
	if (!name || !name.trim()) return null;
	var data = await apiJSON("/api/booktags", { method: "POST", json: { name: name.trim() } });
	await loadBookTags();
	return data.tag;
}
async function renameBookTag(t) {
	var name = prompt("Rename tag", t.name);
	if (!name || !name.trim() || name.trim() === t.name) return;
	try { await apiJSON("/api/booktags/" + t.id, { method: "PATCH", json: { name: name.trim() } }); await loadBookTags(); } catch (e) { fail(e); }
}
async function deleteBookTag(t) {
	var n = (state.books || []).filter(function (b) { return hasBookTag(b, t.id); }).length;
	var what = n ? "It comes off " + n + " book" + (n === 1 ? "" : "s") + "; the books stay." : "No books have it.";
	if (!confirm("Delete the tag “" + t.name + "”? " + what)) return;
	try {
		await apiJSON("/api/booktags/" + t.id, { method: "DELETE" });
		if (state.libTags.indexOf(t.id) >= 0) location.hash = libHash(state.libTags.filter(function (id) { return id !== t.id; }));
		await Promise.all([loadBookTags(), loadBooks()]);
	} catch (e) { fail(e); }
}
// Put tag id on book b, or take it off. Shows at once; saves the whole set.
async function toggleBookTag(b, id) {
	var before = b.tags || [], next = hasBookTag(b, id) ? before.filter(function (x) { return x !== id; }) : before.concat(id);
	b.tags = next;
	renderBooks();
	try {
		var data = await apiJSON("/api/books/" + b.id, { method: "PATCH", json: { tags: next } });
		b.tags = data.book.tags;
		keepBookDetails(b);
	} catch (e) { b.tags = before; fail(e); }
	renderBooks();
}
function bookTagToggles(b) {
	var box = h("div", "chips feedtags");
	box.setAttribute("role", "group");
	box.setAttribute("aria-label", "Tags for " + b.title);
	state.bookTags.forEach(function (t) {
		var c = button(t.name, "chip " + tagColor(t.id), function () { toggleBookTag(b, t.id); });
		c.setAttribute("aria-pressed", String(hasBookTag(b, t.id)));
		box.append(c);
	});
	box.append(button("+ Tag", "chip add", async function () {
		try {
			var t = await promptBookTag();
			if (t && !hasBookTag(b, t.id)) await toggleBookTag(b, t.id); else renderBooks();
		} catch (e) { fail(e); }
	}));
	return box;
}
function bookTagDots(b) {
	var d = h("span", "dots"), names = [];
	bookTagsOf(b).forEach(function (id) {
		var t = bookTagById(id), i = h("i", tagColor(id));
		i.title = t.name;
		names.push(t.name);
		d.append(i);
	});
	d.setAttribute("aria-label", "Tags: " + names.join(", "));
	return d;
}

// ---------- books offline
// Download keeps a book's file in this browser's storage (Cache Storage),
// the same way as a podcast episode; the list of downloaded books, with each
// one's details, is in localStorage, so the Library shows them with no
// connection. A book's place (and Finished) is saved on this device first
// (bookPending) and sent when there's a connection. Each saved place carries
// the time it was saved (at), so a newer place from another device wins over
// an older one that was waiting here.

var BOOK_CACHE = "reader-books-v1", LIBS_CACHE = "reader-libs-v1";
var bookDownloads = readJSON("readerBookDownloads") || {};
var bookPending = readJSON("readerBookPending") || {};
var bookDl = {};
// What the PDF viewer needs, kept with the first downloaded PDF (the service
// worker serves them from LIBS_CACHE after that). Character maps for CJK
// PDFs aren't here; they're kept as they're used.
var PDF_FILES = [PDFJS + "pdf.min.mjs", PDFJS + "pdf.worker.min.mjs"].concat(["FoxitDingbats.pfb", "FoxitFixed.pfb", "FoxitFixedBold.pfb",
	"FoxitFixedBoldItalic.pfb", "FoxitFixedItalic.pfb", "FoxitSerif.pfb", "FoxitSerifBold.pfb", "FoxitSerifBoldItalic.pfb", "FoxitSerifItalic.pfb",
	"FoxitSymbol.pfb", "LiberationSans-Bold.ttf", "LiberationSans-BoldItalic.ttf", "LiberationSans-Italic.ttf", "LiberationSans-Regular.ttf"]
	.map(function (f) { return PDFJS_DATA + "standard_fonts/" + f; }));

function bookKey(id) { return location.origin + "/bookfile/" + id; }
function saveBookDownloads() { store("readerBookDownloads", JSON.stringify(bookDownloads)); }
function saveBookPending() { store("readerBookPending", JSON.stringify(bookPending)); }
// fetch() fails with a TypeError when there's no connection.
function isOffline(e) { return navigator.onLine === false || e instanceof TypeError; }
function bookAt(position) { var p = parsePos(position); return (p && p.at) || 0; }
function downloadedBooks() {
	return Object.keys(bookDownloads).map(function (id) { return bookDownloads[id]; })
		.sort(function (a, b) { return (b.last_opened_at || b.created_at) - (a.last_opened_at || a.created_at); });
}
function keepBookDetails(b) {
	if (!bookDownloads[b.id]) return;
	bookDownloads[b.id] = Object.assign({}, b, { saved_at: bookDownloads[b.id].saved_at });
	saveBookDownloads();
}
// Fresh details for downloaded books; drop the ones deleted elsewhere.
function refreshBookDownloads(books) {
	var live = {};
	books.forEach(function (b) { live[b.id] = true; if (bookDownloads[b.id]) bookDownloads[b.id] = Object.assign({}, b, { saved_at: bookDownloads[b.id].saved_at }); });
	Object.keys(bookDownloads).forEach(function (id) { if (!live[id]) forgetBookDownload(id); });
	Object.keys(bookPending).forEach(function (id) { if (!live[id]) delete bookPending[id]; });
	saveBookDownloads();
	saveBookPending();
}
// Changes waiting on this device, laid over the list. From the server, a
// waiting place that's older than the server's is dropped.
function applyPending(books, fromServer) {
	books.forEach(function (b) {
		var p = bookPending[b.id];
		if (!p) return;
		if (p.position !== undefined) {
			if (bookAt(p.position) > bookAt(b.position)) b.position = p.position;
			else if (fromServer) delete p.position;
		}
		if (p.finished !== undefined) b.finished_at = p.finished ? (b.finished_at || p.finished) : null;
		if (p.layout !== undefined) b.layout = p.layout;
		if (p.position === undefined && p.finished === undefined && p.layout === undefined && !p.opened) delete bookPending[b.id];
	});
	saveBookPending();
}
function pendingBody(p) {
	var body = {};
	if (p.position !== undefined) body.position = p.position;
	if (p.finished !== undefined) body.finished = !!p.finished;
	if (p.opened) body.opened = true;
	if (p.layout !== undefined) body.layout = p.layout;
	return body;
}
function queueBook(id, fields) {
	var p = bookPending[id] = Object.assign({}, bookPending[id], fields);
	saveBookPending();
	return p;
}
// Sends one book's waiting changes. Only clears them if nothing newer was
// saved meanwhile.
async function sendPending(id, keepalive) {
	var p = bookPending[id], body = p && pendingBody(p);
	if (!p) return;
	if (!Object.keys(body).length) { delete bookPending[id]; saveBookPending(); return; }
	var res = await api("/api/books/" + id, { method: "PATCH", json: body, keepalive: !!keepalive });
	if (!res.ok && res.status !== 404) throw new Error("HTTP " + res.status);
	if (bookPending[id] === p) { delete bookPending[id]; saveBookPending(); }
	if (res.ok) {
		var b = (await res.json().catch(function () { return {}; })).book;
		var mine = (state.books || []).filter(function (x) { return x.id === Number(id); })[0];
		if (b && mine) mine.finished_at = b.finished_at;
	}
}
var syncingBooks = false;
async function syncBooks() {
	if (syncingBooks) return;
	syncingBooks = true;
	try {
		var ids = Object.keys(bookPending);
		for (var i = 0; i < ids.length; i++) await sendPending(ids[i]);
	} catch (e) {} finally { syncingBooks = false; }
}
// A place in the book: saved here, then sent (or left waiting if offline).
function setPosition(b, value, keepalive) {
	b.position = value;
	if (bookDownloads[b.id]) { bookDownloads[b.id].position = value; saveBookDownloads(); }
	queueBook(b.id, { position: value });
	sendPending(b.id, keepalive).catch(function () {});
}

// The file: this device's copy if there is one, else from the Worker.
async function bookFileRes(b) {
	if (bookDownloads[b.id] && window.caches) {
		try {
			var res = await (await caches.open(BOOK_CACHE)).match(bookKey(b.id));
			if (res) {
				b.last_opened_at = Date.now();
				queueBook(b.id, { opened: 1 });
				sendPending(b.id).catch(function () {});
				return res;
			}
		} catch (e) {}
		// The browser cleared it (low on space, or unused for a while).
		forgetBookDownload(b.id);
		saveBookDownloads();
	}
	try { res = await api("/api/books/" + b.id + "/file"); }
	catch (e) { throw isOffline(e) ? new Error("You're offline, and this book isn't downloaded on this device.") : e; }
	if (!res.ok) throw new Error("Couldn't load the book (HTTP " + res.status + ").");
	return res;
}
async function downloadBook(b) {
	if (!window.caches || !window.ReadableStream) return toast("This browser can't keep downloads.");
	var p = bookDl[b.id] = { got: 0, total: b.size || 0 };
	repaintBook(b.id);
	try {
		await askToKeep();
		var res = await api("/api/books/" + b.id + "/file?dl=1");
		if (!res.ok) {
			var d = await res.json().catch(function () { return {}; });
			throw new Error(d.error || "HTTP " + res.status);
		}
		var counted = counting(res, p, function () { repaintBook(b.id); });
		await (await caches.open(BOOK_CACHE)).put(bookKey(b.id), new Response(counted, { headers: { "Content-Type": res.headers.get("Content-Type") || "" } }));
		bookDownloads[b.id] = Object.assign({}, b, { saved_at: Date.now() });
		saveBookDownloads();
		if (b.type === "pdf") await keepPdfViewer().catch(function () {
			toast("Downloaded, but the PDF viewer couldn't be saved. Open this book once while online.");
		});
	} catch (e) {
		if (e.message !== UNAUTH) toast(/quota/i.test(e.name + e.message) ? "Not enough space on this device for that book." : "Couldn't download it: " + e.message);
	} finally {
		delete bookDl[b.id];
		repaintBook(b.id);
	}
}
async function keepPdfViewer() {
	var c = await caches.open(LIBS_CACHE);
	await Promise.all(PDF_FILES.map(async function (u) { if (!(await c.match(u))) await c.add(u); }));
}
function forgetBookDownload(id) {
	delete bookDownloads[id];
	if (window.caches) caches.open(BOOK_CACHE).then(function (c) { return c.delete(bookKey(id)); }).catch(function () {});
}
async function removeBookDownload(b) {
	forgetBookDownload(b.id);
	saveBookDownloads();
	if (state.libOffline) await loadBooks().catch(fail);
	repaintBook(b.id);
}
function toggleBookDownload(b) {
	if (bookDl[b.id]) return;
	if (!bookDownloads[b.id]) return downloadBook(b);
	if (confirm("Remove the download of “" + b.title + "” from this device?")) removeBookDownload(b);
}
function bookDlButton(b) {
	var btn = h("button", "btn small dl");
	btn.type = "button";
	btn.dataset.bookdl = b.id;
	paintBookDl(btn, b);
	btn.addEventListener("click", function (e) { e.preventDefault(); toggleBookDownload(b); });
	return btn;
}
function dlLabel(p) { return p.total ? Math.min(99, Math.floor(p.got / p.total * 100)) + "%" : Math.round(p.got / 1048576) + " MB"; }
function paintBookDl(btn, b) {
	var p = bookDl[b.id], have = !!bookDownloads[b.id];
	btn.classList.toggle("on", have);
	btn.textContent = p ? dlLabel(p) : have ? "✓" : "⤓";
	btn.setAttribute("aria-label", (have ? "Remove download of " : "Download ") + b.title);
	btn.title = have ? "Downloaded. Tap to remove from this device." : "Download for reading offline";
}
function repaintBook(id) {
	var b = (state.books || []).filter(function (x) { return x.id === Number(id); })[0] || bookDownloads[id];
	if (!b) return;
	document.querySelectorAll("[data-bookdl='" + id + "']").forEach(function (btn) { paintBookDl(btn, b); });
	if (session && session.id === Number(id)) renderBookMenu();
}
// The Library: one list, most recently opened first, narrowed to a tag if
// one is picked.
function renderBooks() {
	var ul = $("books"), books = state.books || [], edit = state.editBooks, sel = state.libTags;
	var grid = state.libView === "covers" && !edit;
	ul.textContent = "";
	ul.className = grid ? "covers" : "tree books flat";
	$("libLayout").textContent = state.libView === "covers" ? "List" : "Covers";
	$("libLayout").setAttribute("aria-pressed", String(state.libView === "covers"));
	show($("libLayout"), !edit);
	renderBookTags();
	var fmt = LIB_FORMATS[state.libFormat];
	books = libFiltered(libEntries(books));
	if (fmt) books = books.filter(fmt);
	var one = state.libSeries;
	if (one) books = books.filter(function (b) { return fold(b.series) === fold(one); });
	var tagged = books.length;
	if (!one && !sel.length && !edit && !state.libSearch.trim()) renderShelf($("libShelf"));
	else show($("libShelf"), false);
	books = sortBooks(books.filter(bookMatches(state.libSearch)), one ? "series" : state.libSort);
	var tagNames = sel.map(function (id) { return id === 0 ? "Untagged" : (bookTagById(id) || {}).name || ""; }).join(" + ");
	$("libTitle").textContent = one ? (books[0] ? books[0].series : one) : sel.length ? "Library · " + tagNames : "Library";
	$("libUp").href = libHash(sel);
	$("libUp").textContent = "‹ " + (sel.length ? "Library · " + tagNames : "Library");
	show($("libUp"), !!one);
	// Sorted by series (and not searching or editing), each series is one
	// entry that opens to its volumes; books in no series follow as they are.
	if (!one && state.libSort === "series" && !edit && !state.libSearch.trim()) {
		var seen = {};
		books.forEach(function (b) {
			if (!b.series) return ul.append(grid ? bookCard(b) : bookRow(b));
			var k = fold(b.series);
			if (seen[k]) return seen[k].books.push(b);
			seen[k] = { name: b.series, books: [b] };
			ul.append(seen[k].li = h("li"));
		});
		Object.keys(seen).forEach(function (k) { seen[k].li.replaceWith(grid ? seriesCard(seen[k]) : seriesRow(seen[k])); });
	} else books.forEach(function (b) { ul.append(grid ? bookCard(b) : bookRow(b)); });
	state.libShown = books;
	renderLibSel();
	var off = !!state.libOffline;
	$("booksEmpty").textContent = tagged && !books.length ? "No books match “" + state.libSearch.trim() + "”."
		: one ? "No books in this series" + (sel.length ? " with " + (sel.length > 1 ? "these tags." : "this tag.") : ".")
		: sel.length && (state.books || []).length ? (sel.length > 1 ? "No books have all of these tags." : "No books with this tag.")
		: fmt && (state.books || []).length ? (state.libFormat === "listen" ? "No audiobooks here yet." : "No ebooks here yet.")
		: off ? "You're offline, and no books are downloaded on this device." : "No books yet. Upload a .txt, .pdf, .epub or .cbz to start.";
	show($("booksEmpty"), !books.length);
	show($("libNote"), off && !!books.length);
	show($("libUpload"), !off);
	show($("editBooks"), !off);
	$("editBooks").textContent = edit ? "Done" : "Edit";
}
// Search: every word typed has to turn up in the title, author, series or
// file name, ignoring case and accents.
function fold(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
function bookMatches(q) {
	var words = fold(q).split(/\s+/).filter(Boolean);
	if (!words.length) return function () { return true; };
	return function (b) {
		var hay = fold([b.title, b.author, b.series, b.filename, b.narrator, b.audio && b.audio.title, b.audio && b.audio.narrator].join(" "));
		return words.every(function (w) { return hay.indexOf(w) >= 0; });
	};
}
// Recent is the server's order (last opened first). Title skips a leading
// "The", "A" or "An"; Author goes by last name; Series by series, then
// volume, with books in no series after.
function sortKey(s) { return fold(s).replace(/^(the|a|an)\s+/, ""); }
function lastName(a) { var w = String(a || "").split(/\s*(?:,|&| and )\s*/)[0].trim().split(/\s+/); return fold(w[w.length - 1]); }
function cmp(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }); }
function sortBooks(books, how) {
	if (how !== "title" && how !== "author" && how !== "series") return books;
	var byTitle = function (a, b) { return cmp(sortKey(a.title), sortKey(b.title)); };
	var bySeries = function (a, b) { return cmp(sortKey(a.series), sortKey(b.series)) || cmp(String(a.volume || ""), String(b.volume || "")); };
	return books.slice().sort(function (a, b) {
		if (how === "author") return (!a.author - !b.author) || cmp(lastName(a.author), lastName(b.author)) || cmp(fold(a.author), fold(b.author)) || bySeries(a, b) || byTitle(a, b);
		if (how === "series") return (!a.series - !b.series) || bySeries(a, b) || byTitle(a, b);
		return byTitle(a, b);
	});
}
// How far through a book is, for its progress bar: a finished book's is
// empty again (Finished says the rest), though its place is kept.
function bookPct(b, pos) { return !b.finished_at && pos && pos.f ? Math.round(pos.f * 100) : 0; }
function bookRow(b) {
	var li = h("li", "child"), row = h("div", "row"), a = h("a");
	a.href = "#/record/" + b.id;
	var pos = parsePos(b.position), pct = bookPct(b, pos);
	var meta = isAudiobook(b) ? ["Audiobook", hours(b.duration)] : [b.type.toUpperCase(), bytes(b.size)];
	if (b.audio) meta.push("Audiobook " + hours(b.audio.duration));
	if (pos && b.type !== "txt" && pos.page) meta.push("p. " + pos.page + (pos.pages ? " of " + pos.pages : ""));
	else if (pct) meta.push(pct + "%");
	if (b.last_opened_at) meta.push("opened " + ago(b.last_opened_at));
	var bar = h("div", "bar-prog"), fill = h("span");
	fill.style.width = pct + "%";
	bar.append(fill);
	var title = h("span", "bt", b.title);
	if (b.audio || isAudiobook(b)) title.append(" ", fmtIcons(b));
	if (bookTagsOf(b).length) title.append(" ", bookTagDots(b));
	if (b.finished_at) {
		var badge = h("span", "badge", "Finished");
		badge.title = "Finished " + longDate(b.finished_at);
		title.append(" ", badge);
	}
	var about = [b.author, b.series ? b.series + (b.volume ? " #" + b.volume : "") : b.volume ? "Vol. " + b.volume : ""].filter(Boolean).join(" · ");
	a.append(title);
	if (about) a.append(h("span", "ba", about));
	a.append(h("span", "bm", meta.join(" · ")), bar);
	if (state.editBooks) {
		var pick = h("input", "pick");
		pick.type = "checkbox";
		pick.checked = !!state.libSel[b.id];
		pick.setAttribute("aria-label", "Select " + b.title);
		pick.addEventListener("change", function () {
			if (pick.checked) state.libSel[b.id] = true; else delete state.libSel[b.id];
			renderLibSel();
		});
		row.append(pick);
	}
	row.append(a);
	if (!state.editBooks && window.caches && !isAudiobook(b)) row.append(bookDlButton(b));
	li.append(row);
	if (state.editBooks) {
		var t = h("div", "tools");
		t.append(
			button("Edit details", "btn small", function (e) { e.stopPropagation(); openDetails(b); }),
			button(b.finished_at ? "Mark unfinished" : "Mark finished", "btn small", async function () {
				try { await setFinished(b, !b.finished_at); } catch (e) { fail(e); }
				renderBooks();
			}),
			button("Start over", "btn small", async function () {
				if (!confirmStartOver(b)) return;
				try { await resetPosition(b); } catch (e) { fail(e); }
				renderBooks();
			}),
			fromHome(b) ? "" : button("Delete", "btn small", function () { deleteBook(b); })
		);
		li.append(t, bookTagToggles(b));
	}
	return li;
}
// The Covers view: a book's cover over its title and author. A cover comes
// from the Worker (an EPUB's own, a comic's first page, a PDF's first page
// once the PDF has been opened here); a .txt book, or one without, gets one
// drawn from its title and author. Covers load as they scroll into view and
// are kept for this visit.
var coverUrls = {}, coverIO = null;
var COVER_COLORS = ["#7a3b2e", "#2f4f6f", "#3d5a3a", "#5b3f6e", "#8a6a1f", "#1f5e5e", "#6b2f45", "#4a4f63", "#7b4a1c", "#35524a"];
function bookCard(b) {
	var li = h("li"), a = h("a"), cov = coverBox(b);
	a.href = "#/record/" + b.id;
	a.setAttribute("aria-label", b.title + (b.author ? ", " + b.author : "") + (b.audio ? ", ebook and audiobook" : isAudiobook(b) ? ", audiobook" : ""));
	if (b.finished_at) cov.append(h("span", "badge cdone", "Finished"));
	var pos = parsePos(b.position), pct = bookPct(b, pos);
	var bar = h("div", "bar-prog"), fill = h("span");
	fill.style.width = pct + "%";
	bar.append(fill);
	a.append(cov, h("span", "ct", b.title));
	if (b.author) a.append(h("span", "ca", b.author));
	if (b.audio || isAudiobook(b)) a.append(fmtIcons(b));
	if (pct) a.append(bar);
	li.append(a);
	return li;
}
// A book's cover: drawn at once, its real one loaded as it comes on screen.
function coverBox(b) {
	var cov = h("div", "cover");
	cov.append(drawnCover(b));
	// An ebook with no cover of its own borrows its audiobook's.
	if (b.audio && b.cover === "none") b = b.audio;
	cov.dataset.cover = b.id;
	if (coverUrls[b.id]) showCover(cov, coverUrls[b.id]);
	else if (b.cover === "yes" || (b.type !== "txt" && b.cover !== "none")) watchCover(b, cov);
	return cov;
}
// A series in the Series sort, g: {name, books (in volume order)}.
function seriesHref(name) {
	var sel = state.libTags;
	return "#/library?" + (sel.length ? "tag=" + sel.join(",") + "&" : "") + "series=" + encodeURIComponent(name);
}
function seriesAbout(g) {
	var n = g.books.length, read = g.books.filter(function (b) { return b.finished_at; }).length;
	var authors = g.books.map(function (b) { return b.author; }).filter(Boolean);
	return { read: read, n: n, author: authors[0] || "", said: read + " of " + n + " read" };
}
function seriesProg(x) {
	var bar = h("div", "bar-prog"), fill = h("span");
	fill.style.width = Math.round(x.read / x.n * 100) + "%";
	bar.append(fill);
	return bar;
}
function seriesRow(g) {
	var li = h("li", "child series"), row = h("div", "row"), a = h("a", "sgroup"), x = seriesAbout(g);
	a.href = seriesHref(g.name);
	a.group = g;
	a.append(h("span", "bt", g.name));
	if (x.author) a.append(h("span", "ba", x.author));
	a.append(h("span", "bm", x.said), seriesProg(x));
	row.append(a);
	li.append(row);
	return li;
}
function seriesCard(g) {
	var li = h("li", "series"), a = h("a", "sgroup"), x = seriesAbout(g);
	a.href = seriesHref(g.name);
	a.group = g;
	a.setAttribute("aria-label", g.name + ", series, " + x.said);
	a.append(coverBox(g.books[0]), h("span", "ct", g.name), h("span", "ca", x.said));
	if (x.read) a.append(seriesProg(x));
	li.append(a);
	return li;
}
// A drawn cover's color, the same for the same words every time.
function coverColor(key) {
	var n = 0;
	key = key || "";
	for (var i = 0; i < key.length; i++) n = (n * 31 + key.charCodeAt(i)) >>> 0;
	return COVER_COLORS[n % COVER_COLORS.length];
}
function drawnCover(b) {
	var g = h("div", "gencover");
	g.style.backgroundColor = coverColor((b.title || "") + (b.author || ""));
	g.setAttribute("aria-hidden", "true");
	g.append(h("span", "gt", b.title));
	if (b.author) g.append(h("span", "ga", b.author));
	g.append(h("span", "gk", b.type.toUpperCase()));
	return g;
}
function showCover(cov, url) {
	var img = h("img");
	img.alt = "";
	img.decoding = "async";
	img.src = url;
	cov.append(img);
}
function watchCover(b, cov) {
	if (!window.IntersectionObserver) return loadCover(b, cov);
	if (!coverIO) coverIO = new IntersectionObserver(function (entries) {
		entries.forEach(function (e) {
			if (!e.isIntersecting) return;
			coverIO.unobserve(e.target);
			loadCover(e.target.book, e.target);
		});
	}, { rootMargin: "300px 0px" });
	cov.book = b;
	coverIO.observe(cov);
}
// The Library may have been drawn again while the cover was on its way.
function coverArrived(b, cov) {
	var all = cov.isConnected ? [cov] : document.querySelectorAll('.cover[data-cover="' + b.id + '"]');
	Array.prototype.forEach.call(all, function (c) { if (!c.querySelector("img")) showCover(c, coverUrls[b.id]); });
}
async function loadCover(b, cov) {
	if (state.libOffline) return;
	if (b.type === "pdf" && b.cover !== "yes") return queuePdfCover(b, cov);
	try {
		var res = await api("/api/books/" + b.id + "/cover");
		if (res.status === 404) {
			b.cover = "none";
			if (b.audio) loadCover(b.audio, cov);
			return;
		}
		if (!res.ok) return;
		coverUrls[b.id] = URL.createObjectURL(await res.blob());
		b.cover = "yes";
		coverArrived(b, cov);
	} catch (e) {}
}
// A PDF's cover: its first page, drawn small and kept by the Worker. Drawn
// when the PDF is opened here, or when its spot in the Covers view comes on
// screen: then pdf.js reads only the parts of the file that page needs, one
// PDF at a time. A PDF that can't be drawn keeps its drawn cover.
async function pdfCoverBlob(doc) {
	var page = await doc.getPage(1), vp1 = page.getViewport({ scale: 1 });
	var vp = page.getViewport({ scale: 360 / vp1.width }), canvas = document.createElement("canvas");
	canvas.width = Math.floor(vp.width);
	canvas.height = Math.floor(vp.height);
	var ctx = canvas.getContext("2d");
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	await page.render({ canvasContext: ctx, viewport: vp }).promise;
	var blob = await new Promise(function (ok) { canvas.toBlob(ok, "image/jpeg", 0.82); });
	canvas.width = canvas.height = 0;
	page.cleanup();
	return blob;
}
async function savePdfCover(b, blob) {
	var res = await api("/api/books/" + b.id + "/cover", { method: "PUT", body: blob });
	if (!res.ok) return false;
	b.cover = "yes";
	if (coverUrls[b.id]) URL.revokeObjectURL(coverUrls[b.id]);
	coverUrls[b.id] = URL.createObjectURL(blob);
	return true;
}
async function sendPdfCover(sess) {
	var b = sess.book;
	if (b.cover === "yes" || state.libOffline || !window.HTMLCanvasElement) return;
	try {
		var blob = await pdfCoverBlob(sess.pdf.doc);
		if (blob) await savePdfCover(b, blob);
	} catch (e) {}
}
var pdfCoverLine = Promise.resolve(), pdfCoverTried = {};
function queuePdfCover(b, cov) {
	if (pdfCoverTried[b.id] || !b.size || !window.HTMLCanvasElement) return;
	pdfCoverTried[b.id] = true;
	pdfCoverLine = pdfCoverLine.then(function () { return pdfCoverFromFile(b, cov); }).catch(function () {});
}
async function pdfCoverFromFile(b, cov) {
	if (b.cover === "yes" || state.libOffline) return;
	var CHUNK = 65536, size = b.size, failed = null;
	var part = async function (at, len) {
		var res = await api("/api/books/" + b.id + "/part?at=" + at + "&len=" + len);
		if (!res.ok) throw new Error("HTTP " + res.status);
		return new Uint8Array(await res.arrayBuffer());
	};
	var lib = await loadPdfJs();
	var range = new lib.PDFDataRangeTransport(size, await part(0, Math.min(CHUNK, size)));
	range.requestDataRange = function (begin, end) {
		part(begin, end - begin).then(function (d) { range.onDataRange(begin, d); }, function (e) { failed = e; });
	};
	var task = lib.getDocument({
		range: range, length: size, rangeChunkSize: CHUNK, disableAutoFetch: true, disableStream: true,
		isEvalSupported: false, useWorkerFetch: false,
		cMapUrl: PDFJS_DATA + "cmaps/", cMapPacked: true, standardFontDataUrl: PDFJS_DATA + "standard_fonts/"
	});
	// A piece that never comes leaves pdf.js waiting: give up after a minute.
	var timer, limit, giveUp = new Promise(function (_, no) {
		timer = setInterval(function () { if (failed) no(failed); }, 500);
		limit = setTimeout(function () { no(new Error("timed out")); }, 60000);
	});
	giveUp.catch(function () {});
	try {
		var blob = await Promise.race([task.promise.then(pdfCoverBlob), giveUp]);
		if (blob && await savePdfCover(b, blob)) coverArrived(b, cov);
	} finally {
		clearInterval(timer);
		clearTimeout(limit);
		task.destroy();
	}
}
// Edit details: a book's title, author, series and volume, its cover (an
// image chosen here, drawn small, or back to the automatic one) and its tags.
var details = null;
function openDetails(b) {
	details = { book: b, cover: undefined, url: null };
	$("dTitle").value = b.title || "";
	$("dAuthor").value = b.author || "";
	$("dSeries").value = b.series || "";
	$("dVolume").value = b.volume || "";
	$("dCoverFile").value = "";
	$("dLookStatus").textContent = "";
	$("dHits").textContent = "";
	$("dCovers").textContent = "";
	show($("dHits"), false);
	show($("dCovers"), false);
	renderDetailsCover();
	renderDetailsTags();
	fillDetailsRecord(null);
	loadDetailsRecord(b, "");
	show($("detailsBox"), true);
	$("dTitle").focus();
}
// The Record's jacket copy, pages and appeal terms, as the family library shows them.
var APPEAL_LABELS = { pacing: "Pacing", tone: "Tone", style: "Writing style", characters: "Characters", story: "Storyline" };
function appealText(a) {
	return Object.keys(APPEAL_LABELS).filter(function (k) { return a && a[k] && a[k].length; })
		.map(function (k) { return APPEAL_LABELS[k] + ": " + a[k].join(", "); }).join("\n");
}
function appealParse(text) {
	var out = {}, keys = {};
	Object.keys(APPEAL_LABELS).forEach(function (k) { keys[APPEAL_LABELS[k].toLowerCase()] = k; keys[k] = k; });
	keys.style = keys.writing = "style"; keys.characterization = "characters"; keys.story = keys["story line"] = "story";
	text.split("\n").forEach(function (line) {
		var m = /^\s*([^:]+):(.*)$/.exec(line), k = m && keys[m[1].trim().toLowerCase()];
		if (k) out[k] = m[2].split(",").map(function (t) { return t.trim(); }).filter(Boolean);
	});
	return out;
}
var CATALOG_LABELS = { year: "Published", publisher: "Publisher", language: "Language", classification: "Classification", isbn: "ISBN", subjects: "Subjects" };
function catalogText(c) {
	return Object.keys(CATALOG_LABELS).filter(function (k) { return c && c[k] && c[k].length; }).map(function (k) {
		return CATALOG_LABELS[k] + ": " + (Array.isArray(c[k]) ? c[k].join("; ") : c[k]);
	}).join("\n");
}
// Every field, so a line taken out clears it.
function catalogParse(text) {
	var out = {}, keys = { published: "year", year: "year", publisher: "publisher", language: "language", classification: "classification",
		"call number": "classification", dewey: "classification", isbn: "isbn", subjects: "subjects", subject: "subjects", "subject headings": "subjects" };
	Object.keys(CATALOG_LABELS).forEach(function (k) { out[k] = ""; });
	text.split("\n").forEach(function (line) {
		var m = /^\s*([^:]+):(.*)$/.exec(line), k = m && keys[m[1].trim().toLowerCase()];
		if (k) out[k] = m[2].trim();
	});
	return out;
}
function fillDetailsRecord(rec) {
	details.record = rec;
	$("dCatalog").value = rec ? catalogText(rec.catalog) : "";
	$("dBlurb").value = rec && rec.blurb || "";
	$("dPages").value = rec && rec.pages ? String(rec.pages) : "";
	$("dAppeal").value = rec ? appealText(rec.appeal) : "";
	var from = rec && rec.from || {};
	$("dRecStatus").textContent = !rec ? "" : !rec.filled ? "Not looked up yet." : [
		from.blurb && from.blurb !== "edited" && "copy from " + ({ file: "the file", openlibrary: "Open Library", google: "Google Books", ai: "AI" }[from.blurb] || from.blurb),
		from.pages === "estimate" && "pages estimated",
		from.loc === "none" && "no Library of Congress record",
		from.appeal && from.appeal !== "edited" && "terms by " + from.appeal,
		from.appeal_error && "no appeal factors: " + from.appeal_error
	].filter(Boolean).join(", ");
}
// how: "" (as saved), "fill" (look up if never done) or "refresh" (again, keeping edits).
async function loadDetailsRecord(b, how) {
	var d = details;
	if (how) $("dRecStatus").textContent = "Looking it up…";
	try {
		var data = await apiJSON("/api/books/" + b.id + "/record" + (how ? "?" + how + "=1" : ""));
		if (details === d) fillDetailsRecord(data.record);
	} catch (e) { if (details === d) $("dRecStatus").textContent = e.message; }
}
function recordPatch(patch) {
	var rec = details.record;
	if (!rec) return;
	var blurb = $("dBlurb").value.trim(), pages = $("dPages").value.trim(), appeal = appealParse($("dAppeal").value);
	if (blurb !== (rec.blurb || "")) patch.blurb = blurb;
	if (pages !== (rec.pages ? String(rec.pages) : "")) patch.pages = pages ? parseInt(pages, 10) || null : null;
	if (appealText(appeal) !== appealText(rec.appeal)) patch.appeal = appeal;
	var catalog = catalogParse($("dCatalog").value);
	if (catalogText(catalog) !== catalogText(rec.catalog)) patch.catalog = catalog;
}
function closeDetails() {
	if (details && details.url) URL.revokeObjectURL(details.url);
	details = null;
	show($("detailsBox"), false);
}
function renderDetailsCover() {
	var b = details.book, c = $("dCover");
	c.textContent = "";
	c.append(drawnCover(Object.assign({}, b, { title: $("dTitle").value || b.title })));
	if (details.cover) showCover(c, details.url);
	else if (details.cover === undefined) {
		if (coverUrls[b.id]) showCover(c, coverUrls[b.id]);
		else if (b.cover === "yes" || (b.type !== "txt" && b.cover !== "none")) loadCover(b, c);
	}
	show($("dCoverAuto"), details.cover !== null && (!!details.cover || b.cover === "yes"));
}
function renderDetailsTags() {
	var b = details.book, box = h("div", "chips feedtags");
	box.setAttribute("role", "group");
	box.setAttribute("aria-label", "Tags");
	(state.bookTags || []).forEach(function (t) {
		var c = button(t.name, "chip " + tagColor(t.id), function () { toggleBookTag(b, t.id).then(function () { if (details) renderDetailsTags(); }); });
		c.setAttribute("aria-pressed", String(hasBookTag(b, t.id)));
		box.append(c);
	});
	$("dTags").textContent = "";
	$("dTags").append(box);
}
// A chosen image, at most 600 pixels wide, as a JPEG.
async function coverFromImage(file) {
	var url = URL.createObjectURL(file), img = new Image();
	try {
		img.src = url;
		await img.decode();
		var scale = Math.min(1, 600 / img.naturalWidth), canvas = document.createElement("canvas");
		canvas.width = Math.round(img.naturalWidth * scale);
		canvas.height = Math.round(img.naturalHeight * scale);
		canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
		var blob = await new Promise(function (ok) { canvas.toBlob(ok, "image/jpeg", 0.85); });
		canvas.width = canvas.height = 0;
		if (!blob) throw new Error("Couldn't read that image.");
		return blob;
	} finally { URL.revokeObjectURL(url); }
}
// Look up online: Open Library's matches for the title and author typed.
// Picking one fills in its title and author and offers its covers.
async function lookUpDetails() {
	var d = details, q = [$("dTitle").value.trim(), $("dAuthor").value.trim()].filter(Boolean).join(" ");
	if (!q) { $("dTitle").focus(); return; }
	$("dLookStatus").textContent = "Looking…";
	show($("dCovers"), false);
	try {
		var data = await apiJSON("/api/books/lookup?q=" + encodeURIComponent(q));
		if (details !== d) return;
		var ul = $("dHits");
		ul.textContent = "";
		data.hits.forEach(function (hit) {
			var b = h("button"), li = h("li"), img = hit.thumb ? h("img") : h("span", "noimg"), txt = h("span");
			b.type = "button";
			if (hit.thumb) { img.src = hit.thumb; img.alt = ""; img.loading = "lazy"; }
			txt.append(h("span", "lt", hit.title), h("span", "lm", [hit.author, hit.year].filter(Boolean).join(" · ")));
			b.append(img, txt);
			b.addEventListener("click", function (e) {
				e.stopPropagation();
				ul.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
				pickLookup(hit);
			});
			li.append(b);
			ul.append(li);
		});
		show(ul, data.hits.length > 0);
		$("dLookStatus").textContent = data.hits.length ? "Pick the right one:" : "No matches. Try just the title.";
	} catch (e) { if (details === d) $("dLookStatus").textContent = e.message; }
}
async function pickLookup(hit) {
	var d = details;
	if (hit.title) $("dTitle").value = hit.title;
	if (hit.author) $("dAuthor").value = hit.author;
	renderDetailsCover();
	var box = $("dCovers");
	box.textContent = "";
	show(box, false);
	$("dLookStatus").textContent = "Finding covers…";
	try {
		var data = await apiJSON("/api/books/lookup/covers?" + new URLSearchParams({ work: hit.work, title: hit.title, author: hit.author, cover_id: hit.cover_id || "" }));
		if (details !== d) return;
		data.covers.forEach(function (u) {
			var b = h("button"), img = h("img");
			b.type = "button";
			b.setAttribute("aria-label", "Use this cover");
			img.src = u;
			img.alt = "";
			img.loading = "lazy";
			// Google sends a "no cover" picture for some books: leave those out.
			img.addEventListener("load", function () { if (img.naturalWidth < 40) b.remove(); });
			img.addEventListener("error", function () { b.remove(); });
			b.append(img);
			b.addEventListener("click", function (e) {
				e.stopPropagation();
				box.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
				useLookupCover(u);
			});
			box.append(b);
		});
		show(box, data.covers.length > 0);
		$("dLookStatus").textContent = data.covers.length ? "Pick a cover, or keep yours:" : "No covers found for that one.";
	} catch (e) { if (details === d) $("dLookStatus").textContent = e.message; }
}
async function useLookupCover(u) {
	var d = details;
	try {
		var res = await api("/api/books/lookup/image?url=" + encodeURIComponent(u));
		if (!res.ok) throw new Error((await res.json().catch(function () { return {}; })).error || "HTTP " + res.status);
		var blob = await coverFromImage(await res.blob());
		if (details !== d) return;
		if (d.url) URL.revokeObjectURL(d.url);
		d.cover = blob;
		d.url = URL.createObjectURL(blob);
		renderDetailsCover();
	} catch (e) { if (details === d) $("dLookStatus").textContent = e.message; }
}
async function saveDetails() {
	var d = details, b = d.book, patch = {};
	var vals = { title: $("dTitle").value.trim(), author: $("dAuthor").value.trim(), series: $("dSeries").value.trim(), volume: $("dVolume").value.trim() };
	if (!vals.title) { $("dTitle").focus(); return; }
	Object.keys(vals).forEach(function (k) { if (vals[k] !== (b[k] || "")) patch[k] = vals[k]; });
	recordPatch(patch);
	$("dSave").disabled = true;
	try {
		if (Object.keys(patch).length) {
			var data = await apiJSON("/api/books/" + b.id, { method: "PATCH", json: patch });
			Object.assign(b, data.book);
			keepBookDetails(b);
			if (session && session.book === b) { $("heading").textContent = b.title; document.title = b.title + " — Reader"; }
		}
		if (d.cover !== undefined) {
			var res = await api("/api/books/" + b.id + "/cover", d.cover ? { method: "PUT", body: d.cover } : { method: "DELETE" });
			if (!res.ok) throw new Error((await res.json().catch(function () { return {}; })).error || "HTTP " + res.status);
			if (coverUrls[b.id]) URL.revokeObjectURL(coverUrls[b.id]);
			delete coverUrls[b.id];
			pdfCoverTried[b.id] = false;
			if (d.cover) { coverUrls[b.id] = d.url; d.url = null; b.cover = "yes"; } else b.cover = null;
		}
		closeDetails();
		renderBooks();
		if (state.record && onRecord(state.record)) { delete recCache[state.record.id]; showRecord(state.record.id).catch(fail); }
	} catch (e) { fail(e); }
	finally { $("dSave").disabled = false; }
}
$("detailsForm").addEventListener("submit", function (e) { e.preventDefault(); saveDetails(); });
$("dCancel").addEventListener("click", closeDetails);
$("dLookup").addEventListener("click", function (e) { e.stopPropagation(); lookUpDetails(); });
$("dGenres").addEventListener("click", async function (e) {
	e.stopPropagation();
	var d = details, btn = this;
	btn.disabled = true;
	$("dLookStatus").textContent = "Finding genres…";
	try {
		var data = await tagBookGenres(d.book, { title: $("dTitle").value.trim(), author: $("dAuthor").value.trim() });
		if (details !== d) return;
		$("dLookStatus").textContent = genresSaid(data);
		renderDetailsTags();
	} catch (err) { if (details === d) $("dLookStatus").textContent = err.message; }
	finally { btn.disabled = false; }
});
$("dRecord").addEventListener("click", function (e) {
	e.stopPropagation();
	if (details) loadDetailsRecord(details.book, details.record && details.record.filled ? "refresh" : "fill");
});
$("dCoverPick").addEventListener("click", function () { $("dCoverFile").click(); });
$("dCoverFile").addEventListener("change", async function () {
	var file = this.files[0];
	if (!file || !details) return;
	try {
		var blob = await coverFromImage(file);
		if (details.url) URL.revokeObjectURL(details.url);
		details.cover = blob;
		details.url = URL.createObjectURL(blob);
		renderDetailsCover();
	} catch (e) { fail(new Error("Couldn't read that image.")); }
});
$("dCoverAuto").addEventListener("click", function () {
	if (details.url) URL.revokeObjectURL(details.url);
	details.url = null;
	details.cover = details.book.cover === "yes" ? null : undefined;
	renderDetailsCover();
});
$("bmDetails").addEventListener("click", function (e) {
	e.stopPropagation();
	openBookMenu(false);
	if (session) openDetails(session.book);
});
document.addEventListener("click", function (e) {
	if (!$("detailsBox").hidden && !$("detailsBox").contains(e.target)) closeDetails();
});

$("libLayout").addEventListener("click", function () {
	state.libView = state.libView === "covers" ? "list" : "covers";
	store("readerBookView", state.libView === "covers" ? "covers" : null);
	if (state.books) renderBooks();
});
// Deletes the book and its file for good, and this device's download of it.
async function deleteBook(b) {
	if (!confirm("Delete “" + b.title + "”? The file is removed for good, from every device.")) return false;
	try {
		await dropBook(b);
		await loadBooks();
		return true;
	} catch (e) { fail(e); return false; }
}
async function dropBook(b) {
	await apiJSON("/api/books/" + b.id, { method: "DELETE" });
	forgetBookDownload(b.id);
	saveBookDownloads();
	delete bookPending[b.id];
	saveBookPending();
	delete state.libSel[b.id];
}
// Picking books in Edit mode, to delete several at once. Only books the
// current search and tag show count, so a hidden pick is never deleted.
function selectedBooks() {
	return (state.libShown || []).filter(function (b) { return state.libSel[b.id]; });
}
function renderLibSel() {
	var on = state.editBooks && !state.libOffline, n = on ? selectedBooks().length : 0, all = (state.libShown || []).length;
	show($("libSelBar"), on && all > 0);
	$("libSelN").textContent = n ? n + " selected" : "Tick books to tag or delete several at once.";
	show($("libSelNone"), n > 0);
	show($("libSelAll"), n < all);
	$("libSelDel").disabled = !n;
	$("libSelGenres").disabled = !n;
	$("libSelFill").disabled = !n;
	$("libSelRecord").disabled = !n;
	$("libSelDel").textContent = n ? "Delete " + n : "Delete";
}
async function deleteSelected() {
	// Books from Audiobookshelf stay: the next sync would bring them back.
	var books = selectedBooks().filter(function (b) { return !fromHome(b); }), btn = $("libSelDel");
	if (!books.length) { if (selectedBooks().length) toast("These come from Audiobookshelf. Remove them there."); return; }
	var names = books.slice(0, 5).map(function (b) { return "• " + b.title; }).join("\n") + (books.length > 5 ? "\n…and " + (books.length - 5) + " more" : "");
	if (!confirm("Delete " + books.length + (books.length === 1 ? " book" : " books") + "? The files are removed for good, from every device.\n\n" + names)) return;
	btn.disabled = true;
	var failed = [];
	for (var i = 0; i < books.length; i++) {
		$("libSelN").textContent = "Deleting " + (i + 1) + " of " + books.length + "…";
		try { await dropBook(books[i]); } catch (e) {
			if (e.message === UNAUTH) return;
			failed.push(books[i].title);
		}
	}
	await loadBooks();
	if (failed.length) fail(new Error("Couldn't delete " + failed.join(", ") + "."));
	else toast(books.length === 1 ? "Deleted 1 book." : "Deleted " + books.length + " books.");
}

// Tag genres: the server adds genre tags from the book's own file, or else
// from Open Library, and says which. hints: {title, author} to look it up by.
async function tagBookGenres(b, hints) {
	var data = await apiJSON("/api/books/" + b.id + "/genres", { method: "POST", json: hints || {} });
	b.tags = data.book.tags;
	keepBookDetails(b);
	var known = {};
	(state.bookTags || []).forEach(function (t) { known[t.name.toLowerCase()] = true; });
	if (data.added.some(function (n) { return !known[n.toLowerCase()]; })) await loadBookTags();
	return data;
}
function genresSaid(data) {
	if (data.added.length) return "Added " + data.added.join(", ") + (data.from === "online" ? " (from Open Library)." : " (from the file).");
	return data.from ? "It already has its genres." : "Found no genres for it.";
}
async function tagGenresSelected() {
	var books = selectedBooks(), btn = $("libSelGenres");
	if (!books.length) return;
	btn.disabled = true;
	var tagged = 0, had = 0, none = 0, failed = [];
	for (var i = 0; i < books.length; i++) {
		$("libSelN").textContent = "Tagging " + (i + 1) + " of " + books.length + "…";
		try {
			var data = await tagBookGenres(books[i]);
			if (data.added.length) tagged++; else if (data.from) had++; else none++;
		} catch (e) {
			if (e.message === UNAUTH) return;
			failed.push(books[i].title);
		}
	}
	renderBooks();
	var count = function (n) { return n + (n === 1 ? " book" : " books"); };
	var msg = [tagged && "Added genres to " + count(tagged) + ".", had && count(had) + " already had theirs.",
		none && "Found no genres for " + count(none) + "."].filter(Boolean).join(" ");
	if (failed.length) fail(new Error((msg ? msg + " " : "") + "Couldn't tag " + failed.join(", ") + "."));
	else toast(msg);
}

// Fill in details: title, series and volume from each selected comic's
// ComicInfo.xml, for comics uploaded before it was read. Only blanks are
// filled (and a title still made from the file name). Other books are left
// alone: EPUBs fill theirs in when opened, and a .txt's header would replace
// what was typed in Edit details.
async function fillSelected() {
	var books = selectedBooks().filter(function (b) { return b.type === "cbz"; }), btn = $("libSelFill");
	if (!books.length) return toast("Fill in details reads comics' ComicInfo.xml. None of these are comics.");
	btn.disabled = true;
	var changed = 0, failed = [];
	for (var i = 0; i < books.length; i++) {
		var b = books[i], before = [b.title, b.author, b.series, b.volume].join("|");
		$("libSelN").textContent = "Reading " + (i + 1) + " of " + books.length + "…";
		try {
			var d = await apiJSON("/api/books/" + b.id, { method: "PATCH", json: { reread: true } });
			Object.assign(b, d.book);
			keepBookDetails(b);
			if ([b.title, b.author, b.series, b.volume].join("|") !== before) changed++;
		} catch (e) {
			if (e.message === UNAUTH) return;
			failed.push(b.title);
		}
	}
	await loadBookTags().catch(function () {});
	renderBooks();
	var msg = changed ? "Filled in details for " + changed + (changed === 1 ? " book." : " books.") : "Nothing new to fill in.";
	if (failed.length) fail(new Error(msg + " Couldn't read " + failed.join(", ") + "."));
	else toast(msg);
}

// Look up records: each selected book's jacket copy, pages and appeal terms
// for the family library, ahead of anyone opening it there. Books already
// looked up are skipped (Edit details has "Look it up again" for one).
async function recordSelected() {
	var books = selectedBooks(), btn = $("libSelRecord");
	if (!books.length) return;
	btn.disabled = true;
	var done = 0, terms = 0, why = "", failed = [];
	for (var i = 0; i < books.length; i++) {
		$("libSelN").textContent = "Looking up " + (i + 1) + " of " + books.length + "…";
		try {
			var d = await apiJSON("/api/books/" + books[i].id + "/record?fill=1");
			done++;
			if (d.record.appeal) terms++;
			else why = why || d.record.from.appeal_error || "";
		} catch (e) {
			if (e.message === UNAUTH) return;
			failed.push(books[i].title);
		}
	}
	renderBooks();
	var msg = done ? "Records ready for " + done + (done === 1 ? " book" : " books") + (terms < done ? " (" + (done - terms) + " without appeal factors" + (why ? ", e.g. " + why : "") + ")." : ".") : "";
	if (failed.length) fail(new Error((msg ? msg + " " : "") + "Couldn't look up " + failed.join(", ") + "."));
	else toast(msg);
}

// Right-click (or long-press, where the browser sends it) on a book in the
// Library: the book's actions in a small menu where the pointer is.
var ctxBook = null;
function ctxItem(menu, label, fn, cls) {
	var btn = button(label, "btn" + (cls ? " " + cls : ""), function (e) { e.stopPropagation(); closeBookCtx(); fn(); });
	btn.setAttribute("role", "menuitem");
	menu.append(btn);
	return btn;
}
function showBookCtx(x, y) {
	var box = $("bookCtx");
	openSettings(false);
	show(box, true);
	var w = box.offsetWidth, ht = box.offsetHeight;
	box.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + "px";
	box.style.top = Math.max(8, Math.min(y, innerHeight - ht - 8)) + "px";
	box.querySelector(".menu button").focus({ preventScroll: true });
}
function openBookCtx(b, x, y) {
	var menu = $("bookCtx").querySelector(".menu"), off = !!state.libOffline;
	var item = function (label, fn, cls) { ctxItem(menu, label, fn, cls); };
	ctxBook = b;
	menu.textContent = "";
	if (!isAudiobook(b)) item("Read", function () { location.hash = "#/book/" + b.id; });
	if (b.audio || isAudiobook(b)) item(listenLabel(audioOf(b)), function () { listenTo(audioOf(b)); });
	item("Record", function () { location.hash = "#/record/" + b.id; });
	if (!off) {
		item("Edit details", function () { openDetails(b); });
		item("Tag genres", async function () {
			try { toast(genresSaid(await tagBookGenres(b))); } catch (e) { fail(e); }
			renderBooks();
		});
		item(b.finished_at ? "Mark unfinished" : "Mark finished", async function () {
			try { await setFinished(b, !b.finished_at); } catch (e) { fail(e); }
			renderBooks();
		});
		item("Start over", async function () {
			if (!confirmStartOver(b)) return;
			try { await resetPosition(b); } catch (e) { fail(e); }
			renderBooks();
		});
	}
	if (window.caches && !isAudiobook(b)) item(bookDownloads[b.id] ? "Remove download" : "Download for offline", function () { toggleBookDownload(b); });
	if (!off) {
		item(state.editBooks && state.libSel[b.id] ? "Deselect" : "Select", function () {
			if (state.libSel[b.id]) delete state.libSel[b.id]; else state.libSel[b.id] = true;
			if (!state.editBooks) { state.editBooks = true; state.libSel = {}; state.libSel[b.id] = true; }
			renderBooks();
		});
		if (!fromHome(b)) {
			menu.append(h("div", "sep"));
			item("Delete", function () { deleteBook(b); }, "danger");
		}
	}
	showBookCtx(x, y);
}
// The same on a series in the Series sort, g: {name, books}. A series of one
// gets its book's menu; a longer one lists its volumes to edit each.
function openSeriesCtx(g, x, y) {
	if (g.books.length === 1) return openBookCtx(g.books[0], x, y);
	var menu = $("bookCtx").querySelector(".menu"), off = !!state.libOffline;
	ctxBook = null;
	menu.textContent = "";
	ctxItem(menu, "Open series", function () { location.hash = seriesHref(g.name); });
	if (!off) {
		menu.append(h("div", "sep"), h("div", "cap", "Edit details"));
		g.books.forEach(function (b) {
			ctxItem(menu, (b.volume ? b.volume + " · " : "") + b.title, function () { openDetails(b); }, "vol").title = b.title;
		});
		menu.append(h("div", "sep"));
		ctxItem(menu, "Select all volumes", function () {
			state.editBooks = true;
			state.libSel = {};
			g.books.forEach(function (b) { state.libSel[b.id] = true; });
			renderBooks();
		});
	}
	showBookCtx(x, y);
}
function closeBookCtx() {
	if ($("bookCtx").hidden) return;
	show($("bookCtx"), false);
	ctxBook = null;
}
// Finished: set on reaching the end, or by hand. Start over keeps it.
// Offline, it's kept here and sent later like a place in the book.
async function setFinished(b, on) {
	try {
		var data = await apiJSON("/api/books/" + b.id, { method: "PATCH", json: { finished: on } });
		b.finished_at = data.book.finished_at;
		if (bookPending[b.id] && bookPending[b.id].finished !== undefined) queueBook(b.id, { finished: undefined });
	} catch (e) {
		if (e.message === UNAUTH || !isOffline(e)) throw e;
		b.finished_at = on ? b.finished_at || Date.now() : null;
		queueBook(b.id, { finished: on ? b.finished_at : 0 });
	}
	keepBookDetails(b);
	renderBookMenu();
}
function confirmStartOver(b) {
	return confirm("Start “" + b.title + "” over? Your place goes back to the beginning." +
		(b.finished_at ? " It stays marked Finished, since you've read it once." : ""));
}
// The beginning, as a saved place (with its time, so it syncs like one). The
// furthest place goes with it; a bookmark stays (mark: the open book's,
// which may not be saved yet).
async function resetPosition(b, mark) {
	var p = { at: Date.now() };
	if (mark === undefined) mark = (parsePos(b.position) || {}).mark;
	if (mark) p.mark = mark;
	setPosition(b, JSON.stringify(p));
}
async function uploadFiles(files) {
	var tagId = Number($("uploadTag").value) || null;
	for (var i = 0; i < files.length; i++) await uploadOne(files[i], tagId);
	await Promise.all([loadBooks(), loadBookTags()]).catch(fail);
}
function uploadOne(file, tagId) {
	return new Promise(function (resolve) {
		var li = h("li", "", file.name + " …");
		$("uploads").append(li);
		var done = function (ok, msg) { li.textContent = (ok ? "✓ " : "✗ ") + file.name + (msg ? ": " + msg : ""); li.className = ok ? "" : "err"; resolve(); };
		if (!/\.(txt|pdf|cbz|epub)$/i.test(file.name)) return done(false, "only .txt, .pdf, .cbz and .epub files");
		var q = "name=" + encodeURIComponent(file.name) + (tagId ? "&tag=" + tagId : "");
		var progress = function (sent) { li.textContent = file.name + " … " + Math.round(sent / file.size * 100) + "%"; };
		// An EPUB is opened here first: a locked (DRM) one is turned away,
		// and its title, author and series go on the book once it's up.
		var meta = null;
		if (/\.epub$/i.test(file.name)) {
			file.arrayBuffer().then(function (buf) {
				if (String.fromCharCode.apply(null, new Uint8Array(buf, 0, Math.min(2, buf.byteLength))) !== "PK") throw new Error("not a zip file, so not an EPUB");
				return epubLoad(buf);
			}).then(function (ep) { meta = ep.meta; send(); }, function (e) { done(false, e.message || "couldn't read the file"); });
		} else if (/\.cbz$/i.test(file.name)) {
			// A CBR renamed to .cbz is still a RAR inside, which can't be opened here.
			file.slice(0, 4).arrayBuffer().then(function (buf) {
				var sig = String.fromCharCode.apply(null, new Uint8Array(buf));
				if (sig === "Rar!") return done(false, "this is a RAR (CBR) file inside; convert it to CBZ first");
				if (sig.slice(0, 2) !== "PK") return done(false, "not a zip file, so not a CBZ");
				send();
			}, function () { done(false, "couldn't read the file"); });
		} else send();
		function send() {
			if (file.size > 90 * 1024 * 1024) {
				sendInPieces(file, q, progress).then(added, function (e) { done(false, e.message); });
				return;
			}
			xhrSend("PUT", "/api/books?" + q, file, function (loaded) { progress(loaded); }).then(added, function (e) { done(false, e.message); });
		}
		function added(data) {
			var details = meta ? epubDetails(data.book, meta).catch(function () {}) : Promise.resolve();
			details.then(function () {
				done(true, data.replaced ? "replaced the file of “" + data.book.title + "”" : "");
				// A downloaded copy is the old file now: fetch the new one.
				if (data.replaced && bookDownloads[data.book.id]) {
					forgetBookDownload(data.book.id);
					saveBookDownloads();
					downloadBook(data.book);
				}
			});
		}
	});
}
// XHR rather than fetch, for an upload progress readout on big files.
// -> the JSON reply; an error says what the Worker said.
function xhrSend(method, path, body, onProgress) {
	return new Promise(function (resolve, reject) {
		var xhr = new XMLHttpRequest();
		xhr.open(method, path);
		xhr.setRequestHeader("Authorization", "Bearer " + token());
		if (onProgress) xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded); };
		xhr.onload = function () {
			if (xhr.status === 401) { store("readerToken", null); askToken("That token didn't work."); return reject(new Error("unauthorized")); }
			var data = {};
			try { data = JSON.parse(xhr.responseText); } catch (e) {}
			if (xhr.status >= 300) return reject(new Error(data.error || "HTTP " + xhr.status));
			resolve(data);
		};
		xhr.onerror = function () { reject(new Error("network error")); };
		xhr.send(body);
	});
}
// A file over 90 MB goes up in pieces (a Worker takes at most 100 MB a
// request), each tried again twice if the connection drops.
async function sendInPieces(file, q, progress) {
	var up = await xhrSend("POST", "/api/books/uploads?" + q, null);
	var ref = "key=" + encodeURIComponent(up.key) + "&upload_id=" + encodeURIComponent(up.upload_id);
	var parts = [], size = up.part_size;
	try {
		for (var n = 1, at = 0; at < file.size; n++, at += size) {
			var piece = file.slice(at, Math.min(at + size, file.size)), base = at, res = null;
			for (var tries = 0; !res; tries++) {
				try {
					res = await xhrSend("PUT", "/api/books/uploads?" + ref + "&n=" + n, piece, function (loaded) { progress(base + loaded); });
				} catch (e) {
					if (tries >= 2 || e.message === "unauthorized") throw e;
				}
			}
			parts.push(res.part);
		}
		return await xhrSend("POST", "/api/books/uploads/done?" + q + "&" + ref, JSON.stringify({ parts: parts }));
	} catch (e) {
		api("/api/books/uploads?" + ref, { method: "DELETE" }).catch(function () {});
		throw e;
	}
}

// ---------- book reader (shared)

function headerBottom() { return $("top").getBoundingClientRect().bottom; }
async function openBook(id) {
	showView("book");
	window.scrollTo(0, 0);
	var body = $("bookBody");
	body.className = "";
	body.textContent = "";
	body.append(h("p", "loading", "Loading…"));
	if (!state.books) await loadBooks();
	var book = (state.books || []).filter(function (b) { return b.id === id; })[0];
	if (!book) {
		toast(state.libOffline ? "You're offline, and that book isn't downloaded on this device." : "That book isn't in the library any more.");
		location.replace("#/library");
		return;
	}
	if (isAudiobook(book)) { location.replace("#/record/" + id); return; }
	book.last_opened_at = Date.now(); // the shelf's order, until the Library is next fetched
	var sess = session = { id: id, book: book, alive: true, cleanup: [], dirty: false, start: parsePos(book.position) || {} };
	$("heading").textContent = book.title;
	document.title = book.title + " — Reader";
	setProgress("");
	zoomable(book.type === "pdf" || book.type === "cbz");
	try {
		if (book.type === "pdf") await openPdf(sess, parsePos(book.position) || {});
		else if (book.type === "cbz") await openCbz(sess, parsePos(book.position) || {});
		else if (book.type === "epub") await openEpub(sess, parsePos(book.position) || {});
		else await openTxt(sess, parsePos(book.position) || {});
		if (sess.alive) updateMarks(sess);
		if (book.type === "cbz") comicDetails(sess);
	} catch (e) {
		if (!sess.alive) return;
		body.textContent = "";
		body.append(h("p", "loading err", e.message));
	}
}
// A comic uploaded before ComicInfo.xml was read: fill its details in now
// (once per visit, since most comics have none).
var comicTried = {};
function comicDetails(sess) {
	var b = sess.book;
	if (b.series || b.volume || comicTried[b.id] || state.libOffline) return;
	comicTried[b.id] = true;
	apiJSON("/api/books/" + b.id, { method: "PATCH", json: { reread: true } }).then(function (d) {
		Object.assign(b, d.book);
		keepBookDetails(b);
		if (sess.alive) $("heading").textContent = b.title;
	}, function () {});
}
function closeBook() {
	var s = session;
	if (!s) return;
	session = null;
	s.alive = false;
	zoomable(false);
	flushPosition(s);
	s.cleanup.forEach(function (fn) { try { fn(); } catch (e) {} });
	showFind(false);
	$("findQ").value = "";
	$("findItems").textContent = "";
	findStatus("");
	show($("farPill"), false);
	$("bookBody").textContent = "";
	document.title = "Reader";
}
// mark: a new bookmark ({} style spot), null to remove it, or left out to
// keep the one there is.
function savePosition(sess, pos, mark) {
	var prev = here(sess), far = farOf(prev);
	if (!far || (pos.f > far.f && pos.f - far.f <= 3 * screenF(sess))) far = spot(pos);
	if (mark === undefined) mark = prev.mark;
	sess.pos = Object.assign(pos, { at: Date.now(), far: far }, mark ? { mark: mark } : {});
	sess.dirty = true;
	setProgress(posLabel(sess, pos));
	clearTimeout(sess.timer);
	sess.timer = setTimeout(function () { flushPosition(sess); }, 800);
	updateMarks(sess);
}
function flushPosition(sess, keepalive) {
	clearTimeout(sess.timer);
	if (!sess.dirty) return;
	sess.dirty = false;
	setPosition(sess.book, JSON.stringify(sess.pos), keepalive);
}

// ---------- bookmark and furthest place
// A saved place also carries two spots: far, the furthest the book's been
// read, and mark, a bookmark set by hand. Both live in the same position
// string, so they sync and work offline like the place itself. A spot is a
// place without its time: {f} for text, {page, pf?, pages, f} for PDFs and
// comics. far only moves on by reading on from it: a jump well past it (a
// fling of the scrollbar, a chapter picked from Contents) leaves it where it
// was, and scrolling back never moves it.

function here(sess) { return sess.pos || sess.start || {}; }
function spot(p) {
	var s = { f: p.f || 0 };
	if (p.page) { s.page = p.page; s.pages = p.pages; if (p.pf != null) s.pf = p.pf; }
	return s;
}
// A place saved before there was a far is its own furthest.
function farOf(p) { return p.far || (p.f != null ? spot(p) : null); }
// About one screen of the book, as a fraction of it (a comic: one page).
function screenF(sess) {
	if (sess.cbz && !sess.cbz.scroll) return 1 / sess.cbz.n;
	return window.innerHeight / Math.max(document.documentElement.scrollHeight, window.innerHeight);
}
function spotName(s) { return s.page ? "page " + s.page : Math.round(s.f * 100) + "%"; }
// The bar's readout: how far through, then the page. A PDF or comic has real
// pages; a .txt or .epub's page is its share of the Record's page count, or
// without one of the text's length at CHARS_PER_PAGE, so its count gets a "~".
function posLabel(sess, s) {
	var f = s.f || 0, pct = Math.round(f * 100) + "%";
	if (s.page) return pct + " · p. " + s.page + " of " + s.pages;
	var n = sess.book.pages || (sess.txt ? Math.max(1, Math.round(sess.txt.total / CHARS_PER_PAGE)) : 0);
	return n ? pct + " · p. " + clamp(Math.ceil(f * n), 1, n) + " of ~" + n : pct;
}
// The percentage and the page in spans of their own, so a phone can stack them.
function setProgress(label) {
	var el = $("progress"), at = label.indexOf(" · ");
	el.textContent = "";
	if (at < 0) { el.textContent = label; return; }
	el.append(h("span", "pct", label.slice(0, at)), h("span", "pg", label.slice(at + 3)));
}
// The bookmark button's state, and "Back to furthest" while the place is
// more than a screen and a half behind it.
function updateMarks(sess) {
	if (session !== sess) return;
	var c = here(sess), far = farOf(c);
	$("markBtn").classList.toggle("on", !!c.mark);
	$("markBtn").setAttribute("aria-pressed", String(!!c.mark));
	$("markBtn").setAttribute("aria-label", c.mark ? "Bookmarked (" + spotName(c.mark) + "). Tap to move it here" : "Bookmark this place");
	var behind = !!far && far.f - (c.f || 0) > (sess.cbz && !sess.cbz.scroll ? 0.5 : 1.5) * screenF(sess);
	if (!behind) sess.farHidden = false;
	if (behind) $("farGo").textContent = "Back to furthest · " + spotName(far);
	show($("farPill"), behind && !sess.farHidden);
}
// Take the open book to a spot, and save it as the place.
function goToSpot(sess, s) {
	if (!sess || !sess.jump || !s) return;
	sess.farHidden = false;
	sess.jump(s);
	savePosition(sess, spot(s));
}
// Bookmark where the reader is; tapped again on the same spot, take it away.
function toggleMark(sess) {
	if (!sess || !sess.jump) return;
	if (sess.track && !sess.restoring) sess.track();
	var c = here(sess), s = spot(c);
	if (c.mark && Math.abs(c.mark.f - s.f) < 1e-4 && c.mark.page === s.page) {
		savePosition(sess, spot(c), null);
		toast("Bookmark removed.");
		return;
	}
	savePosition(sess, spot(c), s);
	toast("Bookmarked at " + spotName(s) + ". Go back to it from ⋯.");
}
// Reaching the end marks a book finished: the last line of a .txt or .epub, the
// bottom edge of a PDF's last page, or a comic's last page, brought onto the screen by the reader
// (not by restoring a saved place). At most once per opening, and not again
// after "Mark unfinished" in the same opening. Scrolling back never unmarks.
function checkEnd(sess, last) {
	if (!last || last.getBoundingClientRect().bottom > window.innerHeight) return;
	reachedEnd(sess);
}
function reachedEnd(sess) {
	if (sess.book.finished_at || sess.noAuto) return;
	sess.noAuto = true;
	setFinished(sess.book, true).then(function () { if (sess.alive) finishedToast(sess.book); }, fail);
}
// The next volume not yet finished after b in its series, if there is one.
function nextInSeries(b) {
	if (!b.series) return null;
	var k = fold(b.series), all = sortBooks((state.books || []).filter(function (x) { return fold(x.series) === k && !isAudiobook(x); }), "series");
	var at = all.map(function (x) { return x.id; }).indexOf(b.id);
	return all.slice(at + 1).filter(function (x) { return !x.finished_at; })[0] || null;
}
function finishedToast(b) {
	var next = nextInSeries(b);
	toast("Marked as finished.", next && {
		label: "Up next: " + (next.volume ? "Vol. " + next.volume : next.title),
		fn: function () { location.hash = "#/book/" + next.id; }
	});
}
function renderBookMenu() {
	var b = session && session.book;
	if (!b) return;
	var n = session.hl ? session.hl.list.length : 0;
	var c = here(session), far = farOf(c), canGo = !!session.jump;
	show($("bmToMark"), canGo && !!c.mark);
	show($("bmUnmark"), canGo && !!c.mark);
	show($("bmToFar"), canGo && !!far && far.f > 0);
	if (c.mark) $("bmToMark").textContent = "Go to bookmark · " + spotName(c.mark);
	if (far) $("bmToFar").textContent = "Go to furthest · " + spotName(far);
	show($("bmContents"), b.type === "epub" && !!(session.epub && session.epub.toc.length));
	show($("bmHighlights"), b.type === "txt" || b.type === "epub");
	show($("bmFind"), b.type === "txt" || b.type === "epub" || b.type === "pdf");
	$("bmHighlights").textContent = n ? "Highlights (" + n + ")" : "Highlights";
	show($("bmLayout"), b.type === "cbz" && !!session.cbz);
	[].forEach.call($("bmLayout").children, function (x) { x.setAttribute("aria-pressed", String(x.dataset.layout === (b.layout || "pages"))); });
	show($("bmGuided"), b.type === "cbz" && !(session.cbz && session.cbz.scroll));
	$("bmGuided").textContent = "Guided view: " + (guidedOn() ? "on" : "off");
	$("bmGuided").setAttribute("aria-pressed", String(guidedOn()));
	$("bmFinish").textContent = b.finished_at ? "Mark unfinished" : "Mark finished";
	var p = bookDl[b.id];
	$("bmDownload").textContent = p ? "Downloading… " + dlLabel(p) : bookDownloads[b.id] ? "Remove download" : "Download for offline";
	show($("bmDownload"), !!window.caches);
	show($("bmDelete"), !state.libOffline);
	$("bmNote").textContent = b.finished_at ? "Finished " + longDate(b.finished_at) + "."
		: "Marked finished by itself when you reach the end.";
}
// Start over in the open book: back to the top, and the saved place cleared.
async function restartBook() {
	var sess = session;
	openBookMenu(false);
	if (!sess || !confirmStartOver(sess.book)) return;
	clearTimeout(sess.timer);
	sess.dirty = false;
	sess.restoring = true;
	window.scrollTo(0, 0);
	setTimeout(function () { sess.restoring = false; }, 300);
	if (sess.cbz) sess.cbz.go(1, false);
	setProgress(posLabel(sess, sess.pdf ? { page: 1, pages: sess.pdf.n } : sess.cbz ? { page: 1, pages: sess.cbz.n, f: 1 / sess.cbz.n } : {}));
	try { await resetPosition(sess.book, here(sess).mark || null); } catch (e) { fail(e); }
	sess.pos = null;
	sess.start = parsePos(sess.book.position) || {};
	updateMarks(sess);
}
function onScrollFrame(fn) {
	var queued = false;
	return function () {
		if (queued) return;
		queued = true;
		requestAnimationFrame(function () { queued = false; fn(); });
	};
}
// Jump to a saved spot, then re-aim for a few frames while blocks near it
// get laid out for real and change height. Stops the moment the reader
// scrolls on their own, and saves where they went.
function aim(sess, targetY, onUserScroll) {
	var tries = 0, lastSet = null;
	sess.restoring = true;
	function finish(userMoved) {
		sess.restoring = false;
		if (userMoved && sess.alive) onUserScroll();
	}
	(function step() {
		if (!sess.alive) return;
		if (lastSet != null && Math.abs(window.scrollY - lastSet) > 2) return finish(true);
		var y = Math.max(0, Math.round(targetY()));
		if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
		lastSet = window.scrollY;
		if (++tries < 8) requestAnimationFrame(step); else finish(false);
	})();
}
function listen(sess, target, type, fn, opts) {
	target.addEventListener(type, fn, opts);
	sess.cleanup.push(function () { target.removeEventListener(type, fn, opts); });
}

// ---------- .txt reader
// Paragraphs are built in slices so a multi-MB book never freezes the page,
// and grouped into blocks with content-visibility:auto so only the blocks
// near the screen are laid out. Position is a fraction of the *text*, not
// of the scroll height, so it survives font-size and device changes.

function decodeText(buf) {
	var b = new Uint8Array(buf);
	if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b);
	if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b);
	try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch (e) { return new TextDecoder("windows-1252").decode(b); }
}
// Blank lines split paragraphs; single newlines stay as line breaks -- unless
// the whole file is hard-wrapped at ~70 columns (Project Gutenberg style),
// where those newlines are just wrapping and get joined back up.
function splitParagraphs(text) {
	var paras = text.replace(/\r\n?/g, "\n").split(/\n[ \t ]*\n\s*/).map(function (p) { return p.replace(/\s+$/, "").replace(/^\n+/, ""); })
		.filter(function (p) { return p.trim(); });
	var lines = 0, wrapped = 0;
	for (var i = 0; i < paras.length && lines < 5000; i++) {
		var ls = paras[i].split("\n");
		for (var j = 0; j < ls.length - 1; j++) { lines++; var L = ls[j].trim().length; if (L >= 45 && L <= 90) wrapped++; }
	}
	if (lines >= 20 && wrapped / lines > 0.7) paras = paras.map(function (p) { return p.replace(/[ \t]*\n[ \t]*/g, " "); });
	return paras;
}
async function openTxt(sess, pos) {
	var res = await bookFileRes(sess.book);
	var text = decodeText(await res.arrayBuffer());
	if (!sess.alive) return;
	// A YAML header (title, author ...) is for the Library, not for reading.
	var fm = FRONT_MATTER.exec(text);
	if (fm) {
		text = text.slice(fm[0].length);
		var b = sess.book;
		// Uploaded before headers were read: fill the details in now.
		if (!b.author && !b.series && !b.volume && !(b.tags || []).length && !state.libOffline)
			apiJSON("/api/books/" + b.id, { method: "PATCH", json: { reread: true } }).then(function (d) {
				Object.assign(b, d.book);
				keepBookDetails(b);
				if (sess.alive) { $("heading").textContent = b.title; loadBookTags().catch(function () {}); }
			}, function () {});
	}
	var paras = splitParagraphs(text), starts = new Array(paras.length), total = 0;
	for (var i = 0; i < paras.length; i++) { starts[i] = total; total += paras[i].length + 1; }
	var body = $("bookBody");
	body.textContent = "";
	body.className = "txt";
	var chunks = [];
	for (var c = 0; c < paras.length; c += CHUNK) {
		var div = h("div", "chunk");
		for (var k = c; k < Math.min(c + CHUNK, paras.length); k++) div.appendChild(h("p", "", paras[k]));
		chunks.push(div);
		body.appendChild(div);
		if (chunks.length % 40 === 0) { await pause(); if (!sess.alive) return; }
	}
	if (!paras.length) body.append(h("p", "muted", "This file is empty."));
	startText(sess, { paras: paras, starts: starts, total: Math.max(total, 1), chunks: chunks }, pos);
}
// Reading a .txt or an .epub, once its blocks are on the page: position
// tracking, highlights, and back to the saved place.
function startText(sess, t, pos) {
	var chunks = t.chunks;
	sess.txt = t;
	estimateChunks(t);
	sess.capture = function () { return txtFraction(t); };
	sess.relayout = function (f) { estimateChunks(t); restoreTxt(sess, f); };
	var track = function () {
		if (sess.restoring || !t.chunks.length) return;
		var f = txtFraction(t);
		savePosition(sess, { f: Math.round(f * 1e5) / 1e5 });
		// An EPUB's notes after its end don't count (endIdx), and nor does a
		// jump by link, until the reader scrolls on from where it landed.
		if (t.endIdx != null && paraAt(t, f * t.total) > t.endIdx) return;
		if (sess.jumpedTo != null && (sess.jumpedTo < 0 || Math.abs(window.scrollY - sess.jumpedTo) < 40)) return;
		sess.jumpedTo = null;
		checkEnd(sess, t.endIdx != null ? paraEl(t, t.endIdx) : chunks[chunks.length - 1].lastElementChild);
	};
	sess.track = track;
	sess.jump = function (s) { if (s.f > 0) restoreTxt(sess, s.f); else window.scrollTo(0, 0); };
	hlStart(sess);
	restoreTxt(sess, pos.f || 0);
	listen(sess, window, "scroll", onScrollFrame(track), { passive: true });
	listen(sess, window, "resize", onScrollFrame(function () { estimateChunks(t); }));
	setProgress(posLabel(sess, { f: pos.f }));
}
// Placeholder height for blocks that haven't been laid out yet, from the
// text length and the current font/width, so the scrollbar stays honest.
function estimateChunks(t) {
	if (!t.chunks.length) return;
	var cs = getComputedStyle(t.chunks[0].parentNode);
	var size = parseFloat(cs.fontSize) || 19, line = size * 1.65;
	var width = t.chunks[0].parentNode.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
	var perLine = Math.max(10, Math.floor(width / (size * 0.47)));
	t.chunks.forEach(function (div, n) {
		var hgt = 0;
		for (var i = n * CHUNK; i < Math.min((n + 1) * CHUNK, t.paras.length); i++) {
			var p = t.paras[i], rows = 0, parts = p.split("\n");
			for (var j = 0; j < parts.length; j++) rows += Math.max(1, Math.ceil(parts[j].length / perLine));
			hgt += rows * line + size * 0.9;
		}
		div.style.containIntrinsicSize = "auto " + Math.round(hgt) + "px";
	});
}
function txtFraction(t) {
	var line = headerBottom() + 1, lo = 0, hi = t.chunks.length - 1;
	while (lo < hi) {
		var mid = (lo + hi + 1) >> 1;
		if (t.chunks[mid].getBoundingClientRect().top <= line) lo = mid; else hi = mid - 1;
	}
	var ps = t.chunks[lo].children, k = ps.length - 1;
	for (var i = 0; i < ps.length; i++) if (ps[i].getBoundingClientRect().bottom > line) { k = i; break; }
	var r = ps[k].getBoundingClientRect(), idx = lo * CHUNK + k;
	var within = r.height > 0 ? clamp((line - r.top) / r.height, 0, 1) : 0;
	return clamp((t.starts[idx] + within * t.paras[idx].length) / t.total, 0, 1);
}
function restoreTxt(sess, f) {
	var t = sess.txt;
	if (!t || !t.paras.length || !(f > 0)) return;
	var target = f * t.total, lo = 0, hi = t.paras.length - 1;
	while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (t.starts[mid] <= target) lo = mid; else hi = mid - 1; }
	var within = t.paras[lo].length ? clamp((target - t.starts[lo]) / t.paras[lo].length, 0, 1) : 0;
	var p = t.chunks[Math.floor(lo / CHUNK)].children[lo % CHUNK];
	aim(sess, function () {
		var r = p.getBoundingClientRect();
		return window.scrollY + r.top + within * r.height - headerBottom();
	}, sess.track);
}

// ---------- highlights and notes (.txt and .epub books)
// Select some text and a bar at the bottom offers Highlight or Add note; tap
// a highlight to see, change or delete its note. Each one is kept by its
// character positions in the text (after any YAML header) plus the words
// themselves, so if a re-uploaded file moved them the words are looked for
// again. The book's highlights are kept on this device too, so they show
// offline; ones made or changed offline wait in hlPending and go up when the
// book is next opened with a connection.

var hlPending = readJSON("readerHlPending") || [];
function hlKey(id) { return "readerHl:" + id; }
function saveHlPending() { store("readerHlPending", hlPending.length ? JSON.stringify(hlPending) : null); }
function cacheHl(sess) { store(hlKey(sess.id), JSON.stringify(sess.hl.list)); }
function hlSorted(list) { return list.slice().sort(function (a, b) { return a.start_pos - b.start_pos || a.id - b.id; }); }
function fullText(t) { return t.full || (t.full = t.paras.join("\n")); }
function paraAt(t, pos) {
	var lo = 0, hi = t.paras.length - 1;
	while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (t.starts[mid] <= pos) lo = mid; else hi = mid - 1; }
	return lo;
}
function paraEl(t, i) { return t.chunks[Math.floor(i / CHUNK)].children[i % CHUNK]; }

async function hlStart(sess) {
	sess.hl = { list: readJSON(hlKey(sess.id)) || [], marked: [] };
	hlRender(sess);
	hlWire(sess);
	if (state.libOffline) return;
	try {
		await flushHl();
		var data = await apiJSON("/api/books/" + sess.id + "/highlights");
		if (!sess.alive) return;
		// Ones still waiting to go up (offline edits that failed) stay as they are here.
		var waiting = hlPending.filter(function (op) { return op.book === sess.id; }).map(function (op) { return op.id; });
		var mine = sess.hl.list.filter(function (x) { return waiting.indexOf(x.id) >= 0; });
		sess.hl.list = data.highlights.filter(function (x) { return waiting.indexOf(x.id) < 0; }).concat(mine);
		cacheHl(sess);
		hlRender(sess);
	} catch (e) { if (e.message === UNAUTH) return; }
}
// Where each highlight is now: its saved spot if the words are still there,
// else the nearest place the words turn up (saved for next time), else
// nowhere (listed, but not shown in the text).
function hlLocate(sess, x) {
	var t = sess.txt, full = fullText(t);
	x.missing = false;
	if (full.slice(x.start_pos, x.end_pos) === x.text) return true;
	var before = full.lastIndexOf(x.text, x.start_pos), after = full.indexOf(x.text, x.start_pos);
	var at = before < 0 ? after : after < 0 ? before : x.start_pos - before <= after - x.start_pos ? before : after;
	if (at < 0) { x.missing = true; return false; }
	x.start_pos = at;
	x.end_pos = at + x.text.length;
	if (x.id > 0) api("/api/highlights/" + x.id, { method: "PATCH", json: { start_pos: x.start_pos, end_pos: x.end_pos } }).catch(function () {});
	cacheHl(sess);
	return true;
}
// Rebuild the paragraphs that carry highlights (and the ones that did).
function hlRender(sess) {
	var t = sess.txt, hl = sess.hl;
	if (!t || !hl) return;
	var byPara = {};
	hlSorted(hl.list).forEach(function (x) {
		if (!hlLocate(sess, x)) return;
		for (var i = paraAt(t, x.start_pos); i < t.paras.length && t.starts[i] < x.end_pos; i++) (byPara[i] = byPara[i] || []).push(x);
	});
	var redo = hl.marked.concat(Object.keys(byPara).map(Number));
	hl.marked = Object.keys(byPara).map(Number);
	redo.forEach(function (i) { hlPara(t, i, byPara[i] || []); });
}
function hlPara(t, i, marks) {
	var p = paraEl(t, i), text = t.paras[i], base = t.starts[i];
	if (!p) return;
	if (t.rich) return hlRich(p, hlPieces(text, base, marks));
	p.textContent = "";
	if (!marks.length) { p.textContent = text; return; }
	hlPieces(text, base, marks).forEach(function (s) {
		var piece = text.slice(s.a, s.b);
		if (!s.on) { p.append(piece); return; }
		p.append(hlMark(s.on, piece));
	});
}
// A paragraph's text cut where highlights start and end: [{a, b, on}], on
// being the highlight over that piece (or null).
function hlPieces(text, base, marks) {
	var cuts = [0, text.length], out = [];
	marks.forEach(function (x) { cuts.push(clamp(x.start_pos - base, 0, text.length), clamp(x.end_pos - base, 0, text.length)); });
	cuts = cuts.filter(function (c, k) { return cuts.indexOf(c) === k; }).sort(function (a, b) { return a - b; });
	for (var k = 0; k < cuts.length - 1; k++) {
		var a = cuts[k], b = cuts[k + 1], on = null;
		marks.forEach(function (x) { if (x.start_pos - base <= a && x.end_pos - base >= b) on = x; });
		out.push({ a: a, b: b, on: on });
	}
	return out;
}
function hlMark(x, content) {
	var m = h("mark", "hl" + (x.note ? " noted" : ""));
	m.dataset.h = x.id;
	if (content) m.append(content);
	return m;
}
// An EPUB block keeps its own markup (italics, links, images), so its marks
// go around the bits of text inside it instead of rebuilding it.
function hlRich(p, pieces) {
	p.querySelectorAll("mark.hl").forEach(function (m) { m.replaceWith.apply(m, [].slice.call(m.childNodes)); });
	p.normalize();
	var on = pieces.filter(function (s) { return s.on; });
	if (!on.length) return;
	var walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT), nodes = [], n, at = 0;
	while ((n = walk.nextNode())) { nodes.push({ n: n, a: at }); at += n.data.length; }
	nodes.forEach(function (o) {
		var len = o.n.data.length;
		// Last piece first, so splitting leaves the earlier offsets as they were.
		for (var k = on.length - 1; k >= 0; k--) {
			var a = Math.max(on[k].a - o.a, 0), b = Math.min(on[k].b - o.a, len);
			if (b <= a) continue;
			if (b < o.n.data.length) o.n.splitText(b);
			var mid = a > 0 ? o.n.splitText(a) : o.n;
			mid.parentNode.insertBefore(hlMark(on[k].on, ""), mid).append(mid);
		}
	});
}

// A point in the selection as a position in the text.
function hlPoint(t, node, offset) {
	var el = node.nodeType === 1 ? node : node.parentNode;
	if (el.classList && el.classList.contains("chunk")) {
		var kids = el.children;
		if (offset < kids.length) { node = kids[offset]; offset = 0; el = node; }
		else { node = kids[kids.length - 1]; offset = node.childNodes.length; el = node; }
	}
	// The paragraph (an EPUB: the block) it's in, a child of a chunk.
	var p = el;
	while (p && p.parentNode && !(p.parentNode.classList && p.parentNode.classList.contains("chunk"))) p = p.parentNode;
	if (!p || !p.parentNode) return null;
	var ci = t.chunks.indexOf(p.parentNode), k = [].indexOf.call(p.parentNode.children, p);
	if (ci < 0 || k < 0) return null;
	var r = document.createRange();
	r.setStart(p, 0);
	r.setEnd(node, offset);
	return t.starts[ci * CHUNK + k] + r.toString().length;
}
function hlSelection(sess) {
	var t = sess.txt, sel = window.getSelection();
	if (!t || !sel || !sel.rangeCount || sel.isCollapsed) return null;
	var r = sel.getRangeAt(0), body = $("bookBody");
	if (!body.contains(r.startContainer) || !body.contains(r.endContainer)) return null;
	var a = hlPoint(t, r.startContainer, r.startOffset), b = hlPoint(t, r.endContainer, r.endOffset);
	if (a == null || b == null || b <= a) return null;
	var full = fullText(t);
	while (a < b && /\s/.test(full[a])) a++;
	while (b > a && /\s/.test(full[b - 1])) b--;
	if (b <= a || b - a > 20000) return null;
	return { start_pos: a, end_pos: b, text: full.slice(a, b) };
}
function hlWire(sess) {
	var bar = $("hlBar"), hideTimer = null;
	sess.cleanup.push(function () { show(bar, false); showHlPop(false); showHlList(false); });
	listen(sess, document, "selectionchange", function () {
		var s = hlSelection(sess);
		if (s) { clearTimeout(hideTimer); sess.hl.sel = s; show(bar, true); return; }
		// Tapping the bar can clear the selection a moment before the tap lands.
		clearTimeout(hideTimer);
		hideTimer = setTimeout(function () { sess.hl.sel = null; show(bar, false); }, 400);
	});
	listen(sess, $("bookBody"), "click", function (e) {
		var m = e.target.closest && e.target.closest("mark.hl");
		var sel = window.getSelection();
		if (!m || (sel && !sel.isCollapsed)) return;
		var x = hlFind(sess, Number(m.dataset.h));
		if (!x) return;
		e.stopPropagation();
		openHlPop(sess, x, false);
	});
}
function hlFind(sess, id) { return sess.hl.list.filter(function (x) { return x.id === id; })[0] || null; }
// The bar's buttons keep the selection (a tap would otherwise clear it).
["hlAdd", "hlNote"].forEach(function (id) {
	$(id).addEventListener("pointerdown", function (e) { e.preventDefault(); });
	$(id).addEventListener("mousedown", function (e) { e.preventDefault(); });
});
$("hlAdd").addEventListener("click", function (e) { e.stopPropagation(); hlCreate(false); });
$("hlNote").addEventListener("click", function (e) { e.stopPropagation(); hlCreate(true); });
function hlCreate(withNote) {
	var sess = session;
	if (!sess || !sess.hl || !sess.hl.sel) return;
	var s = sess.hl.sel, x = { id: -Date.now(), book_id: sess.id, start_pos: s.start_pos, end_pos: s.end_pos, text: s.text, note: null,
		created_at: Date.now(), updated_at: Date.now() };
	sess.hl.sel = null;
	var sel = window.getSelection();
	if (sel) sel.removeAllRanges();
	show($("hlBar"), false);
	sess.hl.list.push(x);
	cacheHl(sess);
	hlRender(sess);
	hlSend(sess, { op: "add", book: sess.id, id: x.id, start_pos: x.start_pos, end_pos: x.end_pos, text: x.text, note: null });
	if (withNote) openHlPop(sess, x, true);
}
// Send a change now; offline (or if it fails), keep it for later.
function hlSend(sess, op) {
	hlPending.push(op);
	saveHlPending();
	flushHl().then(function () { if (sess.alive) { cacheHl(sess); hlRender(sess); } }, function () {});
}
var hlFlushing = null;
function flushHl() {
	if (hlFlushing) return hlFlushing;
	var run = hlFlushing = (async function () {
		await pause();
		while (hlPending.length) {
			var op = hlPending[0];
			try {
				if (op.op === "add") {
					var d = await apiJSON("/api/books/" + op.book + "/highlights", { method: "POST",
						json: { start_pos: op.start_pos, end_pos: op.end_pos, text: op.text, note: op.note } });
					hlRenumber(op.book, op.id, d.highlight.id);
				} else if (op.id < 0) {
					// Its "add" was refused, so there's nothing to change.
				} else if (op.op === "note") {
					await apiJSON("/api/highlights/" + op.id, { method: "PATCH", json: { note: op.note } });
				} else if (op.op === "delete") {
					await apiJSON("/api/highlights/" + op.id, { method: "DELETE" }).catch(function (e) { if (!/No such/.test(e.message)) throw e; });
				}
			} catch (e) {
				if (e.message === UNAUTH || isOffline(e)) throw e;
				// Refused for good (the book's gone, say): drop it.
				toast("A highlight couldn't be saved: " + e.message);
			}
			hlPending.shift();
			saveHlPending();
		}
	})();
	run.then(done, done);
	function done() { if (hlFlushing === run) hlFlushing = null; }
	return run;
}
// A highlight made offline has a stand-in id until the server gives it one.
function hlRenumber(book, from, to) {
	hlPending.forEach(function (op) { if (op.book === book && op.id === from) op.id = to; });
	var list = session && session.id === book ? session.hl.list : readJSON(hlKey(book)) || [];
	list.forEach(function (x) { if (x.id === from) x.id = to; });
	if (session && session.id === book) { cacheHl(session); hlRender(session); } else store(hlKey(book), JSON.stringify(list));
}
window.addEventListener("online", function () { if (hlPending.length && token()) flushHl().catch(function () {}); });

// The panel for one highlight: its words, its note, Delete.
var hlPop = { x: null };
function showHlPop(on) { show($("hlPop"), on); if (!on) hlPop.x = null; }
function openHlPop(sess, x, focus) {
	showHlList(false);
	openBookMenu(false);
	hlPop.x = x;
	var q = x.text.length > 400 ? x.text.slice(0, 400) + "…" : x.text;
	$("hlQuote").textContent = q;
	$("hlNoteText").value = x.note || "";
	show($("hlPop"), true);
	if (focus) $("hlNoteText").focus();
}
$("hlSave").addEventListener("click", function () {
	var sess = session, x = hlPop.x;
	if (!sess || !x) return;
	var note = $("hlNoteText").value.trim() || null;
	showHlPop(false);
	if (note === (x.note || null)) return;
	x.note = note;
	x.updated_at = Date.now();
	cacheHl(sess);
	hlRender(sess);
	hlSend(sess, { op: "note", book: sess.id, id: x.id, note: note });
});
$("hlDelete").addEventListener("click", function () {
	var sess = session, x = hlPop.x;
	if (!sess || !x) return;
	if (x.note && !confirm("Delete this highlight and its note?")) return;
	showHlPop(false);
	hlRemove(sess, x);
});
$("hlClose").addEventListener("click", function () { showHlPop(false); });
function hlRemove(sess, x) {
	sess.hl.list = sess.hl.list.filter(function (y) { return y !== x; });
	cacheHl(sess);
	hlRender(sess);
	if (x.id < 0) {
		// Never went up: forget its waiting "add" and edits instead.
		hlPending = hlPending.filter(function (op) { return op.id !== x.id; });
		saveHlPending();
		return;
	}
	hlSend(sess, { op: "delete", book: sess.id, id: x.id });
}

// The list of a book's highlights, from the book menu: tap one to go there.
function showHlList(on) { show($("hlList"), on); }
function openHlList() {
	var sess = session;
	if (!sess || !sess.hl) return;
	openBookMenu(false);
	showHlPop(false);
	var ul = $("hlItems"), list = hlSorted(sess.hl.list);
	ul.textContent = "";
	list.forEach(function (x) {
		var li = h("li"), go = h("button", "hlgo");
		go.type = "button";
		go.append(h("span", "hlq", x.text));
		if (x.note) go.append(h("span", "hln", x.note));
		if (x.missing) go.append(h("span", "hlm", "Not found in this version of the file."));
		go.addEventListener("click", function () { showHlList(false); if (!x.missing) hlJump(sess, x); });
		li.append(go);
		ul.append(li);
	});
	$("hlEmpty").textContent = "No highlights yet. Select some text to add one.";
	show($("hlEmpty"), !list.length);
	show($("hlExport"), !!list.length);
	showHlList(true);
}
function hlJump(sess, x) {
	var t = sess.txt, i = paraAt(t, x.start_pos), p = paraEl(t, i);
	aim(sess, function () {
		var m = p.querySelector("mark[data-h='" + x.id + "']") || p;
		return window.scrollY + m.getBoundingClientRect().top - headerBottom() - window.innerHeight * 0.25;
	}, sess.track);
	setTimeout(function () { if (sess.alive && sess.track) sess.track(); }, 400);
}
// Markdown, for pasting into Obsidian (or anywhere): the words as quotes,
// notes under them.
function hlMarkdown(sess) {
	var b = sess.book, out = ["# " + b.title, ""];
	if (b.author) out.push("*" + b.author + "*", "");
	hlSorted(sess.hl.list).forEach(function (x) {
		out.push(x.text.split("\n").map(function (l) { return "> " + l; }).join("\n"), "");
		if (x.note) out.push(x.note, "");
		out.push("---", "");
	});
	return out.join("\n");
}
$("hlExport").addEventListener("click", async function () {
	var sess = session;
	if (!sess) return;
	var md = hlMarkdown(sess), name = (sess.book.title || "Highlights").replace(/[\\/:*?"<>|]+/g, " ").trim() + " highlights.md";
	var file = typeof File === "function" ? new File([md], name, { type: "text/markdown" }) : null;
	if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
		try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; }
	}
	var a = h("a");
	a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
	a.download = name;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
});
$("hlListClose").addEventListener("click", function () { showHlList(false); });
$("bmHighlights").addEventListener("click", function (e) { e.stopPropagation(); openHlList(); });
document.addEventListener("click", function (e) {
	if (!$("hlPop").hidden && !$("hlPop").contains(e.target)) showHlPop(false);
	if (!$("hlList").hidden && !$("hlList").contains(e.target)) showHlList(false);
});

// ---------- search in a book
// "Search in book" in the book menu: every place the words turn up in the
// open .txt, .epub or .pdf, ignoring case and accents, each with the text
// around it. Tap one to go there; in a .txt or .epub the words light up for
// a few seconds. A PDF's text is read a page at a time and kept for the
// next search. Comics have no text to search.

var FIND_SHOW = 300, FIND_COUNT = 5000, FIND_AROUND = 70;
var findRun = 0, findTimer = null, findLit = null;

// s folded for searching (fold(), whitespace as single spaces), with where
// in s each folded character came from.
function foldMap(s) {
	var out = [], from = [];
	for (var i = 0; i < s.length; i++) {
		var c = s.charCodeAt(i) < 128 ? s[i].toLowerCase() : fold(s[i]);
		for (var j = 0; j < c.length; j++) { out.push(/\s/.test(c[j]) ? " " : c[j]); from.push(i); }
	}
	return { s: out.join(""), from: from };
}
function findQuery(q) { return fold(q).replace(/\s+/g, " ").trim(); }
// Every place q turns up in a folded string, as [start, end) in the original.
function findIn(m, q, limit) {
	var hits = [];
	for (var k = m.s.indexOf(q); k >= 0 && hits.length < limit; k = m.s.indexOf(q, k + q.length))
		hits.push([m.from[k], m.from[k + q.length - 1] + 1]);
	return hits;
}
function findSnippet(text, a, b) {
	var from = Math.max(0, a - FIND_AROUND), to = Math.min(text.length, b + FIND_AROUND);
	if (from > 0) { var sp = text.indexOf(" ", from); if (sp > 0 && sp < a) from = sp + 1; }
	if (to < text.length) { var sp2 = text.lastIndexOf(" ", to); if (sp2 > b) to = sp2; }
	var q = h("span", "findq");
	q.append((from > 0 ? "…" : "") + text.slice(from, a).replace(/\s+/g, " "), h("mark", null, text.slice(a, b)),
		text.slice(b, to).replace(/\s+/g, " ") + (to < text.length ? "…" : ""));
	return q;
}
function openFind() {
	var sess = session;
	if (!sess) return;
	openBookMenu(false);
	show($("findList"), true);
	var q = $("findQ");
	q.focus();
	q.select();
	if (q.value.trim() && sess.findFor !== q.value) runFind();
}
function showFind(on) {
	show($("findList"), on);
	if (!on) findRun++;
}
function findStatus(text) {
	$("findStatus").textContent = text || "";
	show($("findStatus"), !!text);
}
async function runFind() {
	var sess = session, run = ++findRun, raw = $("findQ").value, q = findQuery(raw), ul = $("findItems");
	if (!sess) return;
	ul.textContent = "";
	sess.findFor = raw;
	if (!q) { findStatus(""); return; }
	var total = 0, shown = 0;
	function add(snippet, where, go) {
		total++;
		if (shown >= FIND_SHOW) return;
		shown++;
		var li = h("li"), btn = h("button", "hlgo");
		btn.type = "button";
		btn.append(snippet, h("span", "findwhere", where));
		btn.addEventListener("click", function () { showFind(false); go(); });
		li.append(btn);
		ul.append(li);
	}
	function done() {
		findStatus(!total ? "Nothing found for “" + raw.trim() + "”."
			: (total >= FIND_COUNT ? "At least " + FIND_COUNT.toLocaleString() + " places" : total.toLocaleString() + (total === 1 ? " place" : " places"))
				+ (total > shown ? ", the first " + shown + " listed." : "."));
	}
	if (sess.txt) {
		var t = sess.txt, m = t.folded || (t.folded = foldMap(fullText(t)));
		findIn(m, q, FIND_COUNT).forEach(function (hit) {
			var i = paraAt(t, hit[0]), base = t.starts[i];
			add(findSnippet(t.paras[i], hit[0] - base, hit[1] - base), Math.round(hit[0] / t.total * 100) + "%",
				function () { findJump(sess, hit[0], hit[1]); });
		});
		return done();
	}
	if (sess.pdf) {
		var pdf = sess.pdf;
		pdf.texts = pdf.texts || [];
		for (var n = 1; n <= pdf.n && total < FIND_COUNT; n++) {
			if (!pdf.texts[n]) {
				findStatus("Searching… page " + n + " of " + pdf.n);
				try { pdf.texts[n] = await pdfPageText(pdf, n); } catch (e) { pdf.texts[n] = { text: "", items: [], m: foldMap("") }; }
				if (run !== findRun || !sess.alive) return;
			}
			var pt = pdf.texts[n];
			findIn(pt.m, q, FIND_COUNT - total).forEach(function (hit) {
				var at = pdfItemAt(pt, hit[0]), page = n;
				add(findSnippet(pt.text, hit[0], hit[1]), "Page " + page, function () { pdfFindJump(sess, page, at ? at.y : 0); });
			});
		}
		if (!total && pdf.texts.slice(1).every(function (x) { return !x.text.trim(); }))
			return findStatus("This PDF has no text to search: its pages are images.");
		return done();
	}
	findStatus("This book has no text to search.");
}
// A PDF page's text, with where each piece starts and how far down the page
// it sits (0 top, 1 bottom).
async function pdfPageText(pdf, n) {
	var page = await pdf.doc.getPage(n), vp = page.getViewport({ scale: 1 }), tc = await page.getTextContent();
	var text = "", items = [];
	tc.items.forEach(function (it) {
		if (typeof it.str !== "string") return;
		var y = it.transform ? vp.convertToViewportPoint(it.transform[4], it.transform[5])[1] / vp.height : 0;
		items.push({ at: text.length, y: clamp(y, 0, 1) });
		text += it.str + (it.hasEOL ? "\n" : "");
	});
	return { text: text, items: items, m: foldMap(text) };
}
function pdfItemAt(pt, pos) {
	var lo = 0, hi = pt.items.length - 1;
	if (hi < 0) return null;
	while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (pt.items[mid].at <= pos) lo = mid; else hi = mid - 1; }
	return pt.items[lo];
}
function pdfFindJump(sess, n, y) {
	var div = sess.pdf.pages[n - 1];
	aim(sess, function () {
		var r = div.getBoundingClientRect();
		return window.scrollY + r.top + y * r.height - headerBottom() - window.innerHeight * 0.3;
	}, sess.track);
	// Save where it landed, but a jump to the last page isn't reading to the end.
	setTimeout(function () {
		if (!sess.alive || sess.restoring) return;
		sess.quietEnd = true;
		sess.track();
		sess.quietEnd = false;
	}, 400);
}
// The words [a, b) of the text as a Range inside paragraph p, which starts at base.
function findRange(p, a, b) {
	var walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT), n, at = 0, r = document.createRange(), started = false;
	while ((n = walk.nextNode())) {
		var len = n.data.length;
		if (!started && a < at + len) { r.setStart(n, a - at); started = true; }
		if (started && b <= at + len) { r.setEnd(n, b - at); return r; }
		at += len;
	}
	return null;
}
function findJump(sess, a, b) {
	var t = sess.txt, i = paraAt(t, a), p = paraEl(t, i), base = t.starts[i];
	aim(sess, function () {
		var r = findRange(p, a - base, b - base), box = r && r.getClientRects()[0];
		var top = box && box.height ? box.top : p.getBoundingClientRect().top;
		return window.scrollY + top - headerBottom() - window.innerHeight * 0.3;
	}, sess.track);
	sess.jumpedTo = -1;
	setTimeout(function () {
		if (!sess.alive) return;
		if (sess.track) { sess.jumpedTo = window.scrollY; sess.track(); }
		findLight(findRange(p, a - base, b - base));
	}, 400);
}
// Light up the found words for a few seconds (the CSS Custom Highlight API,
// so the page's own markup is left alone; where that's missing, nothing lights up).
function findLight(range) {
	if (!range || !window.CSS || !CSS.highlights || typeof Highlight !== "function") return;
	clearTimeout(findLit);
	CSS.highlights.set("find", new Highlight(range));
	findLit = setTimeout(function () { CSS.highlights.delete("find"); }, 4000);
}
$("bmFind").addEventListener("click", function (e) { e.stopPropagation(); openFind(); });
$("findForm").addEventListener("submit", function (e) { e.preventDefault(); clearTimeout(findTimer); runFind(); });
$("findQ").addEventListener("input", function () {
	clearTimeout(findTimer);
	findTimer = setTimeout(runFind, session && session.pdf ? 600 : 250);
});
$("findClose").addEventListener("click", function () { showFind(false); });
document.addEventListener("click", function (e) {
	if (!$("findList").hidden && !$("findList").contains(e.target)) showFind(false);
});

// ---------- .pdf reader (pdf.js, loaded only when a PDF is opened)

var pdfjsLoading = null;
function loadPdfJs() {
	if (!pdfjsLoading) {
		pdfjsLoading = import(PDFJS + "pdf.min.mjs").then(function (lib) {
			lib.GlobalWorkerOptions.workerSrc = PDFJS + "pdf.worker.min.mjs";
			return lib;
		}).catch(function (e) {
			pdfjsLoading = null;
			throw new Error("Couldn't load the PDF viewer from cdnjs (" + e.message + ").");
		});
	}
	return pdfjsLoading;
}
async function openPdf(sess, pos) {
	var libLoading = loadPdfJs();
	var res = await bookFileRes(sess.book);
	var data = new Uint8Array(await res.arrayBuffer());
	var lib = await libLoading;
	if (!sess.alive) return;
	var task = lib.getDocument({
		// useWorkerFetch off: fonts are fetched by the page, where the service
		// worker can hand over its offline copies.
		data: data, isEvalSupported: false, useWorkerFetch: false,
		cMapUrl: PDFJS_DATA + "cmaps/", cMapPacked: true, standardFontDataUrl: PDFJS_DATA + "standard_fonts/"
	});
	sess.cleanup.push(function () { task.destroy(); });
	var doc = await task.promise;
	if (!sess.alive) return;
	var first = (await doc.getPage(1)).getViewport({ scale: 1 });
	var body = $("bookBody"), pages = [];
	body.textContent = "";
	body.className = "pdf";
	for (var i = 1; i <= doc.numPages; i++) {
		var d = h("div", "pdfpage");
		d.dataset.n = i;
		d.style.aspectRatio = first.width + " / " + first.height;
		d.append(h("span", "pn", String(i)));
		pages.push(d);
		body.appendChild(d);
	}
	var pdf = sess.pdf = { doc: doc, pages: pages, n: doc.numPages };
	// Render pages as they come near the screen; free the canvases of pages
	// that scroll far away (iOS caps total canvas memory).
	var io = new IntersectionObserver(function (entries) {
		entries.forEach(function (e) {
			e.target.want = e.isIntersecting;
			if (e.isIntersecting) renderPdfPage(sess, e.target); else releasePdfPage(e.target);
		});
	}, { rootMargin: "150% 0px" });
	pages.forEach(function (p) { io.observe(p); });
	sess.cleanup.push(function () { io.disconnect(); pages.forEach(releasePdfPage); });
	var track = function () {
		if (sess.restoring) return;
		var c = pdfCurrent(pdf);
		savePosition(sess, { page: c.page, pf: Math.round(c.within * 1000) / 1000, pages: pdf.n, f: Math.round((c.page - 1 + c.within) / pdf.n * 1e4) / 1e4 });
		if (!sess.quietEnd) checkEnd(sess, pages[pages.length - 1]);
	};
	sess.track = track;
	listen(sess, window, "scroll", onScrollFrame(track), { passive: true });
	var resizeTimer;
	listen(sess, window, "resize", function () {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(function () { pages.forEach(function (p) { if (p.want) renderPdfPage(sess, p); }); }, 250);
	});
	sess.jump = function (s) {
		var at = clamp(s.page || 1, 1, pdf.n);
		aim(sess, function () {
			var r = pages[at - 1].getBoundingClientRect();
			return window.scrollY + r.top + (s.pf || 0) * r.height - headerBottom();
		}, track);
	};
	var page = clamp(pos.page || 1, 1, pdf.n);
	setProgress(posLabel(sess, { page: page, pages: pdf.n, f: pos.f }));
	setTimeout(function () { if (sess.alive) sendPdfCover(sess); }, 1500);
	if (page > 1 || pos.pf > 0) sess.jump(pos);
}
function pdfCurrent(pdf) {
	var line = headerBottom() + 1, lo = 0, hi = pdf.pages.length - 1;
	while (lo < hi) {
		var mid = (lo + hi + 1) >> 1;
		if (pdf.pages[mid].getBoundingClientRect().top <= line) lo = mid; else hi = mid - 1;
	}
	var r = pdf.pages[lo].getBoundingClientRect();
	return { page: lo + 1, within: r.height ? clamp((line - r.top) / r.height, 0, 1) : 0 };
}
async function renderPdfPage(sess, div) {
	var w = div.clientWidth, dpr = Math.min(window.devicePixelRatio || 1, 3);
	var key = w + "@" + dpr;
	if (!w || div.dataset.key === key || div.busy) return;
	div.busy = true;
	try {
		var page = await sess.pdf.doc.getPage(Number(div.dataset.n));
		var vp1 = page.getViewport({ scale: 1 });
		div.style.aspectRatio = vp1.width + " / " + vp1.height;
		var scale = (w * dpr) / vp1.width;
		var maxPx = 16e6; // Safari's per-canvas limit is 16.7M pixels
		if (vp1.width * vp1.height * scale * scale > maxPx) scale = Math.sqrt(maxPx / (vp1.width * vp1.height));
		var vp = page.getViewport({ scale: scale });
		var canvas = document.createElement("canvas");
		canvas.width = Math.floor(vp.width);
		canvas.height = Math.floor(vp.height);
		div.task = page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
		await div.task.promise;
		if (!sess.alive || !div.want) { canvas.width = canvas.height = 0; return; }
		var old = div.querySelector("canvas");
		if (old) { old.width = old.height = 0; old.remove(); }
		// Dark themes flip a page's colors so white paper turns dark. Pages
		// that aren't mostly plain paper (covers, comics, colour art) keep
		// their real colours.
		if (div.art === undefined) div.art = !mostlyPaper(canvas);
		canvas.classList.toggle("art", div.art);
		div.appendChild(canvas);
		div.dataset.key = key;
	} catch (e) {
		if (!e || e.name !== "RenderingCancelledException") console.warn("page " + div.dataset.n, e);
	} finally {
		div.busy = false;
		div.task = null;
	}
	if (sess.alive && div.want && div.dataset.key !== div.clientWidth + "@" + dpr) renderPdfPage(sess, div);
}
// True when most of the page is white or near-white with little colour,
// like printed text.
function mostlyPaper(canvas) {
	try {
		var w = 40, hgt = Math.max(1, Math.round(40 * canvas.height / canvas.width));
		var c = document.createElement("canvas");
		c.width = w; c.height = hgt;
		var x = c.getContext("2d", { willReadFrequently: true });
		x.drawImage(canvas, 0, 0, w, hgt);
		var px = x.getImageData(0, 0, w, hgt).data, paper = 0;
		for (var i = 0; i < px.length; i += 4) {
			var r = px[i], g = px[i + 1], b = px[i + 2], hi = Math.max(r, g, b), lo = Math.min(r, g, b);
			if (px[i + 3] < 128 || (lo > 200 && hi - lo < 40)) paper++;
		}
		c.width = c.height = 0;
		return paper / (px.length / 4) > 0.55;
	} catch (e) { return true; }
}
function releasePdfPage(div) {
	if (div.task) div.task.cancel();
	var c = div.querySelector("canvas");
	if (c) { c.width = c.height = 0; c.remove(); }
	delete div.dataset.key;
}

// ---------- .cbz reader
// A CBZ is a zip of page images. The browser unzips it itself (the zip's
// table of contents is read here, and compressed pages go through the
// built-in DecompressionStream), so there's no library to load or keep for
// offline. Pages are unpacked as they're shown, with a few on either side.

var CBZ_IMAGES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp" };
// -> [{name, method, offset, csize, flags}] for every file in a zip (a CBZ
// or an EPUB), in the zip's order. what: "a CBZ", for the error.
function zipEntries(buf, what) {
	var u8 = new Uint8Array(buf), dv = new DataView(buf), end = -1;
	for (var i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
	if (end < 0) throw new Error("This isn't a zip file, so it can't be read as " + what + ".");
	var count = dv.getUint16(end + 10, true), at = dv.getUint32(end + 16, true);
	// Zip64: the real count and start are in a second record.
	if ((count === 0xffff || at === 0xffffffff) && end >= 20 && dv.getUint32(end - 20, true) === 0x07064b50) {
		var z = Number(dv.getBigUint64(end - 12, true));
		count = Number(dv.getBigUint64(z + 32, true));
		at = Number(dv.getBigUint64(z + 48, true));
	}
	var names = new TextDecoder("utf-8"), files = [];
	for (var n = 0; n < count && at + 46 <= u8.length && dv.getUint32(at, true) === 0x02014b50; n++) {
		var flags = dv.getUint16(at + 8, true), method = dv.getUint16(at + 10, true);
		var csize = dv.getUint32(at + 20, true), size = dv.getUint32(at + 24, true), local = dv.getUint32(at + 42, true);
		var nl = dv.getUint16(at + 28, true), xl = dv.getUint16(at + 30, true), cl = dv.getUint16(at + 32, true);
		var name = names.decode(u8.subarray(at + 46, at + 46 + nl));
		// Sizes too big for 32 bits are in the zip64 extra field, in this order.
		for (var x = at + 46 + nl; x + 4 <= at + 46 + nl + xl;) {
			var id = dv.getUint16(x, true), len = dv.getUint16(x + 2, true), v = x + 4;
			if (id === 1) {
				if (size === 0xffffffff) { size = Number(dv.getBigUint64(v, true)); v += 8; }
				if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(v, true)); v += 8; }
				if (local === 0xffffffff) local = Number(dv.getBigUint64(v, true));
			}
			x += 4 + len;
		}
		at += 46 + nl + xl + cl;
		if (/\/$/.test(name) || local + 30 > u8.length || dv.getUint32(local, true) !== 0x04034b50) continue;
		var offset = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
		files.push({ name: name, method: method, offset: offset, csize: csize, flags: flags });
	}
	return files;
}
// -> [{name, method, offset, csize, type}] for a CBZ's page images, in reading order.
function readZip(buf) {
	var pages = [];
	zipEntries(buf, "a CBZ").forEach(function (e) {
		var ext = (/\.(\w+)$/.exec(e.name) || [])[1];
		var type = ext && CBZ_IMAGES[ext.toLowerCase()];
		if (!type || /(^|\/)(__MACOSX\/|\.)/.test(e.name)) return;
		if (e.flags & 1) throw new Error("This comic is password-protected, so it can't be opened.");
		if (e.method !== 0 && e.method !== 8) throw new Error("This comic uses a kind of zip compression the reader can't unpack.");
		e.type = type;
		pages.push(e);
	});
	pages.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }); });
	return pages;
}
async function zipEntryBlob(u8, e) {
	var data = u8.subarray(e.offset, e.offset + e.csize);
	if (e.method === 0) return new Blob([data], { type: e.type });
	if (!window.DecompressionStream) throw new Error("This browser is too old to unpack this file.");
	var out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
	return new Blob([out], { type: e.type });
}
// Guided view: panel by panel. Comic files carry no panel data, so the
// panels are found here: the page's margin color (white or black) is taken
// as the gutter color, then the page is cut along rows, then columns, that
// are all gutter, over and over (an "XY cut"). That finds classic grids with
// clean gutters; splash pages, bleeds and overlapping or borderless panels
// find one panel or a mess, and those pages are shown whole.
var GUIDED_KEY = "readerComicGuided";
function guidedOn() { return read(GUIDED_KEY) === "on"; }
function findPanels(img, rtl) {
	var nw = img.naturalWidth, nh = img.naturalHeight;
	if (!nw || !nh) return null;
	var sc = Math.min(1, 480 / Math.max(nw, nh)), w = Math.max(1, Math.round(nw * sc)), hgt = Math.max(1, Math.round(nh * sc));
	var cv = document.createElement("canvas");
	cv.width = w; cv.height = hgt;
	var cx = cv.getContext("2d", { willReadFrequently: true });
	cx.drawImage(img, 0, 0, w, hgt);
	var px;
	try { px = cx.getImageData(0, 0, w, hgt).data; } catch (e) { return null; }
	var g = new Uint8Array(w * hgt);
	for (var i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (px[j] * 299 + px[j + 1] * 587 + px[j + 2] * 114) / 1000;
	// Gutter color from the page's outer edge.
	var sum = 0, cnt = 0;
	for (var x = 0; x < w; x++) { sum += g[x] + g[(hgt - 1) * w + x]; cnt += 2; }
	for (var y = 0; y < hgt; y++) { sum += g[y * w] + g[y * w + w - 1]; cnt += 2; }
	var bg = sum / cnt;
	if (bg > 60 && bg < 195) return null;
	var white = bg >= 195;
	var gut = function (v) { return white ? v > 215 : v < 45; };
	var rowClear = function (y, x0, x1) {
		var bad = 0, allow = Math.max(1, (x1 - x0) * 0.012);
		for (var x = x0; x < x1; x++) if (!gut(g[y * w + x]) && ++bad > allow) return false;
		return true;
	};
	var colClear = function (x, y0, y1) {
		var bad = 0, allow = Math.max(1, (y1 - y0) * 0.012);
		for (var y = y0; y < y1; y++) if (!gut(g[y * w + x]) && ++bad > allow) return false;
		return true;
	};
	// Runs of not-gutter along one direction, gutters at least minGap thick.
	var runs = function (from, to, clear) {
		var out = [], start = -1, gap = 0, minGap = 2;
		for (var k = from; k < to; k++) {
			if (clear(k)) { gap++; if (start >= 0 && gap >= minGap) { out.push([start, k - gap + 1]); start = -1; } }
			else { if (start < 0) start = k; gap = 0; }
		}
		if (start >= 0) out.push([start, to - (gap < minGap ? 0 : gap)]);
		return out;
	};
	var minW = w * 0.08, minH = hgt * 0.05;
	var cut = function (r, depth) {
		var ys = runs(r.y, r.y + r.h, function (y) { return rowClear(y, r.x, r.x + r.w); })
			.filter(function (s) { return s[1] - s[0] >= minH; });
		if (!ys.length) return [];
		if (ys.length > 1 && depth < 6) return [].concat.apply([], ys.map(function (s) { return cut({ x: r.x, y: s[0], w: r.w, h: s[1] - s[0] }, depth + 1); }));
		var y0 = ys[0][0], y1 = ys[0][1];
		var xs = runs(r.x, r.x + r.w, function (x) { return colClear(x, y0, y1); })
			.filter(function (s) { return s[1] - s[0] >= minW; });
		if (!xs.length) return [];
		if (rtl) xs.reverse();
		if (xs.length > 1 && depth < 6) return [].concat.apply([], xs.map(function (s) { return cut({ x: s[0], y: y0, w: s[1] - s[0], h: y1 - y0 }, depth + 1); }));
		return [{ x: xs[0][0], y: y0, w: xs[0][1] - xs[0][0], h: y1 - y0 }];
	};
	var found = cut({ x: 0, y: 0, w: w, h: hgt }, 0);
	var area = found.reduce(function (a, r) { return a + r.w * r.h; }, 0);
	if (found.length < 2 || found.length > 16 || area < w * hgt * 0.4) return null;
	return found.map(function (r) { return { x: r.x / w, y: r.y / hgt, w: r.w / w, h: r.h / hgt }; });
}
// A comic's layout: "pages" (one at a time), "scroll" (webtoon: every page
// in one long strip) or "rtl" (one at a time, right to left, for manga).
// Saved on the book (migration 0009). A comic that has none yet gets one
// the first time it's opened, from its ComicInfo.xml (<Format>Webtoon or
// <Manga>YesAndRightToLeft) or else the shape of its first pages.
var cbzKeep = null; // {id, buf}: the open comic's file, kept while it reopens in another layout
async function openCbz(sess, pos) {
	var b = sess.book, buf;
	if (cbzKeep && cbzKeep.id === b.id) buf = cbzKeep.buf;
	else buf = await (await bookFileRes(b)).arrayBuffer();
	cbzKeep = null;
	if (!sess.alive) return;
	var u8 = new Uint8Array(buf), pages = readZip(buf), n = pages.length;
	if (!n) throw new Error("No page images in this comic.");
	var layout = b.layout;
	if (COMIC_LAYOUTS.indexOf(layout) < 0) {
		layout = await cbzLayout(buf, u8, pages).catch(function () { return "pages"; });
		if (!sess.alive) return;
		saveLayout(b, layout);
	}
	if (layout === "scroll") return openCbzScroll(sess, pos, buf, u8, pages);
	return openCbzPages(sess, pos, buf, u8, pages, layout === "rtl");
}
var COMIC_LAYOUTS = ["pages", "scroll", "rtl"];
async function cbzLayout(buf, u8, pages) {
	var info = zipEntries(buf, "a CBZ").filter(function (e) { return /(^|\/)comicinfo\.xml$/i.test(e.name); })[0];
	if (info) {
		var xml = await (await zipEntryBlob(u8, Object.assign({}, info, { type: "text/xml" }))).text();
		var el = function (name) { return ((new RegExp("<" + name + ">\\s*([^<]*?)\\s*</" + name + ">", "i").exec(xml) || [])[1] || "").toLowerCase(); };
		if (/web ?toon/.test(el("Format"))) return "scroll";
		if (el("Manga") === "yesandrighttoleft") return "rtl";
	}
	// Much taller than wide (about 1:2 or more) is a webtoon's strips. The
	// cover is skipped when there are pages enough, since it's often a
	// normal shape.
	var look = pages.length > 3 ? pages.slice(1, 4) : pages, tall = 0;
	for (var i = 0; i < look.length; i++) {
		var sz = imageSize(await zipEntryHead(u8, look[i]));
		if (sz && sz.h >= 1.9 * sz.w) tall++;
	}
	return tall * 2 > look.length ? "scroll" : "pages";
}
// The book's layout, kept here and sent (or left waiting if offline).
function saveLayout(b, layout) {
	b.layout = layout;
	if (bookDownloads[b.id]) { bookDownloads[b.id].layout = layout; saveBookDownloads(); }
	queueBook(b.id, { layout: layout });
	sendPending(b.id).catch(function () {});
}
// Switch the open comic's layout: it reopens at the same page, without
// fetching the file again.
function setLayout(layout) {
	var sess = session;
	if (!sess || !sess.cbz || sess.book.layout === layout) return;
	if (sess.track && !sess.restoring) sess.track();
	saveLayout(sess.book, layout);
	cbzKeep = { id: sess.book.id, buf: sess.cbz.buf };
	var id = sess.book.id;
	closeBook();
	openBook(id);
}
// The first bytes of a zip entry, unpacked (enough for an image's size).
async function zipEntryHead(u8, e) {
	var want = 256 * 1024, data = u8.subarray(e.offset, e.offset + e.csize);
	if (e.method === 0) return data.subarray(0, want);
	var reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader(), parts = [], got = 0;
	try {
		while (got < want) {
			var r = await reader.read();
			if (r.done) break;
			parts.push(r.value);
			got += r.value.length;
		}
	} catch (err) {} finally { reader.cancel().catch(function () {}); }
	var out = new Uint8Array(got), at = 0;
	parts.forEach(function (p) { out.set(p, at); at += p.length; });
	return out;
}
// -> {w, h} from the start of a JPEG, PNG, GIF, WebP or BMP file; null when
// it can't tell (the page's shape is then fixed once it's shown).
function imageSize(b) {
	var dv = new DataView(b.buffer, b.byteOffset, b.byteLength), len = b.length;
	try {
		if (b[0] === 0x89 && b[1] === 0x50 && len >= 24) return { w: dv.getUint32(16), h: dv.getUint32(20) };
		if (b[0] === 0x47 && b[1] === 0x49 && len >= 10) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
		if (b[0] === 0x42 && b[1] === 0x4d && len >= 26) return { w: dv.getInt32(18, true), h: Math.abs(dv.getInt32(22, true)) };
		if (b[0] === 0x52 && b[8] === 0x57 && b[9] === 0x45 && len >= 30) {
			var kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
			if (kind === "VP8 ") return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
			if (kind === "VP8L") { var v = dv.getUint32(21, true); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
			if (kind === "VP8X") return { w: 1 + (b[24] | b[25] << 8 | b[26] << 16), h: 1 + (b[27] | b[28] << 8 | b[29] << 16) };
		}
		if (b[0] === 0xff && b[1] === 0xd8) {
			for (var i = 2; i + 9 < len;) {
				if (b[i] !== 0xff) { i++; continue; }
				var m = b[i + 1];
				if (m === 0xff) { i++; continue; }
				if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
				if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: dv.getUint16(i + 7), h: dv.getUint16(i + 5) };
				i += 2 + dv.getUint16(i + 2);
			}
		}
	} catch (e) {}
	return null;
}
// Webtoon: every page stacked at full width with no gaps, so strips cut
// into slices join up again. Each page's box is sized from its image's
// header before anything is shown, so a saved place lands where it should;
// pages are unpacked as they come near the screen and let go far from it,
// the way PDF pages are drawn. The place is a page and how far into it.
async function openCbzScroll(sess, pos, buf, u8, pages) {
	var n = pages.length, sizes = [];
	for (var k = 0; k < n; k += 16) {
		var batch = await Promise.all(pages.slice(k, k + 16).map(function (e) { return zipEntryHead(u8, e).then(imageSize, function () { return null; }); }));
		if (!sess.alive) return;
		sizes = sizes.concat(batch);
	}
	var body = $("bookBody"), strips = [], ratio = "2 / 3";
	body.textContent = "";
	body.className = "cbz scroll";
	for (var i = 0; i < n; i++) {
		var sz = sizes[i];
		if (sz && sz.w > 0 && sz.h > 0) ratio = sz.w + " / " + sz.h;
		var d = h("div", "cbzstrip"), img = h("img");
		img.alt = "Page " + (i + 1);
		img.decoding = "async";
		d.style.aspectRatio = ratio;
		d.dataset.n = i + 1;
		d.append(img);
		strips.push(d);
		body.appendChild(d);
	}
	var urls = {};
	function show(d) {
		var i = Number(d.dataset.n), img = d.firstChild;
		if (urls[i]) return;
		urls[i] = zipEntryBlob(u8, pages[i - 1]).then(function (b) { return URL.createObjectURL(b); });
		urls[i].then(function (src) {
			if (!sess.alive || !d.want) return;
			img.onload = function () {
				// A page whose size wasn't in its header (or was turned by its
				// EXIF) gets its real shape now.
				var r = img.naturalWidth + " / " + img.naturalHeight;
				if (img.naturalWidth && d.style.aspectRatio !== r && Math.abs(img.naturalWidth / img.naturalHeight - d.clientWidth / d.clientHeight) > 0.01) d.style.aspectRatio = r;
			};
			img.src = src;
		}, function (e) { if (sess.alive) toast("Couldn't show page " + i + ": " + e.message); });
	}
	function hide(d) {
		var i = Number(d.dataset.n);
		if (!urls[i]) return;
		urls[i].then(URL.revokeObjectURL, function () {});
		delete urls[i];
		d.firstChild.removeAttribute("src");
	}
	var io = new IntersectionObserver(function (entries) {
		entries.forEach(function (e) {
			e.target.want = e.isIntersecting;
			if (e.isIntersecting) show(e.target); else hide(e.target);
		});
	}, { rootMargin: "200% 0px" });
	strips.forEach(function (d) { io.observe(d); });
	sess.cleanup.push(function () { io.disconnect(); strips.forEach(hide); });
	var list = { pages: strips };
	var track = function () {
		if (sess.restoring) return;
		var c = pdfCurrent(list);
		savePosition(sess, { page: c.page, pf: Math.round(c.within * 1000) / 1000, pages: n, f: Math.round((c.page - 1 + c.within) / n * 1e4) / 1e4 });
		if (!sess.quietEnd) checkEnd(sess, strips[n - 1]);
	};
	sess.track = track;
	listen(sess, window, "scroll", onScrollFrame(track), { passive: true });
	sess.jump = function (s) {
		var at = clamp(s.page || Math.round((s.f || 0) * n) || 1, 1, n);
		aim(sess, function () {
			var r = strips[at - 1].getBoundingClientRect();
			return window.scrollY + r.top + (s.page ? s.pf || 0 : 0) * r.height - headerBottom();
		}, track);
	};
	sess.cbz = { n: n, buf: buf, scroll: true, go: function (i) { sess.jump({ page: i }); }, setGuided: function () {} };
	var page = clamp(pos.page || 1, 1, n);
	setProgress(posLabel(sess, { page: page, pages: n, f: pos.f }));
	if (page > 1 || pos.pf > 0) sess.jump(pos);
}
async function openCbzPages(sess, pos, buf, u8, pages, rtl) {
	var n = pages.length;
	var body = $("bookBody");
	body.textContent = "";
	body.className = "cbz" + (read("readerComicFit") === "width" ? " fitw" : "") + (guidedOn() ? " guided" : "");
	var box = h("div", "cbzpage"), img = h("img");
	img.alt = "";
	box.append(img);
	// Right to left: the bar is mirrored (so the next page's button is on
	// the left, its arrow turned by the browser, and the slider starts on
	// the right), and taps, swipes and
	// arrow keys turn the other way.
	var prev = button("‹", "btn", function () { step(-1); }), next = button("›", "btn", function () { step(1); });
	prev.setAttribute("aria-label", "Previous page");
	next.setAttribute("aria-label", "Next page");
	var slider = h("input");
	slider.type = "range";
	slider.min = 1;
	slider.max = n;
	slider.setAttribute("aria-label", "Page");
	slider.addEventListener("change", function () { go(Number(slider.value), true); });
	var bar = h("div", "cbzbar");
	if (rtl) bar.dir = "rtl";
	bar.append(prev, slider, next);
	body.append(box, bar);
	var urls = {}, cur = 0;
	// Guided view: the panels of the page showing (null: shown whole), which
	// one is on screen, and whether a middle tap pulled back to the page.
	var g = { panels: null, at: 0, whole: false, found: {} };
	function url(i) {
		if (!urls[i]) urls[i] = zipEntryBlob(u8, pages[i - 1]).then(function (b) { return URL.createObjectURL(b); });
		return urls[i];
	}
	function comicLabel(i) { return posLabel(sess, { page: i, pages: n, f: i / n }); }
	// Keeps two pages back and three ahead unpacked; lets the rest go.
	function keepNear(c) {
		Object.keys(urls).forEach(function (k) {
			if (k < c - 2 || k > c + 3) { urls[k].then(URL.revokeObjectURL, function () {}); delete urls[k]; }
		});
		for (var k = c + 1; k <= Math.min(n, c + 3); k++) url(k).catch(function () {});
	}
	// byReader: a turn the reader made (saved, and can mark the comic finished),
	// not the saved place being put back.
	async function go(i, byReader, last) {
		i = clamp(i, 1, n);
		if (i === cur) return;
		cur = i;
		slider.value = i;
		prev.disabled = i === 1;
		next.disabled = i === n;
		setProgress(comicLabel(i));
		if (byReader) {
			savePosition(sess, { page: i, pages: n, f: Math.round(i / n * 1e4) / 1e4 });
			if (i === n) reachedEnd(sess);
		}
		keepNear(i);
		try {
			var src = await url(i);
			if (!sess.alive || cur !== i) return;
			if (guidedOn()) img.style.visibility = "hidden";
			img.src = src;
			img.alt = "Page " + i;
			if (byReader) window.scrollTo(0, 0);
			if (guidedOn()) await guide(i, last);
		} catch (e) {
			if (sess.alive && cur === i) toast("Couldn't show page " + i + ": " + e.message);
		}
	}
	// Next or previous: a panel in guided view (a page past the first or
	// last one), else a page.
	function step(dir) {
		if (guidedOn() && g.panels && !g.whole) {
			var k = g.at + dir;
			if (k >= 0 && k < g.panels.length) { g.at = k; place(); return; }
		}
		if (guidedOn() && g.whole && g.panels) { g.whole = false; if (dir < 0) { place(); return; } }
		go(cur + dir, true, dir < 0);
	}
	async function guide(i, last) {
		if (!img.complete || !img.naturalWidth) {
			await new Promise(function (res) { img.onload = img.onerror = function () { img.onload = img.onerror = null; res(); }; });
		}
		if (!sess.alive || cur !== i) return;
		if (!(i in g.found)) g.found[i] = findPanels(img, rtl);
		g.panels = g.found[i];
		g.at = g.panels && last ? g.panels.length - 1 : 0;
		g.whole = false;
		place();
		img.style.visibility = "";
	}
	// Fit the panel (or the page) to the frame, centered, with a little room.
	function place() {
		if (!guidedOn() || !img.naturalWidth) { img.style.transform = ""; img.style.width = ""; img.style.height = ""; return; }
		var W = box.clientWidth, H = box.clientHeight, nw = img.naturalWidth, nh = img.naturalHeight;
		var r = g.panels && !g.whole ? g.panels[g.at] : { x: 0, y: 0, w: 1, h: 1 };
		var pad = g.panels && !g.whole ? 0.012 : 0;
		var rx = Math.max(0, r.x - pad), ry = Math.max(0, r.y - pad), rw = Math.min(1 - rx, r.w + pad * 2), rh = Math.min(1 - ry, r.h + pad * 2);
		var s = Math.min(W / (rw * nw), H / (rh * nh));
		var tx = W / 2 - (rx + rw / 2) * nw * s, ty = H / 2 - (ry + rh / 2) * nh * s;
		img.style.width = nw + "px";
		img.style.height = nh + "px";
		img.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + s + ")";
		setProgress(comicLabel(cur) + (g.panels && !g.whole ? " · panel " + (g.at + 1) + "/" + g.panels.length : ""));
	}
	function setGuided(on) {
		store(GUIDED_KEY, on ? "on" : null);
		body.classList.toggle("guided", on);
		g.found = {};
		g.whole = false;
		if (on) guide(cur, false); else { g.panels = null; place(); }
	}
	sess.cbz = { n: n, buf: buf, go: go, setGuided: setGuided };
	sess.jump = function (s) { go(s.page || Math.round(s.f * n) || 1, false); window.scrollTo(0, 0); };
	function fit() { body.style.setProperty("--cbz-h", Math.max(200, window.innerHeight - headerBottom() - bar.offsetHeight - 24) + "px"); }
	fit();
	listen(sess, window, "resize", onScrollFrame(function () { fit(); place(); }));
	// Tap the left or right side to turn; the middle switches between the
	// whole page on screen and page width (scroll down for the rest).
	listen(sess, box, "click", function (e) {
		var x = e.clientX / window.innerWidth;
		if (x < 0.35) step(rtl ? 1 : -1);
		else if (x > 0.65) step(rtl ? -1 : 1);
		else if (guidedOn()) {
			// In guided view the middle pulls back to the whole page, and back in.
			if (g.panels) { g.whole = !g.whole; place(); }
		} else {
			var w = body.classList.toggle("fitw");
			store("readerComicFit", w ? "width" : null);
		}
	});
	var swipe = null;
	listen(sess, box, "touchstart", function (e) {
		var t = e.touches[0], zoomed = window.visualViewport && window.visualViewport.scale > 1.05;
		swipe = e.touches.length === 1 && !zoomed && t.clientX > 24 && t.clientX < window.innerWidth - 24 ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
	}, { passive: true });
	listen(sess, box, "touchend", function (e) {
		if (!swipe) return;
		var t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y, quick = Date.now() - swipe.at < 700;
		swipe = null;
		if (!quick || Math.abs(dx) < 50 || Math.abs(dx) < 2 * Math.abs(dy)) return;
		e.preventDefault();
		step((dx < 0) !== rtl ? 1 : -1);
	});
	listen(sess, box, "touchcancel", function () { swipe = null; }, { passive: true });
	listen(sess, document, "keydown", function (e) {
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !$("bookMenu").hidden || !$("settings").hidden) return;
		if (e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
		var dir = e.key === "j" || e.key === "PageDown" ? 1 : e.key === "k" || e.key === "PageUp" ? -1
			: e.key === "ArrowRight" ? (rtl ? -1 : 1) : e.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
		if (!dir) return;
		e.preventDefault();
		step(dir);
	});
	sess.cleanup.push(function () { Object.keys(urls).forEach(function (k) { urls[k].then(URL.revokeObjectURL, function () {}); }); });
	await go(pos.page || 1, false);
}

// ---------- .epub reader
// An EPUB is a zip of XHTML chapters plus a list of them (the OPF). Like a
// CBZ, it's unpacked here in the browser, so there's nothing to load and the
// Worker only keeps the file. epubLoad and epubBlocks know nothing about the
// database or the rest of this page: they turn the file into its details
// (title, author, series, cover), its contents and a list of blocks
// (paragraphs, headings, images). The reader puts those blocks where a
// .txt's paragraphs go, so position, the end-of-book check and highlights
// work the same way, by character position in the book's text. The book's
// own styles aren't used, so it takes the reader's font, size and theme;
// its italics, bold and centering are kept.
// Only DRM-free EPUBs open. A store's copy protection (Adobe, Apple, Kobo)
// encrypts the chapters, and those files are turned away at upload.

var EPUB_DRM = "This EPUB has DRM (copy protection), so it can't be read here. Only DRM-free EPUBs work.";
// Fonts scrambled so they can't be lifted out aren't DRM; the text is plain.
var EPUB_FONT_KEYS = /^http:\/\/(www\.idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC)$/;
var EPUB_BLOCK = /^(p|h[1-6]|blockquote|pre|ul|ol|dl|table|figure|hr)$/;
var EPUB_HAS_BLOCK = "p,div,h1,h2,h3,h4,h5,h6,blockquote,pre,ul,ol,dl,table,figure,hr,section,article,aside,header,footer,main,nav";
var XLINK_NS = "http://www.w3.org/1999/xlink";
var EPUB_DISPLAY_BLOCK = /(^|[;\s])display\s*:\s*(block|flow-root|list-item)\b/;

function epubTags(node, name) { return node ? [].slice.call(node.getElementsByTagNameNS("*", name)) : []; }
// A link inside the book as a zip path (plus its #fragment), from the file
// it's in. null for a link off the book.
function epubPath(href, from) {
	if (!href) return null;
	try {
		var u = new URL(String(href).trim(), "https://epub.invalid/" + from.split("/").map(encodeURIComponent).join("/"));
		if (u.origin !== "https://epub.invalid") return null;
		return decodeURIComponent(u.pathname.slice(1)) + decodeURIComponent(u.hash);
	} catch (e) { return null; }
}
// Chapters are XHTML; a broken one (a bare &nbsp;, say) is read as HTML instead.
function epubDoc(text) {
	var doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
	return doc.getElementsByTagName("parsererror").length ? parseHTML(text) : doc;
}

// -> {meta: {title, author, series, volume}, spine: [{path, type, linear}], toc:
// [{label, depth, to}], cover (a zip path or null), text(path), image(path)}.
// Throws for a locked (DRM) or broken file.
async function epubLoad(buf) {
	var u8 = new Uint8Array(buf), files = {}, lower = {};
	zipEntries(buf, "an EPUB").forEach(function (e) { files[e.name] = e; lower[e.name.toLowerCase()] = e; });
	var entry = function (path) { return files[path] || lower[String(path).toLowerCase()] || null; };
	var blob = async function (path, type) {
		var e = entry(path);
		if (!e) return null;
		if (e.flags & 1) throw new Error(EPUB_DRM);
		if (e.method !== 0 && e.method !== 8) throw new Error("This EPUB uses a kind of zip compression the reader can't unpack.");
		return zipEntryBlob(u8, Object.assign({}, e, { type: type || "" }));
	};
	var text = async function (path) { var b = await blob(path); return b ? decodeText(await b.arrayBuffer()) : null; };
	var xml = async function (path) { var t = await text(path); return t == null ? null : parseXML(t); };

	if (entry("META-INF/rights.xml") || entry("META-INF/sinf.xml")) throw new Error(EPUB_DRM);
	var enc = await xml("META-INF/encryption.xml");
	if (epubTags(enc, "EncryptionMethod").some(function (m) { return !EPUB_FONT_KEYS.test(m.getAttribute("Algorithm") || ""); })) throw new Error(EPUB_DRM);

	var container = await xml("META-INF/container.xml");
	var opfPath = (epubTags(container, "rootfile")[0] || { getAttribute: function () { return null; } }).getAttribute("full-path");
	var opf = opfPath ? await xml(opfPath) : null;
	if (!opf) throw new Error("This EPUB is missing its list of chapters, so it can't be opened.");
	var manifest = {}, byPath = {};
	epubTags(opf, "item").forEach(function (it) {
		var path = epubPath(it.getAttribute("href"), opfPath);
		if (!path) return;
		var m = { id: it.getAttribute("id"), path: path.split("#")[0], type: (it.getAttribute("media-type") || "").toLowerCase(), props: " " + (it.getAttribute("properties") || "") + " " };
		manifest[m.id] = byPath[m.path] = m;
	});
	var items = Object.keys(manifest).map(function (k) { return manifest[k]; });
	var spineEl = epubTags(opf, "spine")[0];
	var spine = epubTags(spineEl, "itemref").map(function (r) {
		var m = manifest[r.getAttribute("idref")];
		return m && { path: m.path, type: m.type, linear: r.getAttribute("linear") !== "no" };
	}).filter(function (m) { return m && /html/.test(m.type) && entry(m.path); });
	if (!spine.length) throw new Error("This EPUB has no chapters in it.");

	var md = epubTags(opf, "metadata")[0] || opf, metas = epubTags(md, "meta");
	var refine = function (el, prop) {
		var id = el && el.getAttribute("id");
		var m = id && metas.filter(function (x) { return x.getAttribute("refines") === "#" + id && x.getAttribute("property") === prop; })[0];
		return m ? m.textContent.trim() : "";
	};
	var named = function (name) {
		var m = metas.filter(function (x) { return x.getAttribute("name") === name; })[0];
		return m ? (m.getAttribute("content") || "").trim() : "";
	};
	var titles = epubTags(md, "title");
	var title = titles.filter(function (t) { return refine(t, "title-type") === "main"; })[0] || titles[0];
	var creators = epubTags(md, "creator");
	var authors = creators.filter(function (c) {
		var role = c.getAttribute("opf:role") || c.getAttribute("role") || refine(c, "role");
		return !role || role === "aut";
	});
	if (!authors.length) authors = creators.slice(0, 1);
	var coll = metas.filter(function (x) {
		return x.getAttribute("property") === "belongs-to-collection" && (refine(x, "collection-type") || "series") === "series";
	})[0];
	var volume = coll ? refine(coll, "group-position") : named("calibre:series_index");
	var meta = {
		title: title ? plain(title.textContent) : "",
		author: authors.map(function (a) { return plain(a.textContent); }).filter(Boolean).join(", "),
		series: coll ? plain(coll.textContent) : named("calibre:series"),
		volume: String(volume || "").replace(/\.0+$/, "")
	};

	var isImage = function (m) { return m && /^image\//.test(m.type); };
	var cover = items.filter(function (m) { return /\scover-image\s/.test(m.props); })[0] || manifest[named("cover")];
	if (!isImage(cover)) cover = items.filter(function (m) { return isImage(m) && /cover/i.test(m.id + " " + m.path); })[0];

	// Contents: the EPUB 3 nav page, else the EPUB 2 NCX.
	var toc = [], nav = items.filter(function (m) { return /\snav\s/.test(m.props); })[0];
	if (nav) {
		var navText = await text(nav.path), navDoc = navText ? epubDoc(navText) : null, navs = epubTags(navDoc, "nav");
		var tocNav = navs.filter(function (n) { return /(^|\s)toc(\s|$)/.test(n.getAttribute("epub:type") || n.getAttributeNS("http://www.idpf.org/2007/ops", "type") || ""); })[0] || navs[0];
		(function list(ol, depth) {
			kids(ol, "li").forEach(function (li) {
				var a = kid(li, "a"), label = a ? plain(a.textContent) : "", to = a && epubPath(a.getAttribute("href"), nav.path);
				if (label && to) toc.push({ label: label, depth: depth, to: to });
				var sub = kid(li, "ol");
				if (sub && depth < 6) list(sub, depth + 1);
			});
		})(epubTags(tocNav, "ol")[0], 0);
	}
	var ncx = !toc.length && (manifest[spineEl && spineEl.getAttribute("toc")] || items.filter(function (m) { return m.type === "application/x-dtbncx+xml"; })[0]);
	if (ncx) {
		var ncxDoc = await xml(ncx.path);
		(function points(parent, depth) {
			kids(parent, "navPoint").forEach(function (p) {
				var label = plain(epubTags(kid(p, "navLabel"), "text").map(function (t) { return t.textContent; }).join(" "));
				var c = kid(p, "content"), to = c && epubPath(c.getAttribute("src"), ncx.path);
				if (label && to) toc.push({ label: label, depth: depth, to: to });
				if (depth < 6) points(p, depth + 1);
			});
		})(epubTags(ncxDoc, "navMap")[0], 0);
	}

	return {
		meta: meta, spine: spine, toc: toc, cover: cover ? cover.path : null, text: text,
		styles: items.filter(function (m) { return m.type === "text/css"; }).map(function (m) { return m.path; }),
		has: function (path) { return !!entry(path); },
		image: function (path) {
			var m = byPath[path], ext = (/\.(\w+)$/.exec(path) || [])[1];
			var type = (m && m.type) || (ext && (CBZ_IMAGES[ext.toLowerCase()] || (/^svg$/i.test(ext) ? "image/svg+xml" : ""))) || "";
			return /^image\//.test(type) ? blob(path, type) : Promise.resolve(null);
		}
	};
}

// The book's stylesheets, only for which classes mean italic, bold,
// centered, or a line of its own (calibre's "calibre5" and the like say so
// nowhere else; some books make every paragraph a span with display: block).
// Only single-class rules are read: ".x" or "p.x".
function epubCss(css, out) {
	var re = /([^{}@]+)\{([^{}]*)\}/g, m;
	css = css.replace(/\/\*[\s\S]*?\*\//g, "");
	while ((m = re.exec(css))) {
		var d = m[2].toLowerCase();
		var it = /font-style\s*:\s*(italic|oblique)/.test(d), bd = /font-weight\s*:\s*(bold|bolder|[6-9]00)\b/.test(d);
		var al = /text-align\s*:\s*center/.test(d) ? "ec" : /text-align\s*:\s*right/.test(d) ? "er" : "";
		var bl = EPUB_DISPLAY_BLOCK.test(d);
		if (!it && !bd && !al && !bl) continue;
		m[1].split(",").forEach(function (sel) {
			var c = /^[a-z0-9]*\.([\w-]+)$/i.exec(sel.trim());
			if (!c) return;
			if (it) out.i[c[1]] = 1;
			if (bd) out.b[c[1]] = 1;
			if (al) out.al[c[1]] = al;
			if (bl) out.bl[c[1]] = 1;
		});
	}
}
function epubFmt(n, css) {
	var cls = (n.getAttribute("class") || "").split(/\s+/).filter(Boolean), st = (n.getAttribute("style") || "").toLowerCase();
	var named = function (re) { return cls.some(function (c) { return re.test(c); }); };
	var al = "";
	cls.forEach(function (c) { if (css.al[c]) al = css.al[c]; });
	if (/text-align\s*:\s*center/.test(st)) al = "ec"; else if (/text-align\s*:\s*right/.test(st)) al = "er";
	return {
		i: /font-style\s*:\s*(italic|oblique)/.test(st) || cls.some(function (c) { return css.i[c]; }) || named(/(^|[_-])(italic|ital|emph)([_-]|$)/i),
		b: /font-weight\s*:\s*(bold|bolder|[6-9]00)\b/.test(st) || cls.some(function (c) { return css.b[c]; }) || named(/(^|[_-])(bold|strong)([_-]|$)/i),
		al: al || (named(/^(center|centered|centre|centred)$/i) ? "ec" : ""),
		bl: EPUB_DISPLAY_BLOCK.test(st) || cls.some(function (c) { return css.bl[c]; })
	};
}

// One chapter's body into clean elements, from the same allow-list as
// articles (ALLOWED, DROP). Links into the book get data-to (a zip path),
// images data-zip (filled in when they come near the screen), and anything
// a link can point at keeps its place in data-eid.
function epubClean(from, to, path, ep, css, depth, pre) {
	if (depth > 60) return;
	for (var n = from.firstChild; n; n = n.nextSibling) {
		if (n.nodeType === 3 || n.nodeType === 4) { to.appendChild(document.createTextNode(pre ? n.data : n.data.replace(/\s+/g, " "))); continue; }
		if (n.nodeType !== 1) continue;
		var tag = n.localName.toLowerCase(), id = n.getAttribute("id"), eid = id ? path + "#" + id : null;
		// A cover page is often an SVG wrapped around one <image>.
		if (tag === "svg") {
			var im = epubTags(n, "image")[0];
			if (im) epubImg(im.getAttributeNS(XLINK_NS, "href") || im.getAttribute("href"), "", to, path, ep, eid);
			continue;
		}
		if (tag === "img") { epubImg(n.getAttribute("src"), n.getAttribute("alt"), to, path, ep, eid); continue; }
		if (DROP.test(tag)) continue;
		if (AS_DIV.test(tag)) tag = "div";
		var allowed = tag !== "span" && ALLOWED[tag], e = null, fmt = epubFmt(n, css), dest = to;
		// An inline element the book's CSS shows as a block (a span per
		// paragraph, say) gets a div around it, or its lines would run together.
		if (fmt.bl && !EPUB_BLOCK.test(tag) && !/^(div|li|dt|dd|tr|td|th|thead|tbody|tfoot|caption|figcaption|br)$/.test(tag)) {
			dest = to.appendChild(document.createElement("div"));
			if (fmt.al) dest.className = fmt.al;
		}
		if (allowed) {
			e = document.createElement(tag);
			allowed.forEach(function (a) {
				var v = n.getAttribute(a);
				if (v && /^(colspan|rowspan|start)$/.test(a) && /^\d{1,5}$/.test(v.trim())) e.setAttribute(a, v.trim());
				else if (v && a === "title") e.setAttribute(a, v.slice(0, 300));
			});
			if (tag === "a") epubLink(n, e, path);
			if (eid) e.dataset.eid = eid;
			if (fmt.al && /^(p|div|h[1-6]|blockquote)$/.test(tag)) e.className = fmt.al;
			dest.appendChild(e);
		} else if (eid) {
			var spot = document.createElement("span");
			spot.dataset.eid = eid;
			dest.appendChild(spot);
		}
		var inner = e || dest;
		// Italic or bold from a class or a style, on something holding only text.
		if ((fmt.i || fmt.b) && !n.querySelector(EPUB_HAS_BLOCK)) {
			if (fmt.i && !/^(em|i|cite)$/.test(tag)) inner = inner.appendChild(document.createElement("em"));
			if (fmt.b && !/^(strong|b|h[1-6]|th)$/.test(tag)) inner = inner.appendChild(document.createElement("strong"));
		}
		epubClean(n, inner, path, ep, css, depth + 1, pre || tag === "pre");
	}
}
function epubLink(n, e, path) {
	var href = (n.getAttribute("href") || n.getAttributeNS(XLINK_NS, "href") || "").trim();
	if (!href) return;
	if (/^(https?|mailto):/i.test(href)) {
		e.setAttribute("href", href.slice(0, 2000));
		e.setAttribute("target", "_blank");
		e.setAttribute("rel", "noopener noreferrer");
		return;
	}
	var to = epubPath(href, path);
	if (!to) return;
	e.setAttribute("href", "#");
	e.dataset.to = to;
}
function epubImg(src, alt, to, path, ep, eid) {
	var p = epubPath(src, path);
	p = p && p.split("#")[0];
	if (!p || !ep.has(p)) return;
	var img = document.createElement("img");
	img.alt = alt || "";
	img.setAttribute("decoding", "async");
	img.dataset.zip = p;
	if (eid) img.dataset.eid = eid;
	to.appendChild(img);
}

// Every chapter, in order, as a flat list of blocks: a chapter's divs are
// opened up until what's left is paragraphs, headings, lists, figures and
// the like; loose text between them becomes a paragraph. -> {blocks,
// anchors: {"path#id": {i, el}}, starts: {path: first block}, end: the
// last block of the book proper, before any notes kept out of the reading
// order (linear="no")}.
async function epubBlocks(ep, alive) {
	var css = { i: {}, b: {}, al: {}, bl: {} };
	for (var c = 0; c < ep.styles.length; c++) epubCss((await ep.text(ep.styles[c]).catch(function () { return ""; })) || "", css);
	var out = { blocks: [], anchors: {}, starts: {}, end: null }, st = { run: null, pending: [] };
	for (var s = 0; s < ep.spine.length; s++) {
		var path = ep.spine[s].path, src = await ep.text(path);
		if (!alive()) return null;
		var body = src == null ? null : epubTags(epubDoc(src), "body")[0];
		var first = out.blocks.length;
		out.starts[path] = first;
		if (!body) continue;
		var frag = document.createDocumentFragment();
		epubClean(body, frag, path, ep, css, 0, false);
		epubFlatten(frag, out, st);
		epubEndRun(out, st);
		if (first > 0 && out.blocks.length > first) out.blocks[first].classList.add("estart");
		if (ep.spine[s].linear && out.blocks.length) out.end = out.blocks.length - 1;
		if (s % 4 === 3) await pause();
	}
	// A cover the chapters never show goes first.
	if (ep.cover && !out.blocks.some(function (b) { return b.querySelector("img[data-zip='" + ep.cover.replace(/['\\]/g, "\\$&") + "']"); })) {
		var p = document.createElement("p"), img = document.createElement("img");
		img.alt = "Cover";
		img.dataset.zip = ep.cover;
		p.append(img);
		out.blocks.unshift(p);
		Object.keys(out.starts).forEach(function (k) { out.starts[k]++; });
		Object.keys(out.anchors).forEach(function (k) { out.anchors[k].i++; });
		if (out.end != null) out.end++;
		epubMark(p);
	}
	var last = out.blocks.length - 1;
	st.pending.forEach(function (id) { if (last >= 0) out.anchors[id] = { i: last, el: null }; });
	Object.keys(out.starts).forEach(function (k) { out.starts[k] = Math.min(out.starts[k], Math.max(last, 0)); });
	return out;
}
function epubFlatten(from, out, st) {
	for (var n = from.firstChild, next; n; n = next) {
		next = n.nextSibling;
		var tag = n.nodeType === 1 ? n.localName : "";
		if (tag !== "div" && !EPUB_BLOCK.test(tag)) {
			(st.run = st.run || document.createElement("p")).appendChild(n);
			continue;
		}
		epubEndRun(out, st);
		// A paragraph holding blocks (the divs epubClean put around
		// display: block spans) is opened up like a div.
		if ((tag === "div" || tag === "p") && n.querySelector(tag === "p" ? "div" : EPUB_HAS_BLOCK)) {
			if (n.dataset.eid) st.pending.push(n.dataset.eid);
			epubFlatten(n, out, st);
			epubEndRun(out, st);
		} else epubPush(out, st, n);
	}
}
function epubEndRun(out, st) {
	var run = st.run;
	st.run = null;
	if (run) epubPush(out, st, run);
}
function epubPush(out, st, el) {
	var spots = el.querySelectorAll("[data-eid]");
	// Nothing to read or see (a spacer, an empty anchor): its link targets
	// move on to the next block.
	if (!el.textContent.trim() && !el.querySelector("img") && el.localName !== "hr") {
		if (el.dataset.eid) st.pending.push(el.dataset.eid);
		spots.forEach(function (s) { st.pending.push(s.dataset.eid); });
		return;
	}
	var i = out.blocks.length;
	out.blocks.push(el);
	st.pending.forEach(function (id) { out.anchors[id] = { i: i, el: null }; });
	st.pending = [];
	if (el.dataset.eid) out.anchors[el.dataset.eid] = { i: i, el: el };
	spots.forEach(function (s) { out.anchors[s.dataset.eid] = { i: i, el: s }; });
	epubMark(el);
}
// A block that's only a picture is centered.
function epubMark(el) { if (!el.textContent.trim() && el.querySelector("img")) el.classList.add("eimg"); }

async function openEpub(sess, pos) {
	var res = await bookFileRes(sess.book);
	var buf = await res.arrayBuffer();
	if (!sess.alive) return;
	var ep = await epubLoad(buf);
	var built = await epubBlocks(ep, function () { return sess.alive; });
	if (!built || !sess.alive) return;
	var body = $("bookBody"), blocks = built.blocks, paras = [], starts = [], total = 0, chunks = [];
	body.textContent = "";
	body.className = "txt epub";
	for (var c = 0; c < blocks.length; c += CHUNK) {
		var div = h("div", "chunk");
		for (var k = c; k < Math.min(c + CHUNK, blocks.length); k++) {
			var text = blocks[k].textContent;
			starts.push(total);
			paras.push(text);
			total += text.length + 1;
			div.appendChild(blocks[k]);
		}
		chunks.push(div);
		body.appendChild(div);
		if (chunks.length % 40 === 0) { await pause(); if (!sess.alive) return; }
	}
	if (!blocks.length) body.append(h("p", "muted", "There's no text in this book."));
	var t = { paras: paras, starts: starts, total: Math.max(total, 1), chunks: chunks, rich: true, anchors: built.anchors, docStart: built.starts, endIdx: built.end };
	sess.epub = { toc: ep.toc.filter(function (x) { return epubTarget(t, x.to); }) };
	// Pictures are unpacked as they come near the screen.
	var urls = {};
	var io = new IntersectionObserver(function (entries) {
		entries.forEach(function (e) {
			if (!e.isIntersecting) return;
			var img = e.target, path = img.dataset.zip;
			io.unobserve(img);
			(urls[path] = urls[path] || ep.image(path).then(function (b) { return b && URL.createObjectURL(b); })).then(function (u) { if (u) img.src = u; }, function () {});
		});
	}, { rootMargin: "150% 0px" });
	body.querySelectorAll("img[data-zip]").forEach(function (img) { io.observe(img); });
	sess.cleanup.push(function () {
		io.disconnect();
		Object.keys(urls).forEach(function (k) { urls[k].then(function (u) { if (u) URL.revokeObjectURL(u); }, function () {}); });
		show($("tocList"), false);
	});
	// Links inside the book (contents pages, footnotes) jump within it.
	listen(sess, body, "click", function (e) {
		var a = e.target.closest && e.target.closest("a[data-to]");
		if (!a) return;
		e.preventDefault();
		var sel = window.getSelection();
		if (e.target.closest("mark.hl") || (sel && !sel.isCollapsed)) return;
		epubGo(sess, a.dataset.to);
	});
	startText(sess, t, pos);
	renderBookMenu();
	// Uploaded without its details filled in (the upload's second step
	// failed, say): fill them in now.
	var b = sess.book;
	if (!b.author && !b.series && !state.libOffline) epubDetails(b, ep.meta).then(function () {
		if (sess.alive) $("heading").textContent = b.title;
	}, function () {});
}
// A link's target, as a block (and the element in it, if there is one).
function epubTarget(t, to) {
	var hit = t.anchors[to];
	if (hit) return hit;
	var file = to.split("#")[0];
	return Object.prototype.hasOwnProperty.call(t.docStart, file) && t.paras.length ? { i: t.docStart[file], el: null } : null;
}
function epubGo(sess, to) {
	var t = sess.txt, hit = t && epubTarget(t, to);
	if (!hit) return;
	var el = hit.el || paraEl(t, hit.i);
	aim(sess, function () { return window.scrollY + el.getBoundingClientRect().top - headerBottom() - 8; }, sess.track);
	sess.jumpedTo = -1;
	setTimeout(function () { if (!sess.alive || !sess.track) return; sess.jumpedTo = window.scrollY; sess.track(); }, 400);
}
// The book's title, author, series and volume from the EPUB, onto the
// Library's entry. The title only while it's still the one made from the
// file name, so a rename sticks.
function epubDetails(b, meta) {
	var made = b.filename.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim() || b.filename, patch = {};
	if (meta.title && b.title === made && meta.title !== b.title) patch.title = meta.title;
	["author", "series", "volume"].forEach(function (k) { if (meta[k] && meta[k] !== b[k]) patch[k] = meta[k]; });
	if (!Object.keys(patch).length) return Promise.resolve();
	return apiJSON("/api/books/" + b.id, { method: "PATCH", json: patch }).then(function (d) {
		Object.assign(b, d.book);
		keepBookDetails(b);
	});
}

// The contents, from the book menu: tap a chapter to go there. The one
// being read is marked.
function openToc() {
	var sess = session;
	if (!sess || !sess.epub || !sess.txt) return;
	openBookMenu(false);
	showHlList(false);
	showHlPop(false);
	var t = sess.txt, ul = $("tocItems"), cur = null, curBtn = null;
	var here = t.chunks.length ? paraAt(t, txtFraction(t) * t.total) : 0;
	sess.epub.toc.forEach(function (x) { var hit = epubTarget(t, x.to); if (hit.i <= here) cur = x; });
	ul.textContent = "";
	sess.epub.toc.forEach(function (x) {
		var li = h("li"), go = h("button", "tocgo", x.label);
		go.type = "button";
		go.style.paddingLeft = x.depth * 16 + "px";
		if (x === cur) { go.setAttribute("aria-current", "true"); curBtn = go; }
		go.addEventListener("click", function () { show($("tocList"), false); epubGo(sess, x.to); });
		li.append(go);
		ul.append(li);
	});
	show($("tocList"), true);
	if (curBtn) curBtn.scrollIntoView({ block: "center" });
}
$("tocClose").addEventListener("click", function () { show($("tocList"), false); });
$("bmContents").addEventListener("click", function (e) { e.stopPropagation(); openToc(); });
document.addEventListener("click", function (e) {
	if (!$("tocList").hidden && !$("tocList").contains(e.target)) show($("tocList"), false);
});

// ---------- wiring

$("tokenForm").addEventListener("submit", function (e) {
	e.preventDefault();
	var t = $("token").value.trim();
	if (!t) return;
	store("readerToken", t);
	start();
});
$("back").addEventListener("click", goBack);
$("refresh").addEventListener("click", function () { refreshAll(true); });
$("settingsBtn").addEventListener("click", function (e) { e.stopPropagation(); openSettings($("settings").hidden); });
$("bookMenuBtn").addEventListener("click", function (e) { e.stopPropagation(); openBookMenu($("bookMenu").hidden); });
document.addEventListener("click", function (e) {
	if (!$("settings").hidden && !$("settings").contains(e.target)) openSettings(false);
	if (!$("bookMenu").hidden && !$("bookMenu").contains(e.target)) openBookMenu(false);
});
$("bmFinish").addEventListener("click", async function () {
	var sess = session;
	if (!sess) return;
	var on = !sess.book.finished_at;
	openBookMenu(false);
	try {
		await setFinished(sess.book, on);
		if (!on) sess.noAuto = true;
		if (on) finishedToast(sess.book); else toast("Marked as not finished.");
	} catch (e) { fail(e); }
});
$("bmRestart").addEventListener("click", restartBook);
$("markBtn").addEventListener("click", function () { toggleMark(session); });
$("bmToMark").addEventListener("click", function () { openBookMenu(false); if (session) goToSpot(session, here(session).mark); });
$("bmToFar").addEventListener("click", function () { openBookMenu(false); if (session) goToSpot(session, farOf(here(session))); });
$("bmUnmark").addEventListener("click", function () {
	var sess = session;
	openBookMenu(false);
	if (!sess) return;
	var c = here(sess);
	savePosition(sess, spot(c), null);
	toast("Bookmark removed.");
});
$("farGo").addEventListener("click", function () { if (session) goToSpot(session, farOf(here(session))); });
$("farX").addEventListener("click", function () { if (!session) return; session.farHidden = true; show($("farPill"), false); });
$("bmLayout").addEventListener("click", function (e) {
	var x = e.target.closest("button");
	if (!x) return;
	openBookMenu(false);
	setLayout(x.dataset.layout);
});
$("bmGuided").addEventListener("click", function () {
	var on = !guidedOn();
	openBookMenu(false);
	if (session && session.cbz) session.cbz.setGuided(on); else store(GUIDED_KEY, on ? "on" : null);
	toast(on ? "Guided view on. Tap the middle to see the whole page." : "Guided view off.");
});
$("bmDownload").addEventListener("click", function () { if (session) toggleBookDownload(session.book); });
$("bmDelete").addEventListener("click", async function () {
	var sess = session;
	openBookMenu(false);
	if (!sess) return;
	sess.dirty = false;
	if (await deleteBook(sess.book)) location.replace("#/library");
});
$("themes").addEventListener("click", function (e) {
	var t = e.target.closest("button");
	if (!t) return;
	store("readerTheme", t.dataset.theme === "auto" ? null : t.dataset.theme);
	applyTheme(t.dataset.theme);
});
$("smaller").addEventListener("click", function () { applySize(fontSize - 1); store("readerFontSize", String(fontSize)); });
$("larger").addEventListener("click", function () { applySize(fontSize + 1); store("readerFontSize", String(fontSize)); });
$("fonts").addEventListener("click", function (e) {
	var b = e.target.closest("button");
	if (!b) return;
	applyFont(b.dataset.font);
	store("readerFont", readFont === "fraunces" ? "fraunces" : null);
});
$("scrollRead").addEventListener("click", function (e) {
	var b = e.target.closest("button");
	if (!b) return;
	store("readerScrollRead", b.dataset.on || null);
	applyScrollRead(!!b.dataset.on);
});
$("forget").addEventListener("click", function () { store("readerToken", null); openSettings(false); askToken(); });
$("addForm").addEventListener("submit", addFeed);
$("addTag").addEventListener("change", async function () {
	if (this.value !== "new") return;
	try {
		var id = await chosenTag(this);
		fillTagSelect();
		if (id) this.value = String(id);
		renderFeeds();
	} catch (e) { fillTagSelect(); fail(e); }
});
$("uploadTag").addEventListener("change", async function () {
	if (this.value !== "new") return;
	try {
		var t = await promptBookTag();
		fillUploadTag(t ? t.id : null);
	} catch (e) { fillUploadTag(null); fail(e); }
});
$("editFeeds").addEventListener("click", function () { state.editFeeds = !state.editFeeds; renderFeeds(); });
$("editBooks").addEventListener("click", function () { state.editBooks = !state.editBooks; state.libSel = {}; renderBooks(); });
$("libSelAll").addEventListener("click", function () { (state.libShown || []).forEach(function (b) { state.libSel[b.id] = true; }); renderBooks(); });
$("libSelNone").addEventListener("click", function () { state.libSel = {}; renderBooks(); });
$("libSelDel").addEventListener("click", deleteSelected);
$("libSelGenres").addEventListener("click", tagGenresSelected);
$("libSelFill").addEventListener("click", fillSelected);
$("libSelRecord").addEventListener("click", recordSelected);
function libCtx(e) {
	if (e.shiftKey || !e.target.closest) return;
	var s = e.target.closest("a.sgroup");
	if (s && s.group) { e.preventDefault(); return openSeriesCtx(s.group, e.clientX, e.clientY); }
	var a = e.target.closest('a[href^="#/book/"], a[href^="#/record/"]');
	if (!a) return;
	var id = Number(a.getAttribute("href").replace(/^#\/\w+\//, "")), b = libEntry(id);
	if (!b) return;
	e.preventDefault();
	openBookCtx(b, e.clientX, e.clientY);
}
$("books").addEventListener("contextmenu", libCtx);
$("libShelf").addEventListener("contextmenu", libCtx);
document.addEventListener("pointerdown", function (e) { if (!$("bookCtx").hidden && !$("bookCtx").contains(e.target)) closeBookCtx(); }, true);
document.addEventListener("keydown", function (e) {
	if ($("bookCtx").hidden) return;
	if (e.key === "Escape") { e.preventDefault(); closeBookCtx(); return; }
	if (e.key === "ArrowDown" || e.key === "ArrowUp") {
		e.preventDefault();
		var items = Array.prototype.slice.call($("bookCtx").querySelectorAll("button")), i = items.indexOf(document.activeElement);
		items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
	}
}, true);
window.addEventListener("scroll", closeBookCtx, { passive: true });
window.addEventListener("resize", closeBookCtx);
// iOS 26 can lay a home-screen app out taller than the screen, so the last
// part of every page (Previous/Next, the bottom of the feed list) sits below
// the edge where no scrolling reaches it. Upright, the page should never be
// taller than the screen; whatever it's over by is lifted back into view.
function fitScreen() {
	var app = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
	var upright = window.innerHeight > window.innerWidth;
	var lost = app && upright ? Math.max(0, Math.round(window.innerHeight - Math.max(screen.width, screen.height))) : 0;
	document.documentElement.style.setProperty("--lost", lost + "px");
}
fitScreen();
window.addEventListener("resize", fitScreen);
$("bookSearch").addEventListener("input", function () { state.libSearch = this.value; if (state.books) renderBooks(); });
$("bookSort").value = state.libSort;
$("bookSort").addEventListener("change", function () { state.libSort = this.value; store("readerBookSort", this.value === "recent" ? null : this.value); if (state.books) renderBooks(); });
$("bookFormat").value = state.libFormat;
$("bookFormat").addEventListener("change", function () { state.libFormat = this.value; store("readerBookFormat", this.value || null); if (state.books) renderBooks(); });
$("newTag").addEventListener("click", newTag);
$("feedsBox").addEventListener("toggle", function () {
	if (!matchMedia("(min-width: 900px)").matches) store("readerFeedsOpen", this.open ? "1" : null);
});
$("more").addEventListener("click", function () { loadItems(true).catch(fail); });
$("markAll").addEventListener("click", async function () {
	var body = state.feed != null ? { feed: state.feed } : state.tag != null ? { tag: state.tag } : {};
	try {
		await apiJSON("/api/items/mark-read", { method: "POST", json: body });
		await loadFeeds();
		await loadItems(false);
	} catch (e) { fail(e); }
});
$("aSave").addEventListener("click", function () { if (state.item) setFlags(state.item, { saved: state.item.saved ? 0 : 1 }); });
$("aRead").addEventListener("click", function () { if (state.item) setFlags(state.item, { read: state.item.read ? 0 : 1 }); });
$("aFull").addEventListener("click", function () { if (state.item) loadFull(state.item); });
// The system share sheet where there is one (iPhone, Mac, Android); elsewhere, copy the link.
$("aShare").addEventListener("click", async function () {
	var it = state.item;
	if (!it || !it.link) return;
	if (navigator.share) {
		try { await navigator.share({ title: it.title || "", url: it.link }); } catch (e) {}
		return;
	}
	try { await navigator.clipboard.writeText(it.link); toast("Link copied."); }
	catch (e) { prompt("Copy the link:", it.link); }
});
$("uploadBtn").addEventListener("click", function () { $("bookFile").click(); });
$("bookFile").addEventListener("change", function () {
	var files = [].slice.call(this.files);
	this.value = "";
	if (files.length) uploadFiles(files);
});
document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden" && session) flushPosition(session, true); });
window.addEventListener("pagehide", function () { if (session) flushPosition(session, true); });
document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flushRead(true); });
window.addEventListener("pagehide", function () { flushRead(true); });
window.addEventListener("online", function () { sendPendingReads(); });
// A phone keeps a home-screen app open for days, so coming back to it after a
// while fetches the list again: what was read on another device meanwhile
// would otherwise still show here as unread. Waiting read marks go first.
var hiddenAt = 0;
document.addEventListener("visibilitychange", function () {
	if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
	var away = hiddenAt ? Date.now() - hiddenAt : 0;
	hiddenAt = 0;
	if (away < 60 * 1000 || !started || !token()) return;
	resync().catch(function () {});
});
async function resync() {
	await sendPendingReads();
	await loadFeeds();
	if (state.route && LIST_VIEWS[state.route.name]) {
		await loadItems(false);
		window.scrollTo(0, 0);
	} else state.stale = true;
	refreshAll(false);
}
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

async function start() {
	show($("tokenForm"), false);
	show($("app"), true);
	$("feedsBox").open = matchMedia("(min-width: 900px)").matches || read("readerFeedsOpen") === "1";
	try {
		await sendPendingReads();
		await Promise.all([loadTags(), loadFeeds()]);
	} catch (e) {
		if (e.message === UNAUTH) return;
		// No connection, but episodes or books are downloaded: open where they are.
		var kept = Object.keys(downloads).map(function (id) { return downloads[id]; }), books = Object.keys(bookDownloads).length;
		var here = /^#\/(podcasts|videos)/.test(location.hash) ? kept.length : /^#\/(library|book\/)/.test(location.hash) ? books : 0;
		if (here) {}
		else if (kept.length) location.replace(kept.some(isAudio) ? "#/podcasts" : "#/videos");
		else if (books) location.replace("#/library");
		else toast("Couldn't reach the Worker: " + e.message);
	}
	if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {});
	if (!started) { started = true; window.addEventListener("hashchange", route); }
	await route();
	refreshAll(false);
	checkRequests(true);
	if (Object.keys(bookPending).length && !state.books) loadBooks().catch(function () {});
}
// Back online: send places saved while offline, and show the whole Library again.
window.addEventListener("online", function () { if (token()) loadBooks().catch(function () {}); });

// The page lives at "/" and routes by the hash. Opened at a path instead
// (reader.example/book/12), that path is the route: #/book/12.
if (location.pathname !== "/") {
	var atPath = location.pathname.replace(/\/+$/, "");
	history.replaceState(null, "", "/" + location.search + (location.hash || (atPath ? "#" + atPath : "")));
}
applyTheme(read("readerTheme"));
applySize(fontSize);
applyFont(readFont);
applyScrollRead(scrollRead);
if (token()) start(); else askToken();
</script>
</body>
</html>
`;

// Fraunces, SOFT 100 / WONK 0, Latin (see FONTS above): src/fonts/fraunces-soft.woff2 and fraunces-soft-italic.woff2.
const FRAUNCES = "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";
const FRAUNCES_ITALIC = "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";
