/* Migration 0009: how a comic is laid out, saved on the book so it follows
   you to every device.
     * books.layout (new column): NULL = not decided yet (the page looks at
       the comic the first time it's opened), 'pages' = one page at a time,
       'scroll' = webtoon, every page stacked in one long strip, 'rtl' = one
       page at a time, right to left (manga)

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste the
   line below into the D1 Console (dashboard, reader, Console) and Execute.
   The old Worker code keeps working with the new column there.

   Running it a second time stops with "duplicate column name: layout" and
   changes nothing. */

ALTER TABLE books ADD COLUMN layout TEXT;
