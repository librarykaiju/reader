/* Migration 0011: library card requests. Anyone who opens /library can ask
   for a card; the request waits on the Family screen until it's approved
   (which makes their invite link) or declined.
     * people.requested_at (new column): when they asked; NULL once
       approved, and for people you added yourself
     * people.request_note (new column): what they wrote with it

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute.

   Running it a second time stops with "duplicate column name" and changes
   nothing. */

ALTER TABLE people ADD COLUMN requested_at INTEGER;
ALTER TABLE people ADD COLUMN request_note TEXT;
