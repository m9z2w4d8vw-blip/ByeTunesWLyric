# Patches to existing ByeTunes files

Line numbers are against `EduAlexxis/ByeTunes` @ `c66b1923` (v2.5). Apply
in order — patch 1 is the one that has to land first, because every later
patch is pointless if the timestamps are already gone by the time they run.

Drop `LyricsSyncFormat.swift` and `LyricsSyncWriter.swift` into
`MusicManager/` and add them to the Xcode target first.

---

## Patch 1 — stop discarding `syncedLyrics` at the source

**`MusicManager/SongMetadata.swift`, line 1108.**

LRCLIB returns `plainLyrics` *and* `syncedLyrics` in the same response
body. The `??` takes plain first, and plain is populated for essentially
every track, so the synced branch never runs. This single character-order
choice is why nothing downstream ever sees a timestamp.

```diff
             let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
-            let lyrics = (json?["plainLyrics"] as? String) ?? (json?["syncedLyrics"] as? String)
+            // Synced first. LRCLIB populates both fields; preferring
+            // plain meant the timestamps were dropped before any other
+            // code could see them.
+            let lyrics = (json?["syncedLyrics"] as? String) ?? (json?["plainLyrics"] as? String)
 
             if let l = lyrics, !l.isEmpty {
                 Logger.shared.log("[SongMetadata] Successfully fetched lyrics from LRCLIB")
-                return SongMetadata.cleanLyrics(l, title: title, artist: artist)
+                let hasTiming = LyricsSyncFormat.parseAny(l).granularity != .none
+                Logger.shared.log("[SongMetadata] LRCLIB payload timing: \(hasTiming ? "synced" : "plain")")
+                return hasTiming
+                    ? LyricsSyncFormat.cleanPreservingTiming(l, title: title, artist: artist)
+                    : SongMetadata.cleanLyrics(l, title: title, artist: artist)
             }
```

Same edit applies to `fetchLyricsFromMusixMatch` (line ~1139) and
`fetchLyricsFromNetEase` (line ~1414) — both currently route through
`stripTimedLyrics`, which deletes `[mm:ss.xx]` *and* NetEase's per-word
`(startMs,durationMs)` tuples with the alternation
`#"\[[^\]]*\]|\([0-9]+,[0-9]+\)"#`. That second alternation is the only
word-level timing source available without an Apple subscription, and it
is being thrown in the bin. Replace the `stripTimedLyrics(...)` call with
`LyricsSyncFormat.cleanPreservingTiming(...)` in both.

---

## Patch 2 — keep timing in the search-sheet path

**`MusicManager/SongMetadata.swift`, line 1736.**

This path already prefers `syncedLyrics`, then immediately launders it
through `cleanLyrics`, whose `#"\[[^\]]+\]"#` catch-all removes the
timestamps it just asked for.

```diff
         case .lrclib:
             let raw = result.syncedLyrics ?? result.plainLyrics ?? ""
-            let cleaned = cleanLyrics(raw, title: songTitle, artist: songArtist)
+            let cleaned = LyricsSyncFormat.parseAny(raw).granularity != .none
+                ? LyricsSyncFormat.cleanPreservingTiming(raw, title: songTitle, artist: songArtist)
+                : cleanLyrics(raw, title: songTitle, artist: songArtist)
             return cleaned.isEmpty ? nil : cleaned
```

---

## Patch 3 — write the row through the new writer

**`MusicManager/MediaLibraryBuilder.swift`, lines 923–936.**

Replace the whole block. Three things change: the payload is built by
mode, the flags stop lying about timing they do not have, and the write
uses bound parameters — which matters here specifically, because a TTML
payload is several kilobytes of XML full of quotes and ampersands and the
surrounding code escapes SQL by hand-doubling `'`.

