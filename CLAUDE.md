# CLAUDE.md

## The two audiobook players stay in step

Reader has two audiobook players in `src/index.js`, and they are separate code on purpose: the family page (`FAMILY_PAGE`, served at `/library`) is a page of its own, so none of the app's code or data reaches family.

- **The app's player:** the player bar (`#pbar`, `renderPlayer`), the player page (`#listenView`, `showListen`, `renderListen`, `chapterStep`) and the sleep timer (`setSleep`, `sleepPicker`).
- **The family library's player:** `previewAudio` (the Listen page) and the player bar (`#lbar`, `paintBar`, `nowPlaying`).

When a change touches how an audiobook plays or looks while it plays, make the same change in both players in the same PR, and say in the PR that both got it. Examples are the controls, the layout, chapters, the picker, the sleep timer, speed, the lock screen and the bar. Also update both entries in `docs/setup.md` (the app's Library entry and the family library's **Listen** entry).

Some parts are only in one player, and stay that way unless asked:

- **App only:** podcasts and videos in the bar, the place synced across devices through the server (the family keeps it on the device), the Record's Player button, and finishing a book.
- **Family only:** the download limit note and the Download button under the player.

If a change can't fit one of the two players, say so in the PR rather than leaving it out without saying.
