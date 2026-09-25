// reader: a private feed and ebook reader for one person. The Worker is a
// thin API -- auth, a fetch proxy, D1 for feeds/tags/items/books, R2 for
// the book files. Everything clever (feed discovery, RSS/Atom/JSON Feed
// parsing, page scraping, article extraction, HTML sanitizing, the PDF
// viewer) happens in the browser, in the page at the bottom of this file.
//
// Bindings / settings (Cloudflare dashboard -> this Worker -> Settings):
//   DB                   D1 database binding -> "reader" (tables: schema.sql)
//   BOOKS                R2 bucket binding -> "reader-books" (kept private)
//   READER_TOKEN         secret; any long random string, entered once on the page
//   ALLOW_PRIVATE_FETCH  dev only: "1" lets /api/fetch reach localhost and
//                        private IPs, for local test fixtures. Never in production.
//
// Routes (everything under /api/ needs "Authorization: Bearer <READER_TOKEN>"):
//   GET    /                       the app page (no data in it; asks for the token)
//   GET    /sw.js                  its service worker: keeps the page for offline use
//   GET    /api/fetch?url=         fetch a feed/page for the browser -> the upstream
//                                  body + Content-Type, and X-Final-URL after redirects
//   GET    /api/tags               -> {"tags": [...]}      (feed tags, A-Z)
//   POST   /api/tags               {name} -> {"tag"} (the existing one if the name is taken)
//   PATCH  /api/tags/:id           {name}
//   DELETE /api/tags/:id           takes it off its feeds; the feeds stay
//   GET/POST /api/booktags, PATCH/DELETE /api/booktags/:id
//                                  the same for book tags, a separate set
//   GET    /api/feeds              -> {"feeds": [...each with an unread count, episodes, videos, articles, and tags: [tag ids]]}
//                                  (podcast episodes and videos aren't in unread, or in Unread/All unless feed= is given)
//   POST   /api/feeds              {url, feed_url, mode, title, site_url, tags?}
//   PATCH  /api/feeds/:id          {title?, feed_url?, mode?, site_url?, tags?}
//                                  (tags: the feed's whole set of tag ids)
//   DELETE /api/feeds/:id          also deletes its items
//   GET    /api/items?view=unread|saved|all|podcasts|videos&feed=&tag=&before=&limit=
//                                  newest first -> {"items", "next"} (tag=0: untagged feeds);
//                                  Unread and All list a story once, with its other items in related
//   POST   /api/items              {feed_id, items: [...]} -- one feed's refresh
//   GET    /api/items/:id          one item, with its content
//   PATCH  /api/items/:id          {read?, saved?, content?, media_pos?, media_len?} (read covers its whole story)
//   POST   /api/items/mark-read    {feed?, tag?}
//   GET    /api/media?url=         a podcast episode's file, streamed through for
//                                  downloading (podcast hosts rarely allow CORS)
//   GET    /api/books              -> {"books": [...each with tags: [book tag ids]]}
//   PUT    /api/books?name=&tag=  body = a .txt, .pdf or .cbz file -> {"book"} (tag: a book tag id to put on it)
//                                  (a file name already in the Library replaces that book's file: {"book", "replaced": true})
//   GET    /api/books/:id/file     the file itself (?dl=1: saving it for offline, so not "opened")
//   PATCH  /api/books/:id          {title?, position?, finished?, opened?, tags?, reread?}
//                                  (reread: fill the details again from a .txt's YAML header)
//                                  (position null = start over)
//   DELETE /api/books/:id          also deletes the file from R2
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

const BOOK_TYPES = { txt: "text/plain; charset=utf-8", pdf: "application/pdf", cbz: "application/vnd.comicbook+zip" };
// A CBZ comic (a zip of page images) is saved with type 'pdf', because the
// live books table only allows 'txt' and 'pdf' and changing that means
// rebuilding the table. Its .cbz file name is what marks it, so the type
// read back from the database comes from that.
const BOOK_TYPE = "CASE WHEN filename LIKE '%.cbz' THEN 'cbz' ELSE type END";
function storedType(ext) { return ext === "cbz" ? "pdf" : ext; }
function bookType(book) { return /\.cbz$/i.test(book.filename) ? "cbz" : book.type; }
// Every book column but r2_key, which never leaves the Worker.
const BOOK_COLUMNS = `id, title, filename, ${BOOK_TYPE} AS type, size, position, finished_at, created_at, last_opened_at, author, series, volume`;
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
		if (url.pathname === "/sw.js" && request.method === "GET") return serviceWorker();
		if (!url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

		if (!(await authorized(request, env))) return json({ error: "Unauthorized" }, 401);

		try {
			return (await api(request, env, url)) || json({ error: "Not found" }, 404);
		} catch (err) {
			if (err instanceof HttpError) return json({ error: err.message }, err.status);
			return json({ error: String(err?.message || err) }, 500);
		}
	},

	async email(message, env) {
		await receiveEmail(message, env);
	},
};

async function authorized(request, env) {
	if (!env.READER_TOKEN) return false;
	const header = request.headers.get("Authorization") || "";
	const given = header.replace(/^Bearer\s+/i, "").trim();
	// Hash both sides so the constant-time compare always sees equal lengths.
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(given)),
		crypto.subtle.digest("SHA-256", enc.encode(env.READER_TOKEN.trim())),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}

