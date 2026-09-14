# Why ByeTunes lyrics don't highlight, and what to do about it

## The short answer

There are **two independent reasons**, and they need different fixes.

1. **ByeTunes destroys the timing data, three times over, before it ever
   reaches the database.** This is a plain bug and it is fixable in the
   app. Patches 1–2.

2. **Even with perfect timing data in the `lyrics` column, it is not
   established that the iOS Music app will render it.** The karaoke view
   in your screenshot is Apple Music Sing, driven by TTML from Apple's
   catalog servers, keyed on `item_store.store_item_id`. For a sideloaded
   local file there may be no code path that parses local timed lyrics at
   all. Patches 3–5 build the machinery to find out and to exploit it if
   it exists; `tools/lyrics-probe.sql` is what settles the question.

Anyone who tells you (1) alone is the fix is guessing. So is anyone who
tells you (2) makes it impossible. The probe is the difference.

---

## Reason 1: the timing is deleted at three separate points

### 1a. LRCLIB's synced field is never read

`SongMetadata.swift:1108`

```swift
let lyrics = (json?["plainLyrics"] as? String) ?? (json?["syncedLyrics"] as? String)
```

LRCLIB's `/api/get` response contains **both** `plainLyrics` and
`syncedLyrics`. `plainLyrics` is populated for essentially every track
that has lyrics at all, so the `??` fallback to `syncedLyrics` is dead
code. The timestamps are discarded in the response parser, before
anything else in the app can see them.

This one line is the single biggest cause. Everything below is a second
line of defence that also happens to be broken.

### 1b. `cleanLyrics` is a de-timing function

`SongMetadata.swift:1042`

```swift
cleaned = cleaned.replacingOccurrences(of: #"\[\d{2,}:\d{2}(\.\d{2,})?\]"#, with: "", options: .regularExpression)
...
cleaned = cleaned.replacingOccurrences(of: #"\[[^\]]+\]"#, with: "", options: .regularExpression)
```

The first regex removes `[mm:ss.xx]` explicitly. The second removes every
remaining bracket group, which catches anything the first missed —
including `[offset:+250]`, the tag that corrects a systematically early
or late sync.

This matters because there **is** a path that correctly prefers synced
lyrics: `resolveLyrics(for:songTitle:songArtist:)` at line 1736, used by
the manual lyrics search sheet, does `result.syncedLyrics ?? result.plainLyrics`
— and then hands the result straight to `cleanLyrics`. So even when a
user manually picks a synced result from the search UI, the timestamps
are stripped on the way out.

### 1c. NetEase word-level timing is deleted too

`SongMetadata.swift:1580`

```swift
private static func stripTimedLyrics(_ lyrics: String) -> String {
    let stripped = lyrics.replacingOccurrences(
        of: #"\[[^\]]*\]|\([0-9]+,[0-9]+\)"#, ...
```

That second alternation, `\([0-9]+,[0-9]+\)`, is NetEase's
`(startMs,durationMs)` per-word syllable format. It is the only
**word-level** timing source in the entire app that doesn't require an
Apple Music subscription — the exact granularity your screenshot shows —
and it is being regex'd out of existence.

### 1d. And then the database is told the opposite

`MediaLibraryBuilder.swift:923`

```swift
INSERT OR REPLACE INTO lyrics (item_pid, lyrics, store_lyrics_available,
    time_synced_lyrics_available, downloaded_catalog_lyrics_available)
VALUES (\(itemPid), '\(lyricsContent)', 1, 1, 0)
```

`time_synced_lyrics_available = 1` over a payload with no timing in it.
Whatever the Music app does with that flag, it is being given a false
premise. `downloaded_catalog_lyrics_available` is hardcoded to `0` in
both branches and is never written anywhere else in the codebase.

---

## Reason 2: the renderer probably isn't reading that column

Three flags on the `lyrics` table, and the names suggest a fetch protocol
rather than a storage format:

| column | apparent meaning |
|---|---|
| `store_lyrics_available` | the catalog has lyrics — go ask for them |
| `time_synced_lyrics_available` | the catalog lyrics are timed |
| `downloaded_catalog_lyrics_available` | the timed payload is cached locally |

The strongest evidence that this reading is right is **in ByeTunes
itself**. Look at what the `appleSubscriptionLyrics` toggle does:

```swift
let resolvedLyricsText = appleSubscriptionLyrics ? "" : SongMetadata.cleanLyrics(...)
```

When the toggle is on, the app deliberately writes an **empty** lyrics
column. That only makes sense if a non-empty local column *shadows* the
catalog payload — i.e. the author already worked out that to get real
Apple karaoke lyrics you must (a) hold a subscription, (b) have a valid
`store_item_id`, and (c) get out of the way.

So the honest framing: **the subscription path is the supported one, and
it already exists in the app.** If you have Apple Music and a track
matched correctly to the catalogue, turning that toggle on is the whole
fix, and the reason it might still not work is catalog matching rather
than lyrics.

### The lever nobody has pulled

`downloaded_catalog_lyrics_available` is the offline cache flag, and it is
always 0. If the `lyrics` column is where a downloaded catalog track's
timed payload gets cached, then writing valid TTML there and setting that
flag would give you highlighting with **no subscription and no network**.

That is a hypothesis. It is also cheap to test, and if it holds it is the
better outcome by a distance.

### And a second one

`item_store.extended_lyrics_attribute` is declared in both schema
branches of `MediaLibraryBuilder.createSchema` and written by **nothing**
in the codebase — grep it and you get two hits, both `CREATE TABLE`. It
sits directly beside `extended_playback_attribute`, which is the
capability bit for extended playback features. On a catalog track this is
the most plausible candidate for "word-level lyrics eligible."

