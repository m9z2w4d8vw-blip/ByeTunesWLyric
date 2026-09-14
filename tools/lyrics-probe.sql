-- lyrics-probe.sql
--
-- Run this FIRST, before changing any injection code. It answers the one
-- question the whole fix depends on: does the iOS Music app store timed
-- lyrics in MediaLibrary.sqlitedb at all?
--
-- HOW TO GET THE DATABASE
--   ByeTunes → Settings → (under "Delete Library") Debug Options → export
--   the database. Or pull it directly:
--     /iTunes_Control/iTunes/MediaLibrary.sqlitedb
--   Copy the -wal and -shm alongside it, then:
--     sqlite3 MediaLibrary.sqlitedb "PRAGMA wal_checkpoint(TRUNCATE);"
--   Skipping the checkpoint means you read a stale copy and may conclude
--   there are no lyrics when there are.
--
-- WHAT MAKES THIS DECISIVE
--   You need a control: a track that ALREADY shows word-by-word karaoke
--   lyrics on the device. That means an Apple Music catalog track,
--   downloaded for offline playback, on a subscription. Play it, confirm
--   the karaoke view works with Wi-Fi and cellular OFF, then pull the DB.
--   If the highlighting works offline, the payload is cached somewhere —
--   and query 3 tells you whether "somewhere" is this file.
--
--   Run with:  sqlite3 -header -column MediaLibrary.sqlitedb < lyrics-probe.sql

.mode line
.headers on

-- ---------------------------------------------------------------------
-- 0. Schema shape. Confirms which columns this iOS version actually has
--    before any query assumes them.
-- ---------------------------------------------------------------------
SELECT '=== 0. lyrics table schema ===' AS section;
PRAGMA table_info(lyrics);

SELECT '=== 0b. does item_store have extended_lyrics_attribute? ===' AS section;
SELECT COUNT(*) AS has_extended_lyrics_attribute
  FROM pragma_table_info('item_store')
 WHERE name = 'extended_lyrics_attribute';

-- ---------------------------------------------------------------------
-- 1. Population overview. How many rows, how many non-empty, how the
--    three flags are distributed. A healthy device with catalog lyrics
--    should show a cluster with timed=1.
-- ---------------------------------------------------------------------
SELECT '=== 1. flag distribution ===' AS section;
SELECT store_lyrics_available          AS store_avail,
       time_synced_lyrics_available    AS timed,
       downloaded_catalog_lyrics_available AS cached,
       COUNT(*)                        AS rows,
       SUM(CASE WHEN LENGTH(lyrics) > 0 THEN 1 ELSE 0 END) AS with_payload,
       MAX(LENGTH(lyrics))             AS max_bytes,
       SUM(CASE WHEN checksum <> 0 THEN 1 ELSE 0 END)      AS with_checksum
  FROM lyrics
 GROUP BY 1, 2, 3
 ORDER BY rows DESC;

-- ---------------------------------------------------------------------
-- 2. THE KEY QUERY. Anything that looks like TTML/XML.
--
--    A non-empty result means the timed payload IS cached in SQLite, and
--    writing your own TTML into this column is a viable route. Copy the
--    `head` value out verbatim — that is the exact attribute set to
--    reproduce in LyricsSyncFormat.TTMLOptions.
--
--    An empty result (with a working offline karaoke track present on the
--    device) means the payload lives outside this database, and no amount
--    of local writing will produce highlighting.
-- ---------------------------------------------------------------------
SELECT '=== 2. rows whose payload looks like TTML/XML ===' AS section;
SELECT l.item_pid,
       ie.title,
       LENGTH(l.lyrics)                AS bytes,
       SUBSTR(l.lyrics, 1, 500)        AS head,
       l.checksum,
       l.time_synced_lyrics_available  AS timed,
       l.downloaded_catalog_lyrics_available AS cached
  FROM lyrics l
  LEFT JOIN item_extra ie ON ie.item_pid = l.item_pid
 WHERE l.lyrics LIKE '<%'
    OR l.lyrics LIKE '%<tt%'
    OR l.lyrics LIKE '%itunes:timing%'
    OR l.lyrics LIKE '%<span begin%'
 LIMIT 5;

-- ---------------------------------------------------------------------
-- 2b. Fallback: does anything look like LRC instead? If the column holds
--     `[mm:ss.xx]` text, the renderer parses LRC and the fix is trivial.
-- ---------------------------------------------------------------------
SELECT '=== 2b. rows whose payload looks like LRC ===' AS section;
SELECT l.item_pid, ie.title, LENGTH(l.lyrics) AS bytes,
       SUBSTR(l.lyrics, 1, 200) AS head
  FROM lyrics l
  LEFT JOIN item_extra ie ON ie.item_pid = l.item_pid
 WHERE l.lyrics GLOB '*[[][0-9][0-9]:[0-9][0-9]*]*'
 LIMIT 5;