async function api(request, env, url) {
	const m = request.method;
	const p = url.pathname;
	let id;

	if (p === "/api/fetch" && m === "GET") return proxyFetch(url.searchParams.get("url"), env);
	if (p === "/api/media" && m === "GET") return proxyMedia(url.searchParams.get("url"), env);

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
	if ((id = matchId(p, "/api/items/"))) {
		if (m === "GET") return getItem(env, id);
		if (m === "PATCH") return updateItem(request, env, id);
	}

	if (p === "/api/books") {
		if (m === "GET") return listBooks(env);
		if (m === "PUT") return uploadBook(request, env, url);
	}
	const file = p.match(/^\/api\/books\/(\d+)\/file$/);
	if (file && m === "GET") return bookFile(env, toId(file[1]), url.searchParams.has("dl"));
	if ((id = matchId(p, "/api/books/"))) {
		if (m === "PATCH") return updateBook(request, env, id);
		if (m === "DELETE") return deleteBook(env, id);
	}
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
async function proxyMedia(raw, env) {
	const allowPrivate = env.ALLOW_PRIVATE_FETCH === "1";
	let target = checkTarget(raw, allowPrivate);
	let res;
	try {
		for (let hop = 0; ; hop++) {
			res = await fetch(target.href, { headers: { "User-Agent": FETCH_HEADERS["User-Agent"], Accept: "audio/*, video/*, */*" }, redirect: "manual" });
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
		throw new HttpError(502, `The site answered ${res.status}`);
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
	return new Response(res.body, { headers });
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
			(SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id AND ${VIEWS.videos}) AS videos,
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
	i.media_url, i.media_type, i.media_pos, i.media_len,
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
		const { results } = await env.DB.prepare(
			`SELECT ${ITEM_LIST_COLUMNS} FROM items i JOIN feeds f ON f.id = i.feed_id
			WHERE ${where.join(" AND ")}
			ORDER BY COALESCE(i.published_at, i.created_at) DESC, i.id DESC LIMIT ?`,
		)
			.bind(...params, limit + 1)
			.all();
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

function itemPage(results, limit) {
	const items = results.slice(0, limit);
	const last = items[items.length - 1];
	return json({ items, next: results.length > limit ? `${last.sort_at}_${last.id}` : null });
}

async function getItem(env, id) {
	const item = await env.DB.prepare(
		`SELECT i.*, f.title AS feed_title, f.site_url FROM items i JOIN feeds f ON f.id = i.feed_id WHERE i.id = ?`,
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
	stmts.push(env.DB.prepare("UPDATE feeds SET last_fetched_at = ? WHERE id = ?").bind(now, feedId));
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
		`SELECT ${BOOK_COLUMNS}, (SELECT json_group_array(t.tag_id) FROM book_tag_links t WHERE t.book_id = books.id) AS tags
		FROM books ORDER BY COALESCE(last_opened_at, created_at) DESC, id DESC`,
	).all();
	for (const b of results) b.tags = JSON.parse(b.tags || "[]");
	return json({ books: results });
}

async function uploadBook(request, env, url) {
	const filename = (url.searchParams.get("name") || "").split(/[\\/]/).pop().trim().slice(0, 300);
	const dot = filename.lastIndexOf(".");
	const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
	if (!BOOK_TYPES[ext]) throw new HttpError(415, "Only .txt, .pdf and .cbz files");
	const tagParam = url.searchParams.get("tag");
	const uploadTags = tagParam ? await tagRefs(env, [tagParam], TAGS.books) : [];

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
	// Same file name as a book already here: that book gets the new file.
	// Its place, Finished and tags stay; a YAML header updates the details.
	const old = await env.DB.prepare("SELECT id, r2_key FROM books WHERE filename = ? COLLATE NOCASE ORDER BY id DESC LIMIT 1")
		.bind(filename)
		.first();
	if (old) {
		try {
			const book = await env.DB.prepare(`UPDATE books SET size = ?, r2_key = ? WHERE id = ? RETURNING ${BOOK_COLUMNS}`)
				.bind(obj.size, key, old.id)
				.first();
			await addBookTags(env, old.id, uploadTags);
			const { results } = await env.DB.prepare("SELECT tag_id FROM book_tag_links WHERE book_id = ?").bind(old.id).all();
			book.tags = results.map((r) => r.tag_id);
			if (ext === "txt") await applyFrontMatter(env, Object.assign(book, { r2_key: key })).catch(() => {});
			delete book.r2_key;
			await env.BOOKS.delete(old.r2_key);
			return json({ book, replaced: true });
		} catch (err) {
			await env.BOOKS.delete(key);
			throw err;
		}
	}
	// "war_and_peace.txt" -> "war and peace"
	const title = filename.slice(0, dot).replace(/[_]+/g, " ").replace(/\s+/g, " ").trim() || filename;
	try {
		const book = await env.DB.prepare(
			`INSERT INTO books (title, filename, type, size, r2_key, created_at)
			VALUES (?, ?, ?, ?, ?, ?) RETURNING ${BOOK_COLUMNS}`,
		)
			.bind(title, filename, storedType(ext), obj.size, key, Date.now())
			.first();
		await addBookTags(env, book.id, uploadTags);
		book.tags = uploadTags;
		if (ext === "txt") await applyFrontMatter(env, book).catch(() => {});
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

async function bookFile(env, id, download) {
	const book = await getBook(env, id);
	const obj = await env.BOOKS.get(book.r2_key);
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
	if (body.reread) {
		const book = await getBook(env, id);
		if (book.type === "txt") await applyFrontMatter(env, book);
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
	const ids = [];
	for (const name of fm.genres) {
		const tag = (await env.DB.prepare("SELECT id FROM book_tags WHERE name = ?").bind(name).first())
			|| (await env.DB.prepare("INSERT INTO book_tags (name, created_at) VALUES (?, ?) RETURNING id").bind(name, Date.now()).first());
		ids.push(tag.id);
	}
	await addBookTags(env, book.id, ids);
	book.tags = [...new Set([...(book.tags || []), ...ids])];
}
function addBookTags(env, bookId, ids) {
	if (!ids.length) return;
	return env.DB.batch(ids.map((t) => env.DB.prepare("INSERT OR IGNORE INTO book_tag_links (book_id, tag_id) VALUES (?, ?)").bind(bookId, t)));
}

async function deleteBook(env, id) {
	const book = await getBook(env, id);
	await env.BOOKS.delete(book.r2_key);
	await env.DB.prepare("DELETE FROM books WHERE id = ?").bind(id).run();
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

function page() {
	const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
	const csp = [
		"default-src 'none'",
		`script-src 'nonce-${nonce}' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/hls.js@1.7.3/`,
		`style-src 'nonce-${nonce}'`,
		"img-src https: data: blob:",
		"font-src data: https://cdn.jsdelivr.net",
		// https: for HLS video (hls.js fetches the stream's pieces itself, from wherever the site hosts them).
		"connect-src 'self' https:",
		"media-src https: blob:",
		"frame-src " + EMBED_HOSTS.map((h) => "https://" + h).join(" "),
		"worker-src 'self' blob: https://cdnjs.cloudflare.com",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
	].join("; ");
	return new Response(PAGE.replaceAll("__NONCE__", nonce), {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": csp,
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "no-cache",
		},
	});
}

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
var PINNED = ["https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/", "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/"];
self.addEventListener("install", function (e) {
	e.waitUntil(caches.open(SHELL).then(function (c) { return c.add("/"); }).catch(function () {}).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
	var req = e.request, url = new URL(req.url);
	if (req.method === "GET" && PINNED.some(function (p) { return req.url.indexOf(p) === 0; })) {
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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Reader">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fbfaf7">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232f5fd0'/%3E%3Cpath d='M9 8h9a5 5 0 0 1 0 10h-9zM9 18v7' stroke='white' stroke-width='3' fill='none'/%3E%3C/svg%3E">
<title>Reader</title>
<style nonce="__NONCE__">
	:root {
		--bg: #fbfaf7; --fg: #1d1c1a; --muted: #6d6a64; --line: #e4e1da; --card: #ffffff; --sel: #ecefe9;
		--accent: #2f5fd0; --on-accent: #fff; --dot: #2f5fd0; --bad: #b3261e; --pdf-page: #ffffff;
		--ok: #17663a; --ok-bg: #dcf0e2;
		--serif: ui-serif, "New York", "Iowan Old Style", Charter, Georgia, serif;
		--sans: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
		--reader-size: 19px;
		color-scheme: light;
	}
	@media (prefers-color-scheme: dark) {
		:root:not([data-theme]) {
			--bg: #141414; --fg: #e7e4de; --muted: #9b978f; --line: #2d2c2a; --card: #1c1c1b; --sel: #2a2a28;
			--accent: #8fb0ff; --on-accent: #10131a; --dot: #8fb0ff; --bad: #ff8a80; --pdf-page: #1f1f1f;
			--ok: #8fdcaa; --ok-bg: #1d3526;
			color-scheme: dark;
		}
	}
	:root[data-theme=dark] {
		--bg: #141414; --fg: #e7e4de; --muted: #9b978f; --line: #2d2c2a; --card: #1c1c1b; --sel: #2a2a28;
		--accent: #8fb0ff; --on-accent: #10131a; --dot: #8fb0ff; --bad: #ff8a80; --pdf-page: #1f1f1f;
		--ok: #8fdcaa; --ok-bg: #1d3526;
		color-scheme: dark;
	}
	:root[data-theme=sepia] {
		--bg: #f4ecd8; --fg: #3b3024; --muted: #7b6c58; --line: #e2d6bb; --card: #f9f2e2; --sel: #eadfc4;
		--accent: #8a4b14; --on-accent: #fff; --dot: #a0551a; --bad: #a3261e; --pdf-page: #f4ecd8;
		--ok: #3f5a12; --ok-bg: #dfe3bd;
		color-scheme: light;
	}
	* { box-sizing: border-box; }
	html { -webkit-text-size-adjust: 100%; }
	body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 var(--sans); }
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
	.bar h1 { flex: 1; min-width: 0; margin: 0; font-size: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.bar .progress { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
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
	.menu { display: grid; gap: 8px; }
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
	.fhead .name { font-weight: 600; }
	.child > .row > a { padding-left: 40px; }
	.flat .child > .row > a { padding-left: 8px; }
	.chev { flex: none; width: 32px; height: 32px; border: 0; background: none; padding: 0; cursor: pointer; color: var(--muted); display: grid; place-items: center; border-radius: 8px; }
	.chev::before { content: ""; width: 7px; height: 7px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(45deg); margin-top: -4px; transition: transform .15s; }
	.chev[aria-expanded=false]::before { transform: rotate(-45deg); margin: 0 0 0 -3px; }
	.tools { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 0 8px 40px; }
	.flat .tools { padding-left: 8px; }
	.ferr { font-size: 13px; color: var(--bad); padding: 0 8px 6px 40px; overflow-wrap: anywhere; }
	.editbar { display: flex; justify-content: space-between; gap: 8px; margin-top: 6px; }
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
	.items .m { grid-column: 2; font-size: 13px; color: var(--muted); margin-top: 3px; }
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

	.article { max-width: 68ch; margin: 0 auto; padding: 20px 16px 96px; font-family: var(--serif); font-size: var(--reader-size); line-height: 1.65; }
	.article .title { font-size: 1.55em; line-height: 1.2; margin: 0 0 .35em; overflow-wrap: anywhere; }
	.article .meta { font: 14px/1.4 var(--sans); color: var(--muted); }
	.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 22px; font-family: var(--sans); }
	.itemnav { display: flex; gap: 8px; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--line); font-family: var(--sans); }
	.itemnav .btn { flex: 1; }
	.itemnav .btn:disabled { visibility: hidden; }
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
	:root[data-theme=dark] .prose svg.chart, :root[data-theme=dark] .prose .player.chart iframe { filter: invert(.88) hue-rotate(180deg); }
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
	.uploads { list-style: none; margin: 8px 0 0; padding: 0; font-size: 14px; }
	.uploads li { padding: 4px 0; overflow-wrap: anywhere; }
	.books .child > .row > a { flex-direction: column; align-items: stretch; gap: 2px; padding-left: 8px; }
	.books .tools { padding-left: 8px; }
	.books .bt { font-weight: 600; overflow-wrap: anywhere; }
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

	.txt { max-width: 68ch; margin: 0 auto; padding: 24px 16px 45vh; font-family: var(--serif); font-size: var(--reader-size); line-height: 1.65; overflow-wrap: break-word; }
	.txt p { margin: 0 0 .9em; white-space: pre-line; }
	.txt .chunk { content-visibility: auto; contain-intrinsic-size: auto 1500px; }
	.pdf { max-width: 920px; margin: 0 auto; padding: 16px 16px 45vh; }
	.pdfpage { position: relative; width: 100%; background: var(--pdf-page); margin: 0 auto 14px; box-shadow: 0 1px 4px rgba(0,0,0,.18); }
	.pdfpage canvas { display: block; width: 100%; height: 100%; }
	.pdfpage .pn { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); color: var(--muted); font-size: 14px; }
	:root[data-theme=dark] .pdfpage canvas { filter: invert(.88) hue-rotate(180deg); }
	@media (prefers-color-scheme: dark) { :root:not([data-theme]) .pdfpage canvas { filter: invert(.88) hue-rotate(180deg); } }
	:root[data-theme=sepia] .pdfpage canvas { filter: sepia(.5) brightness(.96); }
	.cbz { display: flex; flex-direction: column; align-items: center; padding: 8px 0 24px; -webkit-user-select: none; user-select: none; }
	.cbzpage { width: 100%; min-height: 40vh; display: flex; align-items: center; justify-content: center; cursor: pointer; touch-action: pan-y pinch-zoom; }
	.cbzpage img { display: block; width: 100%; height: var(--cbz-h, 80vh); object-fit: contain; }
	.cbz.fitw .cbzpage img { height: auto; max-width: 1100px; }
	.cbzbar { display: flex; align-items: center; gap: 10px; width: 100%; max-width: 640px; padding: 10px 16px 0; font-family: var(--sans); }
	.cbzbar input { flex: 1; min-width: 0; }
	.loading { color: var(--muted); text-align: center; padding: 40px 16px; font-family: var(--sans); }

	/* Podcasts: the episode list, the box atop an episode, the player bar. */
	.eps li { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--line); }
	.eps li > a { flex: 1; min-width: 0; border-bottom: 0; }
	.eps .ep-btns { display: flex; gap: 6px; flex: none; }
	.eps .ep-btns .btn { min-width: 44px; font-variant-numeric: tabular-nums; }
	.episode { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: -8px 0 22px; font-family: var(--sans); }
	.episode video { width: 100%; max-height: 70vh; background: #000; border-radius: 6px; }
	.episode .player { width: 100%; }
	.episode .player iframe { display: block; width: 100%; aspect-ratio: 16 / 9; height: auto; max-height: 70vh; border: 0; border-radius: 6px; background: #000; }
	.episode .when { color: var(--muted); font-size: 14px; font-variant-numeric: tabular-nums; }
	.btn.on { border-color: var(--accent); color: var(--accent); }
	body.has-pbar { padding-bottom: calc(96px + env(safe-area-inset-bottom)); }
	body.has-pbar .toast { bottom: calc(110px + env(safe-area-inset-bottom)); }
	.pbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 15; background: var(--card); border-top: 1px solid var(--line);
		padding: 4px 12px calc(6px + env(safe-area-inset-bottom)); box-shadow: 0 -4px 16px rgba(0,0,0,.08); }
	.pbar input[type=range] { display: block; width: 100%; max-width: 1076px; margin: 0 auto; accent-color: var(--accent); }
	.prow { display: flex; align-items: center; gap: 2px; max-width: 1076px; margin: 0 auto; }
	.ptitle { flex: 1; min-width: 0; display: grid; text-align: left; background: none; border: 0; padding: 4px; cursor: pointer; }
	.ptitle span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	#pName { font-weight: 600; font-size: 14px; }
	.ptime { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
	.prow .btn { min-width: 40px; padding-inline: 6px; font-variant-numeric: tabular-nums; }
	#pPlay { min-width: 48px; border-radius: 50%; min-height: 44px; }
	@media (max-width: 420px) { #pRate, #pClose { padding-inline: 2px; min-width: 32px; } .tabs a { font-size: 14px; } }
	.toast { position: fixed; left: 50%; bottom: calc(20px + env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 30;
		background: var(--fg); color: var(--bg); padding: 10px 14px; border-radius: 10px; font-size: 14px; max-width: calc(100vw - 32px); }
</style>
</head>
<body>
<form id="tokenForm" class="token" hidden>
	<h1>Reader</h1>
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
		<h1 id="heading">Reader</h1>
		<span id="progress" class="progress" hidden></span>
		<button id="refresh" class="btn" type="button">Refresh</button>
		<button id="bookMenuBtn" class="btn" type="button" aria-label="Book options" aria-expanded="false" aria-controls="bookMenu" hidden>&#8943;</button>
		<button id="settingsBtn" class="btn" type="button" aria-label="Display settings" aria-expanded="false" aria-controls="settings">Aa</button>
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
	<div class="seg" id="themes">
		<button type="button" data-theme="auto">Auto</button>
		<button type="button" data-theme="light">Light</button>
		<button type="button" data-theme="dark">Dark</button>
		<button type="button" data-theme="sepia">Sepia</button>
	</div>
	<h2>Text size</h2>
	<div class="seg">
		<button id="smaller" type="button" aria-label="Smaller text">A&minus;</button>
		<span id="sizeVal" class="val">19</span>
		<button id="larger" type="button" aria-label="Larger text">A+</button>
	</div>
	<button id="forget" class="btn ghost small" type="button">Forget token on this device</button>
</div>

<div id="bookMenu" class="pop" hidden>
	<h2>This book</h2>
	<div class="menu">
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
			<div class="editbar">
				<button id="newTag" class="btn small" type="button" hidden>New tag</button>
				<button id="editFeeds" class="btn ghost small" type="button">Edit</button>
			</div>
		</details>
	</aside>
	<div>
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
		<div id="aBody" class="prose"></div>
		<button id="aFull" class="btn wide" type="button" hidden>Load full article</button>
		<nav id="aNav" class="itemnav" aria-label="Other items" hidden>
			<button id="aPrev" class="btn" type="button">&#8592; Previous</button>
			<button id="aNext" class="btn" type="button">Next &#8594;</button>
		</nav>
	</article>
</section>

<section id="podcastsView" class="wrap" hidden>
	<div class="listhead">
		<h2 id="epHead">Podcasts</h2>
		<button id="epFilter" class="btn ghost small" type="button" aria-pressed="false">Downloaded</button>
	</div>
	<div id="epTags" class="tagbar" hidden></div>
	<p id="epNote" class="hint" hidden></p>
	<ul id="episodes" class="items eps"></ul>
	<p id="epEmpty" class="empty" hidden></p>
	<button id="epMore" class="btn wide" type="button" hidden>Load more</button>
</section>

<section id="libraryView" class="wrap" hidden>
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
		<input id="bookFile" class="vh" type="file" accept=".txt,.pdf,.cbz,text/plain,application/pdf,application/vnd.comicbook+zip,application/x-cbz,application/zip" multiple tabindex="-1" aria-hidden="true">
		<div class="hint">.txt, .pdf or .cbz comics, up to 95 MB each. A file with the same name as a book here replaces that book's file. ⤓ keeps a book on this device for reading offline.</div>
		<ul id="uploads" class="uploads"></ul>
	</div>
	<p id="libNote" class="hint" hidden>You're offline. These are the books downloaded on this device; your place syncs when you're back online.</p>
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
	</div>
	<ul id="books" class="tree books flat"></ul>
	<p id="booksEmpty" class="empty" hidden>No books yet. Upload a .txt, .pdf or .cbz to start.</p>
</section>

<section id="bookView" hidden>
	<div id="bookBody"></div>
</section>
</main>
<div id="pbar" class="pbar" hidden>
	<input id="pSeek" type="range" min="0" max="1000" value="0" step="1" aria-label="Position in episode">
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
<div id="toast" class="toast" role="status" hidden></div>
</div>

<script nonce="__NONCE__">
var $ = function (id) { return document.getElementById(id); };
var PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/";
// For HLS (.m3u8) video where the browser can't play it itself (everything but Safari).
var HLSJS = { src: "https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js", integrity: "sha384-cciJ0zi8d1uMKC2zJd7jvPY4HQt7W4ByUI/FlMkltvBi31aW61rcpVBhpmW8/NwX" };
var PDFJS_DATA = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/";
var LIST_VIEWS = { unread: "Unread", saved: "Saved", all: "All" };
// Both share the Podcasts section: same list, tags, downloads and player.
var MEDIA_TABS = { podcasts: "Podcasts", videos: "Videos" };
var STALE_MS = 5 * 60 * 1000; // auto-refresh skips feeds fetched this recently
var CHUNK = 50; // paragraphs per block in the .txt reader
// A .txt book's YAML header; the Worker reads it (parseFrontMatter).
var FRONT_MATTER = /^\s*---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
var UNAUTH = "Unauthorized";

var state = {
	route: null, prev: null, fromList: false, lastList: "#/unread",
	view: "unread", feed: null, tag: null,
	episodes: [], epNext: null, epTag: null, epOffline: false, epDownloadedOnly: false, epKind: "podcasts", itemEp: null, fromPodcasts: false,
	feeds: [], tags: [], books: null, bookTags: readJSON("readerBookTags") || [], libTag: null, libSearch: "", libSort: read("readerBookSort") || "recent",
	items: [], next: null, listKey: "", listScroll: 0, stale: true,
	refreshing: false, errors: {}, editFeeds: false, editBooks: false, item: null
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
function toast(msg) {
	var t = $("toast");
	t.textContent = msg;
	show(t, true);
	clearTimeout(toastTimer);
	toastTimer = setTimeout(function () { show(t, false); }, 4500);
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

function applyTheme(t) {
	var root = document.documentElement;
	if (t === "light" || t === "dark" || t === "sepia") root.setAttribute("data-theme", t);
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
function parseRSS(channel, items, base, kind) {
	return {
		kind: kind, title: plain(kidText(channel, "title")), siteUrl: rssLink(channel, base) || base,
		items: items.map(function (it) {
			var link = rssLink(it, base);
			var g = kid(it, "guid"), guid = g ? g.textContent.trim() : "";
			if (!link && guid && g.getAttribute("isPermaLink") !== "false") link = absUrl(guid, base);
			var content = kidText(it, "encoded") || kidText(it, "description");
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
	return { mode: "feed", url: typed, feed_url: feedUrl, title: feed.title || hostOf(feed.siteUrl), site_url: feed.siteUrl, kind: feed.kind, items: feed.items };
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
// A podcast or video channel: at least half its items are episodes or
// videos (the same bar that gives a new one its channel tag).
function isMediaFeed(f) { var m = (f.episodes || 0) + (f.videos || 0); return m > 0 && m >= (f.articles || 0); }
// A tag only podcast or video channels carry. These stay out of the news
// tabs' tag list and switches, and show under Podcasts and Videos instead.
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
	if (state.feeds.some(function (f) { return !f.tags.length; })) list.push({ id: 0, name: "Untagged", cls: "untagged" });
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

	var shown = state.tag == null ? state.feeds : state.feeds.filter(function (f) { return hasTag(f, state.tag); });
	shown.forEach(function (f) { ul.append(feedRow(f, view)); });
	if (state.tag != null && !shown.length) ul.append(h("li", "hint", state.tag ? "No feeds have this tag." : "Every feed has a tag."));
	$("feedCount").textContent = state.feeds.length ? "(" + state.feeds.length + ")" : "";
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
		var r = await discover(input);
		var data = await apiJSON("/api/feeds", { method: "POST", json: {
			url: r.url, feed_url: r.feed_url, mode: r.mode, title: r.title, site_url: r.site_url, tags: tagId ? [tagId] : []
		} });
		var what = r.mode === "feed" ? "RSS feed found (" + r.kind + "): " : "No feed, watching the page: ";
		if (data.existing) { addStatus("Already following " + data.feed.title + "."); return; }
		var saved = await saveItems(data.feed.id, r.items);
		var channel = await tagChannel(data.feed, r.items);
		addStatus(what + data.feed.title + " — " + saved.inserted + " item" + (saved.inserted === 1 ? "" : "s")
			+ (channel ? ", tagged “" + channel + "”." : "."));
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
// A new podcast or video channel gets a tag named after it, so the Podcasts
// and Videos tabs can pick it out with a pill. Only when most of what the
// feed lists is audio or video, so a news site with one clip stays untagged.
// Naming an existing tag reuses it. Returns the tag's name, or null.
async function tagChannel(feed, items) {
	var media = items.filter(function (it) { return it.media_url; }).length;
	if (!media || media * 2 < items.length) return null;
	try {
		var name = feed.title.trim().slice(0, 80);
		var tag = (await apiJSON("/api/tags", { method: "POST", json: { name: name } })).tag;
		var ids = (feed.tags || []).slice();
		if (ids.indexOf(tag.id) < 0) {
			ids.push(tag.id);
			await apiJSON("/api/feeds/" + feed.id, { method: "PATCH", json: { tags: ids } });
		}
		await loadTags();
		return tag.name;
	} catch (e) {
		return null;
	}
}
// The Add form's tag: its id, or null for none. "New tag…" asks for a name.
async function chosenTag(sel) {
	if (sel.value !== "new") return Number(sel.value) || null;
	var t = await promptTag();
	return t ? t.id : null;
}
function saveItems(feedId, items) {
	var clean = items.filter(function (it) { return it.guid; }).slice(0, 200).map(function (it) {
		return {
			guid: String(it.guid).slice(0, 2000), title: it.title || "", link: it.link || null, author: it.author || null,
			published_at: it.published_at || null, content: it.content && it.content.length <= 400000 ? it.content : null,
			media_url: it.media_url || null, media_type: it.media_type || null
		};
	});
	return apiJSON("/api/items", { method: "POST", json: { feed_id: feedId, items: clean } });
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
		if (state.route && MEDIA_TABS[state.route.name]) await loadEpisodes(false);
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
		} else {
			var pg = await proxyGet(f.site_url || f.url);
			items = scrape(pg.text, pg.url).items;
		}
		await saveItems(f.id, items);
		delete state.errors[f.id];
	} catch (e) {
		if (e.message === UNAUTH) throw e;
		state.errors[f.id] = e.message;
	}
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
	state.items = append ? state.items.concat(data.items) : data.items;
	state.next = data.next;
	state.listKey = listKeyNow();
	state.stale = false;
	renderItems();
	if (keepScroll) window.scrollTo(0, y);
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
function renderTabs(name) {
	var sub = listQuery(state.feed, state.tag);
	document.querySelectorAll("#tabs a").forEach(function (a) {
		var v = a.dataset.view;
		a.href = "#/" + v + (LIST_VIEWS[v] ? sub : v === "library" && state.libTag != null ? "?tag=" + state.libTag
			: v === state.epKind && state.epTag != null ? "?tag=" + state.epTag : "");
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
		feed: num(params.get("feed")), tag: num(params.get("tag"))
	};
}
function showView(name) {
	["list", "article", "podcasts", "library", "book"].forEach(function (v) { show($(v + "View"), v === name); });
	var top = name === "list" || name === "podcasts" || name === "library";
	show($("tabs"), top);
	show($("back"), !top);
	show($("refresh"), name === "list" || name === "podcasts");
	show($("progress"), name === "book");
	show($("bookMenuBtn"), name === "book");
	$("heading").textContent = top ? "Reader" : "";
}
async function route() {
	var r = parseHash(), prev = state.route;
	if (prev && LIST_VIEWS[prev.name]) state.listScroll = window.scrollY;
	// Stepping from item to item replaces the entry, so Back still goes to the list.
	if (!(prev && prev.name === "item" && r.name === "item")) {
		state.fromList = !!(prev && (LIST_VIEWS[prev.name] || prev.name === "library" || MEDIA_TABS[prev.name]));
		state.fromPodcasts = !!(prev && MEDIA_TABS[prev.name]);
	}
	state.prev = prev;
	state.route = r;
	videoBox.close();
	closeBook();
	openSettings(false);
	openBookMenu(false);
	state.item = null;
	try {
		if (LIST_VIEWS[r.name]) return await showList(r, prev);
		if (r.name === "library") return await showLibrary(r);
		if (MEDIA_TABS[r.name]) return await showPodcasts(r);
		if (r.name === "item" && r.id) return await openItem(r.id);
		if (r.name === "book" && r.id) return await openBook(r.id);
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
	var back = prev && prev.name === "item" && state.listKey === listKeyNow();
	if (back && !state.stale) {
		renderItems();
		window.scrollTo(0, state.listScroll);
		return;
	}
	if (!back) { window.scrollTo(0, 0); state.items = []; }
	await loadItems(false);
	if (back) window.scrollTo(0, state.listScroll);
}
function goBack() {
	if (state.fromList) history.back();
	else location.hash = state.route && state.route.name === "book" ? "#/library" : state.lastList;
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
	try {
		await apiJSON("/api/items/" + it.id, { method: "PATCH", json: patch });
	} catch (e) {
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
	if (patch.read != null && feed && !!patch.read !== !!wasRead) feed.unread += patch.read ? -1 : 1;
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
		media_type: it.media_type || "audio/mpeg", media_pos: it.media_pos, media_len: it.media_len, published_at: it.published_at, created_at: it.created_at };
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

// Podcasts tab
async function showPodcasts(r) {
	var changed = !sameId(state.epTag, r.tag) || state.epKind !== r.name;
	if (state.epKind !== r.name) state.episodes = [];
	state.epKind = r.name;
	state.epTag = r.tag;
	showView("podcasts");
	renderTabs(r.name);
	$("epHead").textContent = MEDIA_TABS[r.name];
	document.title = MEDIA_TABS[r.name] + " — Reader";
	renderEpisodeTags();
	if (!changed && state.episodes.length && state.prev && state.prev.name === "item") { renderEpisodes(); return; }
	window.scrollTo(0, 0);
	await loadEpisodes(false);
}
async function loadEpisodes(append) {
	if (state.epDownloadedOnly) { state.episodes = downloadedList(); state.epNext = null; state.epOffline = false; renderEpisodes(); return; }
	if (!append && !state.episodes.length) { $("epEmpty").textContent = "Loading…"; show($("epEmpty"), true); }
	try {
		var data = await apiJSON("/api/items?view=" + state.epKind + "&limit=50" + (state.epTag != null ? "&tag=" + state.epTag : "") +
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
			if (state.epTag == null) return true;
			var f = state.feeds.filter(function (x) { return x.id === ep.feed_id; })[0];
			return f ? hasTag(f, state.epTag) : false;
		})
		.sort(function (a, b) { return (b.published_at || b.created_at || 0) - (a.published_at || a.created_at || 0); });
}
// Tags that have a podcast (or video) on them, as a filter like the feed list's.
function renderEpisodeTags() {
	var kind = state.epKind, box = $("epTags");
	var pods = state.feeds.filter(function (f) { return (kind === "videos" ? f.videos : f.episodes) > 0; });
	box.textContent = "";
	var list = state.tags.filter(function (t) { return pods.some(function (f) { return hasTag(f, t.id); }); })
		.map(function (t) { return { id: t.id, name: t.name, cls: tagColor(t.id) }; });
	if (list.length && pods.some(function (f) { return !f.tags.length; })) list.push({ id: 0, name: "Untagged", cls: "untagged" });
	show(box, list.length > 0);
	box.classList.toggle("filtering", state.epTag != null);
	var chips = h("div", "chips");
	chips.setAttribute("aria-label", "Tags");
	list.forEach(function (x) {
		var on = sameId(state.epTag, x.id), c = chip(x.name, x.cls);
		c.href = on ? "#/" + kind : "#/" + kind + "?tag=" + x.id;
		if (on) c.setAttribute("aria-current", "true");
		chips.append(c);
	});
	box.append(chips);
}
function renderEpisodes() {
	renderEpisodeTags();
	var ul = $("episodes");
	ul.textContent = "";
	state.episodes.forEach(function (ep) {
		var li = h("li", epPlayed(ep) ? "read" : ""), a = h("a");
		li.dataset.id = ep.id;
		a.href = "#/item/" + ep.id;
		var dot = h("span", "dot");
		a.append(dot, h("span", "t", ep.title));
		a.append(h("span", "m", [ep.feed_title, ago(ep.published_at || ep.created_at), epStatus(ep)].filter(Boolean).join(" · ")));
		var btns = h("div", "ep-btns");
		btns.append(playButton(ep, true));
		if (!isHosted(ep)) btns.append(downloadButton(ep, true));
		li.append(a, btns);
		ul.append(li);
	});
	$("epEmpty").textContent = state.epDownloadedOnly ? "Nothing downloaded on this device."
		: state.epOffline ? "You're offline, and nothing is downloaded on this device."
		: state.epKind === "videos" ? "No videos yet. Add a YouTube channel, or another video feed, to get started."
		: "No episodes yet. Add a podcast's feed to get started.";
	show($("epEmpty"), !state.episodes.length);
	show($("epMore"), !!state.epNext);
	$("epNote").textContent = state.epOffline ? "You're offline. These are the ones downloaded on this device." : "";
	show($("epNote"), state.epOffline && !!state.episodes.length);
	$("epFilter").setAttribute("aria-pressed", String(!!state.epDownloadedOnly));
	$("epFilter").classList.toggle("on", !!state.epDownloadedOnly);
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
		m.textContent = [ep.feed_title, ago(ep.published_at || ep.created_at), epStatus(ep)].filter(Boolean).join(" · ");
	});
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
	if (isAudio(ep)) box.append(playButton(ep, false), downloadButton(ep, false), h("span", "when", epStatus(ep)));
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
async function episodeSrc(ep) {
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

// The player bar
var player = { ep: null, url: null, savedAt: 0, rate: Number(read("readerRate")) || 1 };
var RATES = [0.8, 1, 1.2, 1.5, 1.75, 2];
async function playEpisode(ep, start) {
	var audio = $("pAudio");
	if (!isAudio(ep)) { location.hash = "#/item/" + ep.id; return; }
	if (player.ep && player.ep.id === ep.id && audio.src) {
		if (start && audio.paused) await audio.play().catch(playFailed); else if (start) audio.pause();
		return;
	}
	if (player.ep) saveEpisodePos(true);
	player.ep = ep;
	store("readerNowPlaying", JSON.stringify(ep));
	var src = await episodeSrc(ep);
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
	toast(navigator.onLine === false && !downloads[player.ep && player.ep.id] ? "You're offline, and this episode isn't downloaded." : "Couldn't play this episode.");
}
function renderPlayer() {
	var ep = player.ep, audio = $("pAudio");
	show($("pbar"), !!ep);
	document.body.classList.toggle("has-pbar", !!ep);
	if (!ep) return;
	var dur = audio.duration || epLen(ep), pos = audio.currentTime || 0;
	$("pName").textContent = ep.title;
	$("pTime").textContent = (ep.feed_title ? ep.feed_title + " · " : "") + clock(pos) + (dur ? " / " + clock(dur) : "");
	if (!state.seeking) $("pSeek").value = dur ? Math.round(pos / dur * 1000) : 0;
	$("pPlay").innerHTML = audio.paused ? "&#9654;" : "&#10074;&#10074;";
	$("pPlay").setAttribute("aria-label", audio.paused ? "Play" : "Pause");
	$("pRate").textContent = player.rate + "×";
}
function setSession(ep) {
	if (!("mediaSession" in navigator)) return;
	try {
		navigator.mediaSession.metadata = new MediaMetadata({ title: ep.title, artist: ep.feed_title || "", album: "Reader" });
	} catch (e) {}
}
function skip(by) {
	var audio = $("pAudio");
	if (!audio.src) return;
	audio.currentTime = clamp(audio.currentTime + by, 0, audio.duration || 1e9);
	renderPlayer();
}
// On this device at once; on the item every 15 seconds of listening, and on
// pause, end, or leaving the page.
function saveEpisodePos(now) {
	var audio = $("pAudio");
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
		audio.addEventListener(t, function () { renderPlayer(); if (player.ep) repaintEpisode(player.ep.id); });
	});
	audio.addEventListener("timeupdate", function () { renderPlayer(); saveEpisodePos(false); });
	audio.addEventListener("pause", function () { saveEpisodePos(true); });
	audio.addEventListener("ended", function () { saveEpisodePos(true); if (player.ep) repaintEpisode(player.ep.id); });
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
		var id = player.ep && player.ep.id;
		player.ep = null;
		audio.removeAttribute("src");
		audio.load();
		store("readerNowPlaying", null);
		renderPlayer();
		if (id) repaintEpisode(id);
	});
	$("pTitle").addEventListener("click", function () { if (player.ep) location.hash = "#/item/" + player.ep.id; });
	$("pSeek").addEventListener("input", function () {
		state.seeking = true;
		var dur = audio.duration || epLen(player.ep || {});
		if (dur) $("pTime").textContent = clock(this.value / 1000 * dur) + " / " + clock(dur);
	});
	$("pSeek").addEventListener("change", function () {
		state.seeking = false;
		if (audio.duration) audio.currentTime = this.value / 1000 * audio.duration;
	});
	$("epMore").addEventListener("click", function () { loadEpisodes(true).catch(fail); });
	$("epFilter").addEventListener("click", function () {
		state.epDownloadedOnly = !state.epDownloadedOnly;
		loadEpisodes(false).catch(fail);
	});
	if ("mediaSession" in navigator) {
		var on = function (name, fn) { try { navigator.mediaSession.setActionHandler(name, fn); } catch (e) {} };
		on("play", function () { audio.play().catch(playFailed); });
		on("pause", function () { audio.pause(); });
		on("seekbackward", function (d) { skip(-((d && d.seekOffset) || 15)); });
		on("seekforward", function (d) { skip((d && d.seekOffset) || 30); });
		on("seekto", function (d) { if (d && d.seekTime != null) audio.currentTime = d.seekTime; });
	}
	window.addEventListener("pagehide", function () { saveEpisodePos(true); videoBox.close(); });
	// Back where you left off: the last episode, paused.
	var last = readJSON("readerNowPlaying");
	if (last && last.id && last.media_url) { player.ep = last; renderPlayer(); }
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
	state.libTag = r.tag;
	fillUploadTag(r.tag);
	showView("library");
	renderTabs("library");
	document.title = "Library — Reader";
	if (state.books) renderBooks();
	await Promise.all([loadBooks(), loadBookTags()]);
}

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
function renderBookTags() {
	fillUploadTag();
	var box = $("bookTags"), edit = state.editBooks, sel = state.libTag, books = state.books || [];
	box.textContent = "";
	var list = state.bookTags.map(function (t) { return { id: t.id, name: t.name, cls: tagColor(t.id) }; });
	if (list.length && books.some(function (b) { return !bookTagsOf(b).length; })) list.push({ id: 0, name: "Untagged", cls: "untagged" });
	show(box, list.length > 0 || edit);
	box.classList.toggle("filtering", sel != null);
	var chips = h("div", "chips");
	chips.setAttribute("aria-label", "Book tags");
	list.forEach(function (x) {
		var on = sameId(sel, x.id), c = chip(x.name, x.cls);
		var n = books.filter(function (b) { return hasBookTag(b, x.id); }).length;
		if (n) c.append(h("span", "n", String(n)));
		c.href = on ? "#/library" : "#/library?tag=" + x.id;
		if (on) c.setAttribute("aria-current", "true");
		chips.append(c);
	});
	box.append(chips);
	if (!edit) return;
	var t = sel ? bookTagById(sel) : null, tools = h("div", "tools");
	if (t) tools.append(
		button("Rename “" + t.name + "”", "btn small", function () { renameBookTag(t); }),
		button("Delete tag", "btn small", function () { deleteBookTag(t); })
	);
	tools.append(button("New tag", "btn small", function () { promptBookTag().then(function () { renderBooks(); }, fail); }));
	box.append(tools);
	if (!t && state.bookTags.length) box.append(h("div", "hint", "Pick a tag to rename or delete it."));
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
		if (sameId(state.libTag, t.id)) location.hash = "#/library";
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
		if (p.position === undefined && p.finished === undefined && !p.opened) delete bookPending[b.id];
	});
	saveBookPending();
}
function pendingBody(p) {
	var body = {};
	if (p.position !== undefined) body.position = p.position;
	if (p.finished !== undefined) body.finished = !!p.finished;
	if (p.opened) body.opened = true;
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
	var ul = $("books"), books = state.books || [], edit = state.editBooks, tag = state.libTag;
	ul.textContent = "";
	renderBookTags();
	if (tag != null) books = books.filter(function (b) { return hasBookTag(b, tag); });
	var tagged = books.length;
	books = sortBooks(books.filter(bookMatches(state.libSearch)), state.libSort);
	$("libTitle").textContent = tag != null ? "Library · " + (tag === 0 ? "Untagged" : (bookTagById(tag) || {}).name || "") : "Library";
	books.forEach(function (b) { ul.append(bookRow(b)); });
	var off = !!state.libOffline;
	$("booksEmpty").textContent = tagged && !books.length ? "No books match “" + state.libSearch.trim() + "”."
		: tag != null && (state.books || []).length ? "No books with this tag."
		: off ? "You're offline, and no books are downloaded on this device." : "No books yet. Upload a .txt, .pdf or .cbz to start.";
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
		var hay = fold([b.title, b.author, b.series, b.filename].join(" "));
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
function bookRow(b) {
	var li = h("li", "child"), row = h("div", "row"), a = h("a");
	a.href = "#/book/" + b.id;
	var pos = parsePos(b.position), pct = pos && pos.f ? Math.round(pos.f * 100) : 0;
	var meta = [b.type.toUpperCase(), bytes(b.size)];
	if (pos && b.type !== "txt" && pos.page) meta.push("p. " + pos.page + (pos.pages ? " of " + pos.pages : ""));
	else if (pct) meta.push(pct + "%");
	if (b.last_opened_at) meta.push("opened " + ago(b.last_opened_at));
	var bar = h("div", "bar-prog"), fill = h("span");
	fill.style.width = pct + "%";
	bar.append(fill);
	var title = h("span", "bt", b.title);
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
	row.append(a);
	if (!state.editBooks && window.caches) row.append(bookDlButton(b));
	li.append(row);
	if (state.editBooks) {
		var t = h("div", "tools");
		t.append(
			button("Rename", "btn small", async function () {
				var name = prompt("Rename book", b.title);
				if (!name || !name.trim()) return;
				try { await apiJSON("/api/books/" + b.id, { method: "PATCH", json: { title: name.trim() } }); await loadBooks(); } catch (e) { fail(e); }
			}),
			button(b.finished_at ? "Mark unfinished" : "Mark finished", "btn small", async function () {
				try { await setFinished(b, !b.finished_at); } catch (e) { fail(e); }
				renderBooks();
			}),
			button("Start over", "btn small", async function () {
				if (!confirmStartOver(b)) return;
				try { await resetPosition(b); } catch (e) { fail(e); }
				renderBooks();
			}),
			button("Delete", "btn small", function () { deleteBook(b); })
		);
		li.append(t, bookTagToggles(b));
	}
	return li;
}
// Deletes the book and its file for good, and this device's download of it.
async function deleteBook(b) {
	if (!confirm("Delete “" + b.title + "”? The file is removed for good, from every device.")) return false;
	try {
		await apiJSON("/api/books/" + b.id, { method: "DELETE" });
		forgetBookDownload(b.id);
		saveBookDownloads();
		delete bookPending[b.id];
		saveBookPending();
		await loadBooks();
		return true;
	} catch (e) { fail(e); return false; }
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
// The beginning, as a saved place (with its time, so it syncs like one).
async function resetPosition(b) {
	setPosition(b, JSON.stringify({ at: Date.now() }));
}
async function uploadFiles(files) {
	var tagId = Number($("uploadTag").value) || null;
	for (var i = 0; i < files.length; i++) await uploadOne(files[i], tagId);
	await Promise.all([loadBooks(), loadBookTags()]).catch(fail);
}
// XHR rather than fetch, for an upload progress readout on big PDFs.
function uploadOne(file, tagId) {
	return new Promise(function (resolve) {
		var li = h("li", "", file.name + " …");
		$("uploads").append(li);
		var done = function (ok, msg) { li.textContent = (ok ? "✓ " : "✗ ") + file.name + (msg ? ": " + msg : ""); li.className = ok ? "" : "err"; resolve(); };
		if (!/\.(txt|pdf|cbz)$/i.test(file.name)) return done(false, "only .txt, .pdf and .cbz files");
		if (file.size > 95 * 1024 * 1024) return done(false, "over 95 MB");
		if (/\.cbz$/i.test(file.name)) {
			// A CBR renamed to .cbz is still a RAR inside, which can't be opened here.
			file.slice(0, 4).arrayBuffer().then(function (buf) {
				var sig = String.fromCharCode.apply(null, new Uint8Array(buf));
				if (sig === "Rar!") return done(false, "this is a RAR (CBR) file inside; convert it to CBZ first");
				if (sig.slice(0, 2) !== "PK") return done(false, "not a zip file, so not a CBZ");
				send();
			}, function () { done(false, "couldn't read the file"); });
		} else send();
		function send() {
			var xhr = new XMLHttpRequest();
			xhr.open("PUT", "/api/books?name=" + encodeURIComponent(file.name) + (tagId ? "&tag=" + tagId : ""));
			xhr.setRequestHeader("Authorization", "Bearer " + token());
			xhr.upload.onprogress = function (e) { if (e.lengthComputable) li.textContent = file.name + " … " + Math.round(e.loaded / e.total * 100) + "%"; };
			xhr.onload = function () {
				if (xhr.status === 401) { store("readerToken", null); askToken("That token didn't work."); return done(false, "unauthorized"); }
				var data = {};
				try { data = JSON.parse(xhr.responseText); } catch (e) {}
				if (xhr.status >= 300) return done(false, data.error || "HTTP " + xhr.status);
				done(true, data.replaced ? "replaced the file of “" + data.book.title + "”" : "");
				// A downloaded copy is the old file now: fetch the new one.
				if (data.replaced && bookDownloads[data.book.id]) {
					forgetBookDownload(data.book.id);
					saveBookDownloads();
					downloadBook(data.book);
				}
			};
			xhr.onerror = function () { done(false, "network error"); };
			xhr.send(file);
		}
	});
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
	var sess = session = { id: id, book: book, alive: true, cleanup: [], dirty: false };
	$("heading").textContent = book.title;
	document.title = book.title + " — Reader";
	$("progress").textContent = "";
	try {
		if (book.type === "pdf") await openPdf(sess, parsePos(book.position) || {});
		else if (book.type === "cbz") await openCbz(sess, parsePos(book.position) || {});
		else await openTxt(sess, parsePos(book.position) || {});
	} catch (e) {
		if (!sess.alive) return;
		body.textContent = "";
		body.append(h("p", "loading err", e.message));
	}
}
function closeBook() {
	var s = session;
	if (!s) return;
	session = null;
	s.alive = false;
	flushPosition(s);
	s.cleanup.forEach(function (fn) { try { fn(); } catch (e) {} });
	$("bookBody").textContent = "";
	document.title = "Reader";
}
function savePosition(sess, pos, label) {
	sess.pos = Object.assign(pos, { at: Date.now() });
	sess.dirty = true;
	$("progress").textContent = label;
	clearTimeout(sess.timer);
	sess.timer = setTimeout(function () { flushPosition(sess); }, 800);
}
function flushPosition(sess, keepalive) {
	clearTimeout(sess.timer);
	if (!sess.dirty) return;
	sess.dirty = false;
	setPosition(sess.book, JSON.stringify(sess.pos), keepalive);
}
// Reaching the end marks a book finished: the last line of a .txt, the
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
	setFinished(sess.book, true).then(function () { if (sess.alive) toast("Marked as finished."); }, fail);
}
function renderBookMenu() {
	var b = session && session.book;
	if (!b) return;
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
	$("progress").textContent = sess.pdf ? "1 / " + sess.pdf.n : sess.cbz ? "1 / " + sess.cbz.n : "0%";
	try { await resetPosition(sess.book); } catch (e) { fail(e); }
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
	var t = sess.txt = { paras: paras, starts: starts, total: Math.max(total, 1), chunks: chunks };
	estimateChunks(t);
	sess.capture = function () { return txtFraction(t); };
	sess.relayout = function (f) { estimateChunks(t); restoreTxt(sess, f); };
	var track = function () {
		if (sess.restoring || !t.chunks.length) return;
		var f = txtFraction(t);
		savePosition(sess, { f: Math.round(f * 1e5) / 1e5 }, Math.round(f * 100) + "%");
		checkEnd(sess, chunks[chunks.length - 1].lastElementChild);
	};
	sess.track = track;
	restoreTxt(sess, pos.f || 0);
	listen(sess, window, "scroll", onScrollFrame(track), { passive: true });
	listen(sess, window, "resize", onScrollFrame(function () { estimateChunks(t); }));
	$("progress").textContent = Math.round((pos.f || 0) * 100) + "%";
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
		savePosition(sess, { page: c.page, pf: Math.round(c.within * 1000) / 1000, pages: pdf.n, f: Math.round((c.page - 1 + c.within) / pdf.n * 1e4) / 1e4 },
			c.page + " / " + pdf.n);
		checkEnd(sess, pages[pages.length - 1]);
	};
	listen(sess, window, "scroll", onScrollFrame(track), { passive: true });
	var resizeTimer;
	listen(sess, window, "resize", function () {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(function () { pages.forEach(function (p) { if (p.want) renderPdfPage(sess, p); }); }, 250);
	});
	var page = clamp(pos.page || 1, 1, pdf.n);
	$("progress").textContent = page + " / " + pdf.n;
	if (page > 1 || pos.pf > 0) aim(sess, function () {
		var r = pages[page - 1].getBoundingClientRect();
		return window.scrollY + r.top + (pos.pf || 0) * r.height - headerBottom();
	}, track);
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
// -> [{name, method, offset, csize, type}] for the page images, in reading order.
function readZip(buf) {
	var u8 = new Uint8Array(buf), dv = new DataView(buf), end = -1;
	for (var i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
	if (end < 0) throw new Error("This isn't a zip file, so it can't be read as a CBZ.");
	var count = dv.getUint16(end + 10, true), at = dv.getUint32(end + 16, true);
	// Zip64: the real count and start are in a second record.
	if ((count === 0xffff || at === 0xffffffff) && end >= 20 && dv.getUint32(end - 20, true) === 0x07064b50) {
		var z = Number(dv.getBigUint64(end - 12, true));
		count = Number(dv.getBigUint64(z + 32, true));
		at = Number(dv.getBigUint64(z + 48, true));
	}
	var names = new TextDecoder("utf-8"), pages = [];
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
		var ext = (/\.(\w+)$/.exec(name) || [])[1];
		var type = ext && CBZ_IMAGES[ext.toLowerCase()];
		if (!type || /(^|\/)(__MACOSX\/|\.)/.test(name)) continue;
		if (flags & 1) throw new Error("This comic is password-protected, so it can't be opened.");
		if (method !== 0 && method !== 8) throw new Error("This comic uses a kind of zip compression the reader can't unpack.");
		if (local + 30 > u8.length || dv.getUint32(local, true) !== 0x04034b50) continue;
		var offset = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
		pages.push({ name: name, method: method, offset: offset, csize: csize, type: type });
	}
	pages.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }); });
	return pages;
}
async function zipEntryBlob(u8, e) {
	var data = u8.subarray(e.offset, e.offset + e.csize);
	if (e.method === 0) return new Blob([data], { type: e.type });
	if (!window.DecompressionStream) throw new Error("This browser is too old to unpack this comic.");
	var out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
	return new Blob([out], { type: e.type });
}
async function openCbz(sess, pos) {
	var res = await bookFileRes(sess.book);
	var buf = await res.arrayBuffer();
	if (!sess.alive) return;
	var u8 = new Uint8Array(buf), pages = readZip(buf), n = pages.length;
	if (!n) throw new Error("No page images in this comic.");
	var body = $("bookBody");
	body.textContent = "";
	body.className = "cbz" + (read("readerComicFit") === "width" ? " fitw" : "");
	var box = h("div", "cbzpage"), img = h("img");
	img.alt = "";
	box.append(img);
	var prev = button("‹", "btn", function () { go(cur - 1, true); }), next = button("›", "btn", function () { go(cur + 1, true); });
	prev.setAttribute("aria-label", "Previous page");
	next.setAttribute("aria-label", "Next page");
	var slider = h("input");
	slider.type = "range";
	slider.min = 1;
	slider.max = n;
	slider.setAttribute("aria-label", "Page");
	slider.addEventListener("change", function () { go(Number(slider.value), true); });
	var bar = h("div", "cbzbar");
	bar.append(prev, slider, next);
	body.append(box, bar);
	var urls = {}, cur = 0;
	function url(i) {
		if (!urls[i]) urls[i] = zipEntryBlob(u8, pages[i - 1]).then(function (b) { return URL.createObjectURL(b); });
		return urls[i];
	}
	// Keeps two pages back and three ahead unpacked; lets the rest go.
	function keepNear(c) {
		Object.keys(urls).forEach(function (k) {
			if (k < c - 2 || k > c + 3) { urls[k].then(URL.revokeObjectURL, function () {}); delete urls[k]; }
		});
		for (var k = c + 1; k <= Math.min(n, c + 3); k++) url(k).catch(function () {});
	}
	// byReader: a turn the reader made (saved, and can mark the comic finished),
	// not the saved place being put back.
	async function go(i, byReader) {
		i = clamp(i, 1, n);
		if (i === cur) return;
		cur = i;
		slider.value = i;
		prev.disabled = i === 1;
		next.disabled = i === n;
		$("progress").textContent = i + " / " + n;
		if (byReader) {
			savePosition(sess, { page: i, pages: n, f: Math.round(i / n * 1e4) / 1e4 }, i + " / " + n);
			if (i === n) reachedEnd(sess);
		}
		keepNear(i);
		try {
			var src = await url(i);
			if (!sess.alive || cur !== i) return;
			img.src = src;
			img.alt = "Page " + i;
			if (byReader) window.scrollTo(0, 0);
		} catch (e) {
			if (sess.alive && cur === i) toast("Couldn't show page " + i + ": " + e.message);
		}
	}
	sess.cbz = { n: n, go: go };
	function fit() { body.style.setProperty("--cbz-h", Math.max(200, window.innerHeight - headerBottom() - bar.offsetHeight - 24) + "px"); }
	fit();
	listen(sess, window, "resize", onScrollFrame(fit));
	// Tap the left or right side to turn; the middle switches between the
	// whole page on screen and page width (scroll down for the rest).
	listen(sess, box, "click", function (e) {
		var x = e.clientX / window.innerWidth;
		if (x < 0.35) go(cur - 1, true);
		else if (x > 0.65) go(cur + 1, true);
		else {
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
		go(cur + (dx < 0 ? 1 : -1), true);
	});
	listen(sess, box, "touchcancel", function () { swipe = null; }, { passive: true });
	listen(sess, document, "keydown", function (e) {
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !$("bookMenu").hidden || !$("settings").hidden) return;
		var dir = e.key === "ArrowRight" || e.key === "j" || e.key === "PageDown" ? 1 : e.key === "ArrowLeft" || e.key === "k" || e.key === "PageUp" ? -1 : 0;
		if (!dir) return;
		e.preventDefault();
		go(cur + dir, true);
	});
	sess.cleanup.push(function () { Object.keys(urls).forEach(function (k) { urls[k].then(URL.revokeObjectURL, function () {}); }); });
	await go(pos.page || 1, false);
}

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
		toast(on ? "Marked as finished." : "Marked as not finished.");
	} catch (e) { fail(e); }
});
$("bmRestart").addEventListener("click", restartBook);
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
$("editBooks").addEventListener("click", function () { state.editBooks = !state.editBooks; renderBooks(); });
$("bookSearch").addEventListener("input", function () { state.libSearch = this.value; if (state.books) renderBooks(); });
$("bookSort").value = state.libSort;
$("bookSort").addEventListener("change", function () { state.libSort = this.value; store("readerBookSort", this.value === "recent" ? null : this.value); if (state.books) renderBooks(); });
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
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

async function start() {
	show($("tokenForm"), false);
	show($("app"), true);
	$("feedsBox").open = matchMedia("(min-width: 900px)").matches || read("readerFeedsOpen") === "1";
	try {
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
	if (Object.keys(bookPending).length && !state.books) loadBooks().catch(function () {});
}
// Back online: send places saved while offline, and show the whole Library again.
window.addEventListener("online", function () { if (token()) loadBooks().catch(function () {}); });

applyTheme(read("readerTheme"));
applySize(fontSize);
if (token()) start(); else askToken();
</script>
</body>
</html>
`;
