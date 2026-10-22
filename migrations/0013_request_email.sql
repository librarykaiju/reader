/* Migration 0013: an email address on library card requests.
     * people.request_email (new column): the address someone gave on the
       /library request form, if any, so Approve can open an email to them
       with their link

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute.

   Running it a second time stops with "duplicate column name: request_email"
   and changes nothing. */

ALTER TABLE people ADD COLUMN request_email TEXT;
