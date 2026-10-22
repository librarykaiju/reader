/* Migration 0015: previews, for reading a sample of a book in the family
   library before downloading it.
     * previews (new table): how many bytes of a PDF each family member has
       been sent through previews. A preview of a PDF stops at 40% of the
       file, however often it's opened. (EPUBs, comics and .txt previews are
       cut to size by the Worker, so they aren't counted.)

   Run it ONCE, BEFORE deploying the Worker code that needs it: paste it into
   the D1 Console (dashboard, reader, Console) and Execute. Running it again
   changes nothing. */

CREATE TABLE IF NOT EXISTS previews (
	person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
	book_id INTEGER NOT NULL REFERENCES books (id) ON DELETE CASCADE,
	bytes INTEGER NOT NULL,
	PRIMARY KEY (person_id, book_id)
);