```diff
-            let appleSubscriptionLyrics = UserDefaults.standard.bool(forKey: "appleSubscriptionLyrics")
-            let resolvedLyricsText = appleSubscriptionLyrics ? "" : SongMetadata.cleanLyrics(song.lyrics ?? "", title: song.title, artist: song.artist)
-            let lyricsContent = resolvedLyricsText.replacingOccurrences(of: "'", with: "''")
-
-            if columnExists(db: db, tableName: "lyrics", columnName: "downloaded_catalog_lyrics_available") {
-                try executeSQL(db, """
-                    INSERT OR REPLACE INTO lyrics (item_pid, lyrics, store_lyrics_available, time_synced_lyrics_available, downloaded_catalog_lyrics_available)
-                    VALUES (\(itemPid), '\(lyricsContent)', 1, 1, 0)
-                """)
-            } else {
-                try executeSQL(db, """
-                    INSERT OR REPLACE INTO lyrics (item_pid, lyrics, store_lyrics_available, time_synced_lyrics_available)
-                    VALUES (\(itemPid), '\(lyricsContent)', 1, 1)
-                """)
-            }
+            // Payload + flags are chosen together by LyricsSyncWriter, so
+            // `time_synced_lyrics_available` can never again be 1 over a
+            // plain-text column. Bound parameters because a TTML payload
+            // is XML and hand-doubling `'` is not enough for it.
+            let lyricsRow = LyricsSyncWriter.row(
+                rawLyrics: song.lyrics,
+                title: song.title,
+                artist: song.artist,
+                trackDurationMs: song.durationMs,
+                hasCatalogMatch: hasAppleCatalogMatch)
+
+            if !LyricsSyncWriter.write(db: db, itemPid: itemPid, row: lyricsRow) {
+                Logger.shared.log("[MediaLibraryBuilder] lyrics write failed for \(song.title)")
+            }
```

`hasAppleCatalogMatch` is already in scope — it is computed ~40 lines
above for the `item_store` insert.

Note the ordering constraint: `LyricsSyncWriter.write` issues an `UPDATE
item_store SET extended_lyrics_attribute = …`, so it must run **after**
the `INSERT OR REPLACE INTO item_store`, which it does at this position.

---

## Patch 4 — the metadata-edit path writes lyrics too

**`MusicManager/iDeviceManager.swift`, line 3629**, inside
`updateExportableSongMetadata`.

Editing a track's metadata on-device rewrites the lyrics row with the
same `(1, 1)` flags, so any fix in `MediaLibraryBuilder` gets undone the
first time the user edits a tag.

```diff
                 """,
-                """
-                INSERT OR REPLACE INTO lyrics (item_pid, lyrics, store_lyrics_available, time_synced_lyrics_available)
-                VALUES (\(itemPid), '\(escapedLyrics)', 1, 1)
-                """
             ].allSatisfy { self.sqliteExec(db, $0) }
+
+            // Lyrics moved out of the interpolated batch — see patch 3.
+            let editedRow = LyricsSyncWriter.row(
+                rawLyrics: newLyrics,
+                title: newTitle,
+                artist: newArtist,
+                trackDurationMs: song.durationMs,
+                hasCatalogMatch: song.itemPid > 0 && storeItemId > 0)
+            let lyricsOK = LyricsSyncWriter.write(db: db, itemPid: itemPid, row: editedRow)
+            let success = success && lyricsOK
```

Adjust the local variable names to whatever is in scope at that call site
— `newLyrics` / `newTitle` / `newArtist` are the parameter names in the
surrounding signature, and `storeItemId` may need reading back from
`item_store` if it is not already available.

---

## Patch 5 — the `matchRedownloadParams` literal bug

**`MusicManager/MediaLibraryBuilder.swift`, line 880.**

Not a lyrics bug on its face, but it lands on the catalog-identity row
that the subscription lyrics path depends on, and it is live on every
catalog-matched track today.

```swift
let matchRedownloadParamsEscaped = hasAppleCatalogMatch
    ? "sagaId=\\(song.storeId)".replacingOccurrences(of: "'", with: "''")
    : ""
```

`"\\("` in a Swift string literal is a backslash followed by a paren, not
an interpolation. Every matched row gets the literal seven-character text
`sagaId=` followed by `\(song.storeId)`. A malformed redownload param is
exactly the sort of thing that makes the Music app decline to treat a row
as a catalog item — which would break lyrics resolution even with a valid
`store_item_id`.

```diff
             let matchRedownloadParamsEscaped = hasAppleCatalogMatch
-                ? "sagaId=\\(song.storeId)".replacingOccurrences(of: "'", with: "''")
+                ? "sagaId=\(song.storeId)".replacingOccurrences(of: "'", with: "''")
                 : ""
```

Query 6 in `tools/lyrics-probe.sql` tells you whether the broken value is
on your device right now.

---

## Patch 6 — settings UI

**`MusicManager/SettingsView.swift`**, near lines 29–30 and 1279.

The existing `appleSubscriptionLyrics` boolean is now one of four modes.
Keep the old key so nobody's setting resets — `LyricsDeliveryMode.current`
reads it as a fallback — and add a picker:

```swift
@AppStorage("lyricsDeliveryMode") private var lyricsDeliveryMode = ""

Picker("Lyrics source", selection: $lyricsDeliveryMode) {
    ForEach(LyricsDeliveryMode.allCases, id: \.rawValue) { mode in
        Text(mode.label).tag(mode.rawValue)
    }
}

if LyricsDeliveryMode(rawValue: lyricsDeliveryMode) == .cachedTTML {
    Text("Experimental. Converts synced lyrics to Apple's TTML format and "
       + "stores them on the device. Whether the Music app renders them is "
       + "unverified — see Debug Options → Lyrics Probe.")
        .font(.caption)
        .foregroundStyle(.secondary)
}
```

Then wire `LyricsSyncProbe.report(dbPath:)` into the existing Debug
Options screen, next to the database export. It takes a path to a
**pulled copy** of the database, never the live one.
