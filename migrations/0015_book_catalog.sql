/* Migration 0015: catalog details on book records.
     * books.catalog (new column): the book's catalog details as JSON,
       {"year", "publisher", "language", "classification", "isbn"} (each
       left out when unknown), from the file, Open Library or Google Books,
       or typed in Edit details. record_from.catalog says where each came from.
       The same details feed the book logs on brandonj.ink (GET /api/catalog).

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute.

   Running it a second time stops with "duplicate column name: catalog" and
   changes nothing. */

ALTER TABLE books ADD COLUMN catalog TEXT;
