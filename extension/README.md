# Reader New Tab

A tiny Chrome/Edge/Firefox extension that opens https://reader.brandonj.ink in every
new tab. No permissions, no data, nothing to configure. The reader remembers
its token on its own, so you land logged in (enter the token once in that
browser if you never have).

## Install (Chrome)

1. On GitHub, open the repo's **Code** button > **Download ZIP**, unzip it,
   and copy its `extension` folder somewhere permanent, like
   `Documents\Reader New Tab`. Chrome loads it from that folder every time,
   so don't delete it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `extension` folder.
4. Open a new tab. Chrome asks once whether to keep the change; choose
   **Keep it**.

Edge is the same at `edge://extensions` (Developer mode is bottom left).

## Install (Firefox)

Firefox only keeps extensions that Mozilla has signed. Signing is free and
private (it isn't listed in the add-on store), but it needs a Firefox account.

1. Zip the four files in this folder (select `manifest.json`, `newtab.html`,
   `newtab.js`, `README.md` > right-click > Compress to ZIP file). Zip the
   files themselves, not the folder around them.
2. Go to https://addons.mozilla.org/developers/addon/submit/distribution,
   sign in, and choose **On your own**.
3. Upload the zip and continue through the steps. When it asks for source
   code, choose **No**.
4. Once it's signed (usually a few minutes), download the `.xpi` file and
   drag it onto a Firefox window, then click **Add**.
5. Open a new tab. If Firefox asks whether to keep the change, choose
   **Keep changes**.

To try it without signing: `about:debugging` > This Firefox > **Load
Temporary Add-on** > pick `manifest.json`. It's removed when Firefox closes.

## Updating

After changing a file here, click the reload arrow on the extension's card
in `chrome://extensions`. For Firefox, raise `version` in `manifest.json`,
then upload and sign it again (Upload a New Version on the add-on's page).

## Home button and startup (no extension needed)

- Startup: Settings > On startup > Open a specific page or set of pages >
  add `https://reader.brandonj.ink`.
- Home button: Settings > Appearance > Show home button > enter
  `https://reader.brandonj.ink`.
- Firefox: Settings > Home > Homepage and new windows > Custom URLs >
  `https://reader.brandonj.ink`. Firefox has no setting for new tabs, which
  is why the extension is still needed there.

## Notes

- To point it at another address, change the URL in `newtab.js`.
- The address bar doesn't get focus on a new tab (the browser gives it to
  the page), so click it or press Ctrl+L to type a search.
- Chrome's extensions page shows a harmless warning about the
  `browser_specific_settings` key. That part is for Firefox only.
