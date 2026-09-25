# Build Your Own Private Reader: A Plan

A plan for someone who wants their own version of Brandon's reader (feeds, newsletters, ebooks, podcasts and videos in one private web app) and wants to build it with an AI coding assistant without the waste that came with building the first one.

It draws on the build history of the original (pull requests #51 to #64 in `librarykaiju/w3bz1n3`, folder `workers/reader/`) and on MIT research and reporting on AI's energy use. Where a claim is my own reasoning and not something a source says, it is marked **(inference)**.

---

## The short version

1. **Start from working code, not a blank prompt.** Fork or copy the existing reader and change it. Avoided work is the cheapest compute there is. This is the single biggest saving available.
2. **Write the whole spec before the first prompt.** Pick features from the menu in Part 2 up front. Most of the original's extra rounds came from decisions made mid-build (feed folders turned into tags a few PRs later, and book folders turned into tags after that; each needed a migration, and the first left an unused database column behind).
3. **Batch related changes into one request.** One larger, well-specified change costs less than five small ones that each re-read the same code **(inference)**.
4. **Give the assistant real test data, not mocks.** Several features in the original were checked only against fakes and needed follow-up fixes or are still unverified. Real samples up front prevent fix-the-fix loops.
5. **Use the smallest model that can do the job.** Save the big or "reasoning" models for design questions. MIT Technology Review measured a large model using roughly 60 times the energy per answer of a small one.
6. **Keep AI out of the running app.** The reader itself does no AI work, no background jobs, and refreshes only when opened. Keep it that way.
7. **Don't feel guilty about asking; be deliberate about it.** MIT Technology Review's own conclusion is that one person's chatbot use is small next to industry-scale decisions. The habits above are about not multiplying waste, not about avoiding the tool.

---

## Part 1: What you're building

One Cloudflare Worker serves everything: the page, the API and the email handler. The whole app is a single JavaScript file (`src/index.js`) with the web page inlined, so it can be deployed by pasting it into Cloudflare's dashboard editor with no build tools.

| Piece | Cloudflare product | What it holds |
|---|---|---|
| App and API | Worker | Page, API routes, feed fetching, email handler |
| Database | D1 (SQLite) | Feeds, items, tags, reading positions, books' metadata |
| Files | R2 bucket (private) | Uploaded .txt and .pdf books |
| Newsletters | Email Routing | Forwards `news@yourdomain` into the Worker |
| Login | Worker secret | One long random token, sent as a Bearer header |

**Why this shape is good for the user and the planet:** a Worker costs nothing while idle, there is no always-on server, and the reader only fetches feeds when you open it or press Refresh. There is no background job polling hundreds of feeds every few minutes while nobody reads them **(inference: the saving is real but small in absolute terms)**.

**What it can't do:** Cloudflare Workers cap uploads at 100 MB, so books max out around 95 MB. Newsletters need a domain whose mail (MX records) Cloudflare can take over. If your main domain already has email elsewhere, buy a cheap second domain just for newsletters, as the original did.

Check Cloudflare's current free-tier limits before you start; for one reader they have been generous, but they change.

---

## Part 2: Build order

The original grew one feature at a time, which is natural when you don't know what you want yet. Someone copying it does know, so the order below front-loads the decisions that are expensive to change later (anything that touches the database).

### Step 0: Decide the spec (no AI needed)

Tick what you want before prompting anything:

- [ ] Feeds: add a site by URL; find its RSS/Atom feed, or watch the page for changes if it has none
- [ ] Grouping: colored **tags** for feeds (a feed can have several). Don't start with folders; the original did for feeds and books and had to convert both
- [ ] Books: .txt and .pdf upload, book tags (kept separate from feed tags), "Finished" badge, "Start over", offline download
- [ ] Book details from a YAML header in .txt files (title, author, series, volume, genres)
- [ ] Newsletters by email (sender becomes a feed; removing it blocks the sender)
- [ ] Podcasts tab with a player bar, synced position, offline downloads
- [ ] Videos tab (YouTube/Twitch/Vimeo links and video files)
- [ ] Embeds in articles (Bluesky, YouTube, Spotify, charts) and removal of sites' share-button clutter
- [ ] Themes: light, dark, sepia
- [ ] Next/previous article by button, swipe and keyboard

Write down the database tables for everything you ticked **before** the first build. In the original, the schema changed five times (migrations 0001 to 0005), and each change meant a careful manual step on the live database.

### Step 1: Core reader

Worker, D1, token login, add-by-URL, article view, themes, tags, next/previous. Deploy and use it for a few days before adding anything.

### Step 2: Books

R2 bucket, upload, tags, reading position, offline. PDFs use pdf.js loaded from a CDN with a pinned version.

### Step 3: Newsletters

Domain, Email Routing rule pointing to the Worker, the `email()` handler. Test with a real newsletter, not a hand-written sample.

### Step 4: Media

Podcasts, then videos, then embeds. Keep podcast episodes out of the Unread count from the start (the original added that fix one PR later, because a single podcast feed swamped the Unread list).

---

## Part 3: User-experience decisions worth copying

These held up in daily use:

- **Tags, not folders, for both feeds and books.** A feed often fits several categories, and so does a book (genre, series, to-read). Keep book tags separate from feed tags so neither list gets cluttered.
- **Refresh on open, not on a timer.** Fresh enough, no idle cost.
- **Next/previous inside an article** that steps through the list you opened it from, with Back returning to that list. Swipes ignore the screen edges so they don't fight the phone's own back gesture.
- **Media is not "unread".** Podcasts and videos live in their own tabs so they don't bury articles.
- **Offline that syncs honestly.** Positions carry a timestamp; the newer one wins when you reconnect.
- **Re-uploading a book with the same filename replaces the file** and keeps your place and tags. That turned out simpler than an in-app metadata editor.
- **Strip share-button junk from articles** and give the reader its own single Share button.

---

## Part 4: Deploying and updating

**Paste deploy (no tools):** paste `index.js` into the Worker's dashboard editor and save. This is what the original uses and it works well for one person.

The full dashboard walkthrough (database, bucket, secret, domain, email) is in [[Reader Setup]].

**Database changes always go first.** Run the migration SQL, then paste the new code. New code against an old database breaks; old code against a new database usually doesn't.

**Paste-safe SQL.** The D1 dashboard Console flattens pasted text into one line, so a `--` comment swallows everything after it. Use `/* */` comments or none at all in any SQL meant for pasting. (The original learned this the hard way and converted its migration files.)

**Command-line deploy (optional):** if you're comfortable with a terminal, `wrangler deploy` and `wrangler d1 migrations apply` do the same thing with less copy-paste risk.

---

## Part 5: Keeping the AI footprint down

### What the MIT research says

- **Inference, not training, is now most of the load.** MIT Technology Review reports that an estimated 80 to 90 percent of computing power for AI goes to inference, meaning answering requests like yours. [TR, May 2025]
- **Model size dominates the cost of an answer.** In Technology Review's measurements, a small open model (Llama 3.1 8B) used about 114 joules per response including cooling; a large one (Llama 3.1 405B) used about 6,706 joules. That's roughly 60 times more. [TR, May 2025]
- **Reasoning modes cost more.** Reasoning models were found to need 43 times more energy for simple problems. [TR, May 2025]
- **A chatbot query beats a web search by about 5x in electricity.** [MIT News, Jan 2025]
- **Water and grid matter too.** MIT's Noman Bashir estimates about two liters of cooling water per kilowatt-hour a data center uses, and Technology Review found data-center electricity was 48 percent more carbon-intensive than the US average. [MIT News, Jan 2025; TR, May 2025]
- **Much of the fix is on the provider side.** MIT Lincoln Laboratory's Vijay Gadepally found that capping GPU power cut energy use 20 to 30 percent with minimal effect on performance, and that many computations could be stopped early without changing the result. MIT CSAIL's Neil Thompson calls avoided computation a "negaflop." MIT Energy Initiative's Deepjyoti Deka points to shifting work to hours when the grid is cleaner. [MIT Climate Portal Q&A, Jan 2025; MIT News, Sept 2025]
- **Keep it in proportion.** Technology Review's follow-up argues individuals shouldn't worry much about their personal AI footprint and should push for company disclosure instead, while still noting that heavy use of reasoning models and churning out "AI slop" are real costs. [TR, Nov 2025]

### What that means for vibe coding

Power capping and clean-grid scheduling happen inside the data center; you can't choose them. What you control is **how many requests you make, how big they are, and which model answers them.** An AI coding session is not one question: the assistant re-reads your files, runs tools and tries again, and each of those steps is another inference call **(inference: this follows from how coding agents work; the sources measure single chatbot answers, not coding sessions)**.

So the levers, applied to what actually happened on this project:

**1. Reuse instead of regenerate (Thompson's negaflops).**
The original took pull requests #51 through #64 to get where it is. Starting a new build from a blank prompt repeats most of that. Starting from the existing code and asking for your changes skips it **(inference)**. If you're sharing your own version, publish it as something others can copy.

**2. Specify once, build once.**
Feed folders were built in one PR and replaced by tags a few PRs later (#52, #55), which needed a data migration and left a dead column (`feeds.folder_id`) because SQLite can't drop it. Book folders, drag and drop included, went the same way in #64. The podcast "exclude from Unread" rule was a separate follow-up PR (#62). All three were decisions that could have been made on paper first. Every re-do is the assistant reading the whole app again **(inference)**.

**3. Batch small asks.**
Several PRs in the original were small, single-issue changes. Each one re-reads a large single-file app, re-runs tests and goes through review. Collect small tweaks ("scrollbar gutter, button spacing, sepia contrast") into one request **(inference)**. Keep genuinely risky changes (database migrations) separate so they're easy to undo.

**4. Test against the real thing.**
In the original, AP charts and YouTube embeds (#59) were tested only against mock pages, the AP video fix (#61) is still unverified, and video resume (#63) was never checked against real players. That's because the build environment couldn't reach those sites. Mock-only testing moves the testing to you, after deploy, and each surprise becomes another round **(inference)**. Before asking for a feature, hand the assistant real material: saved HTML of a real article, a real feed URL, a screenshot of what's wrong on your phone.

**5. Match the model to the job.**
Given Technology Review's roughly 60x gap between small and large models, and 43x for reasoning on simple tasks: use a smaller or faster model (or reasoning turned off) for CSS tweaks, copy changes and renames. Use the big model for schema design, sync logic and security. Don't use extended reasoning to change a color.

**6. Let normal tools do checking.**
Linters, a formatter and a test script run on your own machine for almost nothing. Asking the AI "does this look right?" re-reads the code to do what a test does for free **(inference)**.

**7. Ask for edits, not rewrites.**
Ask for changes to specific functions instead of "regenerate index.js." Smaller outputs cost less, and a diff is easier for you to check.

**8. Keep the running app AI-free.**
Don't add auto-summaries or AI tagging to every incoming article. That turns a one-time build cost into an every-article, forever cost. If you want a summary, make it a button you press on the rare article you need it for **(inference)**.

**9. Skip generated images and video.**
Technology Review measured a five-second generated video at more than 700 times the energy of a generated image. An app icon from an emoji or a free icon set costs nothing.

---

## Part 6: A starter prompt

Paste this, filled in, as your first message to the assistant:

> I'm building a private, single-user reader as one Cloudflare Worker (single `index.js`, page inlined) with D1, a private R2 bucket, and Email Routing. Starting from: [link to the code you're copying, or "from scratch"].
>
> Features I want (and nothing else): [paste your ticked list from Step 0].
>
> Constraints: I deploy by pasting `index.js` into the dashboard. Migrations must be paste-safe SQL with `/* */` comments only, and I run them before deploying code. Login is a Bearer token stored as a Worker secret. No background jobs; feeds refresh on open.
>
> Real test data: [feed URLs, a saved article HTML, a newsletter .eml, a sample book].
>
> Please propose the full database schema first and wait for my OK before writing code. Batch the work into as few changes as possible, and test against the real data I gave you, telling me anything you could only test against a mock.

---

## Sources

- MIT News, "Explained: Generative AI's environmental impact," January 17, 2025. https://news.mit.edu/2025/explained-generative-ai-environmental-impact-0117
- MIT Climate Portal, "Q&A: The climate impact of generative AI" (Vijay Gadepally), January 13, 2025. https://climate.mit.edu/posts/qa-climate-impact-generative-ai
- MIT News, "Responding to the climate impact of generative AI," September 30, 2025. https://news.mit.edu/2025/responding-to-generative-ai-climate-impact-0930
- MIT Technology Review, "We did the math on AI's energy footprint. Here's the story you haven't heard," May 20, 2025. https://www.technologyreview.com/2025/05/20/1116327/ai-energy-usage-climate-footprint-big-tech/
- MIT Technology Review, "Stop worrying about your AI footprint. Look at the big picture instead," November 6, 2025. https://www.technologyreview.com/2025/11/06/1127579/ai-footprint/

## What this plan can't tell you

- **How much energy building the original used.** The sources measure single chatbot answers on open models. Coding sessions with large context and many tool calls aren't measured in them, and providers don't publish per-session figures. Any number here would be made up.
- **Whether batching always wins.** Very large requests can also go wrong in bigger ways. The advice is "batch related small changes," not "do everything in one prompt."