-- ---------------------------------------------------------------------
-- 3. The biggest payloads regardless of shape, with the catalog columns
--    that gate resolution. Use this to eyeball what a real catalog
--    track's row looks like next to a ByeTunes-injected one.
-- ---------------------------------------------------------------------
SELECT '=== 3. largest payloads + catalog identity ===' AS section;
SELECT l.item_pid,
       ie.title,
       ia.item_artist                        AS artist,
       LENGTH(l.lyrics)                      AS bytes,
       SUBSTR(REPLACE(l.lyrics, char(10), '/'), 1, 120) AS head,
       l.checksum,
       l.pending_checksum,
       l.store_lyrics_available              AS store_avail,
       l.time_synced_lyrics_available        AS timed,
       l.downloaded_catalog_lyrics_available AS cached,
       s.store_item_id,
       s.subscription_store_item_id          AS sub_store_id,
       s.storefront_id,
       s.cloud_status,
       s.is_subscription,
       s.playback_endpoint_type              AS pb_endpoint,
       s.store_saga_id,
       s.match_redownload_params
  FROM lyrics l
  LEFT JOIN item_extra  ie ON ie.item_pid = l.item_pid
  LEFT JOIN item        it ON it.item_pid = l.item_pid
  LEFT JOIN item_artist ia ON ia.item_artist_pid = it.item_artist_pid
  LEFT JOIN item_store  s  ON s.item_pid  = l.item_pid
 WHERE LENGTH(l.lyrics) > 0
 ORDER BY LENGTH(l.lyrics) DESC
 LIMIT 10;

-- ---------------------------------------------------------------------
-- 4. Side-by-side: catalog-sourced tracks vs locally-injected ones.
--    `store_saga_id <> 0` is ByeTunes' marker for "we claimed a catalog
--    match". Compare the two groups' flags and payload shapes — the
--    delta is your work list.
-- ---------------------------------------------------------------------
SELECT '=== 4. catalog vs local, aggregate ===' AS section;
SELECT CASE
         WHEN COALESCE(s.store_item_id, 0) = 0 THEN 'no catalog id'
         WHEN COALESCE(s.store_saga_id, 0) <> 0 THEN 'byetunes-claimed catalog'
         ELSE 'real catalog'
       END                                   AS kind,
       COUNT(*)                              AS tracks,
       SUM(CASE WHEN LENGTH(COALESCE(l.lyrics,'')) > 0 THEN 1 ELSE 0 END) AS with_payload,
       SUM(COALESCE(l.time_synced_lyrics_available, 0))                   AS timed_flag_set,
       SUM(COALESCE(l.downloaded_catalog_lyrics_available, 0))            AS cached_flag_set
  FROM item it
  LEFT JOIN item_store s ON s.item_pid = it.item_pid
  LEFT JOIN lyrics     l ON l.item_pid = it.item_pid
 WHERE it.media_type = 8
 GROUP BY kind;

-- ---------------------------------------------------------------------
-- 5. Is `extended_lyrics_attribute` ever non-zero on this device?
--    ByeTunes never writes it. If a real catalog track has it set and an
--    injected one does not, that is the word-level capability bit and the
--    single highest-value thing to copy.
--
--    (Wrapped in a guard because the iOS 16 schema branch may lack it —
--    if the column is missing this statement errors and you can ignore it.)
-- ---------------------------------------------------------------------
SELECT '=== 5. extended_lyrics_attribute distribution ===' AS section;
SELECT extended_lyrics_attribute,
       extended_playback_attribute,
       COUNT(*) AS tracks
  FROM item_store
 GROUP BY 1, 2
 ORDER BY tracks DESC;

-- ---------------------------------------------------------------------
-- 6. Sanity: is match_redownload_params holding the literal bug?
--    MediaLibraryBuilder writes "sagaId=\(song.storeId)" inside a plain
--    string with an ESCAPED backslash, so the interpolation never runs
--    and every catalog-matched row gets the literal source text. If rows
--    come back here, that bug is live on this device — and a malformed
--    redownload param is exactly the kind of thing that makes the Music
--    app decline to treat the row as a catalog item at all.
-- ---------------------------------------------------------------------
SELECT '=== 6. literal-interpolation bug present? ===' AS section;
SELECT COUNT(*) AS rows_with_literal_placeholder
  FROM item_store
 WHERE match_redownload_params LIKE '%\(%' ESCAPE '\';

SELECT DISTINCT match_redownload_params, COUNT(*) AS n
  FROM item_store
 WHERE COALESCE(match_redownload_params, '') <> ''
 GROUP BY match_redownload_params
 LIMIT 10;