Query 5 in the probe tells you whether a real catalog track on your
device has it set while an injected one doesn't. If so, that's the bit.

---

## Run the probe first

The decisive experiment needs a **control**: a track on your device that
already shows word-by-word karaoke lyrics *with networking disabled*.
That means an Apple Music catalog track, downloaded for offline playback,
on an active subscription.

1. Download a catalog track that has Sing lyrics. Turn off Wi-Fi and
   cellular. Confirm the karaoke view still highlights word by word. If
   it doesn't, the payload was never cached and reason 2 is settled
   negatively — stop here and go to the subscription path.
2. Pull the database:
   ```
   /iTunes_Control/iTunes/MediaLibrary.sqlitedb   (+ -wal, -shm)
   ```
   ByeTunes' own Debug Options can export it.
3. Checkpoint before reading, or you'll read a stale copy and conclude
   there are no lyrics when there are:
   ```bash
   sqlite3 MediaLibrary.sqlitedb "PRAGMA wal_checkpoint(TRUNCATE);"
   ```
4. ```bash
   sqlite3 -header -column MediaLibrary.sqlitedb < tools/lyrics-probe.sql
   ```

**Query 2 is the one that matters.** If it returns rows containing
`<tt ... itunes:timing="Word">`, local timed lyrics are viable — copy the
exact attribute set out of the `head` column and match it in
`LyricsSyncFormat.TTMLOptions`. If it returns nothing while your control
track highlights offline, the cache lives outside SQLite and no amount of
writing to this column will work.

---

## What's in this drop

| file | role |
|---|---|
| `MusicManager/LyricsSyncFormat.swift` | LRC + Enhanced LRC (A2) + NetEase word-timed parsers → a timed model → Apple-shaped TTML emitter. Also `cleanPreservingTiming`, a drop-in replacement for `cleanLyrics` that scrubs the same junk per-line-body without touching timing constructs. |
| `MusicManager/LyricsSyncWriter.swift` | The four delivery modes and their flag matrix, a bound-parameter row writer, and `LyricsSyncProbe` for in-app introspection + the `extended_lyrics_attribute` sweep. |
| `MusicManager/LyricsSyncPatches.md` | Six exact diffs against existing files, with line numbers. |
| `tools/lyrics-probe.sql` | Standalone probe. Run this first. |

### The four modes

| mode | payload | `store` | `timed` | `cached` | needs |
|---|---|---|---|---|---|
| `appleCatalog` | *empty* | 1 | 1 | 0 | subscription + valid `store_item_id` |
| `cachedTTML` | Apple-shaped TTML | 1 | 1 | **1** | nothing — but unverified |
| `rawLRC` | raw `[mm:ss.xx]` | 1 | 1 | 1 | nothing — long shot, free to test |
| `plainOnly` | plain text | 1 | **0** | 0 | nothing |

`plainOnly` is today's behaviour with one correction: `timed` becomes 0,
because the payload has no timing. Telling the truth there lets the
renderer commit to the static layout immediately instead of waiting on a
timed payload that never arrives.

`appleCatalog` falls back automatically when `hasCatalogMatch` is false —
writing an empty column with no catalog to resolve against produces a
track with *no* lyrics, which is worse than static text. The current code
doesn't check this.

---

## Order of attack

1. **Apply patches 1–2 and check the logs.** These are unambiguous bugs
   with no downside. The new log line tells you whether LRCLIB is
   actually serving synced lyrics for your library:
   `[SongMetadata] LRCLIB payload timing: synced`. If it says `plain` for
   everything, your tracks have no synced lyrics upstream and the rest is
   moot — contribute syncs to LRCLIB or use the Musixmatch/NetEase
   providers, which have better word-level coverage.
2. **Run the probe.** Settles reason 2 in one command.
3. **If the probe finds TTML:** apply patch 3, set mode to `cachedTTML`,
   match the attribute set you found, inject one album, restart the phone
   (the Music daemons cache the library aggressively — ByeTunes says
   "Complete! Restart your iPhone." for this reason), and look.
4. **If the probe finds nothing:** apply patches 3–5 anyway for the flag
   honesty and the `matchRedownloadParams` fix, set mode to
   `appleCatalog`, and put the effort into catalog matching instead —
   `store_item_id`, `storefront_id`, `subscription_store_item_id`,
   `cloud_status`, `playback_endpoint_type`. Then sweep
   `extended_lyrics_attribute` across `LyricsSyncProbe.extendedLyricsCandidates`
   one value per injection.
5. **Either way, try `rawLRC` once.** It costs one setting change. If the
   renderer happens to sniff for `[mm:ss]` you're done in an afternoon.

## Things that will waste your time

- **Testing without restarting the device.** `musicd` holds the library
  cached; a changed lyrics row is not guaranteed to be re-read. ByeTunes
  already kills Apple Music before injection, which is necessary but not
  sufficient here.
- **Testing on a track with no catalog match.** Set the metadata source
  to Apple Music and confirm `store_item_id > 0` in the database before
  concluding anything about the subscription path.
- **Word-level from LRCLIB.** LRCLIB's `syncedLyrics` is **line-level**
  LRC. It will get you the whole-line highlight, not the per-word sweep
  in your screenshot. Word-level needs Enhanced LRC (A2, `<mm:ss.xx>`
  inline — rare in the wild), NetEase's yrc format (patch 1c unlocks
  this), or Apple's own `syllable-lyrics` (subscription). The parser here
  handles all three; the availability is the constraint, not the code.
- **Expecting the mic button.** The karaoke/Sing control in your
  screenshot is gated on more than lyrics format — vocal-attenuation
  stems come from Apple's servers per-track. Word-highlighted lyrics and
  the Sing mic are separable; you can plausibly get the first without the
  second.
