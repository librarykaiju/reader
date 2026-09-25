// The reader keeps its token in its own localStorage, so a plain top-level
// visit lands logged in. It can't be shown in a frame here: the reader sends
// frame-ancestors 'none'. replace() keeps the blank page out of Back history.
location.replace("https://reader.brandonj.ink/");
