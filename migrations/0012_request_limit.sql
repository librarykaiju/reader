/* Migration 0012: a per-address limit on library card requests.
     * people.request_ip (new column): a salted hash of the address a
       request came from (never the address itself), so one address can
       send at most 3 requests a day

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute.

   Running it a second time stops with "duplicate column name: request_ip"
   and changes nothing. */

ALTER TABLE people ADD COLUMN request_ip TEXT;
