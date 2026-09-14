//
//  LyricsSyncWriter.swift
//  MusicManager (ByeTunes)
//
//  Writes the `lyrics` row — and the `item_store` columns that gate
//  lyrics resolution — with a flag combination that matches what the
//  payload actually contains.
//
//  WHAT THE THREE `lyrics` FLAGS APPEAR TO MEAN
//  --------------------------------------------
//  These are not documented. The reading below is inferred from the
//  column names, from how Apple's catalog lyrics endpoints are
//  structured, and from the fact that ByeTunes already ships an
//  `appleSubscriptionLyrics` toggle whose entire behaviour is to write an
//  EMPTY lyrics column — which only makes sense if a non-empty local
//  column shadows the catalog fetch.
//
//    store_lyrics_available            "the catalog has lyrics for this
//                                       item — go ask for them"
//    time_synced_lyrics_available      "the catalog lyrics are TIMED"
//    downloaded_catalog_lyrics_available
//                                      "the timed payload is already
//                                       cached locally — use the `lyrics`
//                                       column instead of the network"
//
//  ByeTunes currently writes `(1, 1, 0)` over plain text. Under the
//  reading above that is the worst of the three combinations: it promises
//  timed lyrics, declines to provide them locally, and then (if the track
//  has no valid catalog match) leaves the renderer with nothing timed to
//  fetch — so it falls back to static display.
//
//  The never-touched lever is the third flag. ByeTunes hardcodes it to 0
//  in both branches of the insert and never sets it anywhere else.
//
//  AND ONE MORE COLUMN NOBODY SETS
//  -------------------------------
//  `item_store.extended_lyrics_attribute` is declared in both schema
//  variants in `MediaLibraryBuilder.createSchema` and is written by
//  nothing in the codebase — grep it: two hits, both CREATE TABLE. On a
//  catalog track this is the most plausible candidate for the
//  "word-level / Apple Music Sing eligible" capability bit, sitting right
//  next to `extended_playback_attribute`. Worth sweeping (see
//  `LyricsSyncProbe.sweepExtendedLyricsAttribute`).
//
//  NOTHING HERE IS CONFIRMED. Run `tools/lyrics-probe.sql` first.
//

import Foundation
import SQLite3

private let LYRICS_SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

// MARK: - Delivery modes

enum LyricsDeliveryMode: String, CaseIterable {
    /// Write nothing locally; let the Music app resolve timed lyrics from
    /// the catalog. Needs an Apple Music subscription AND a correct
    /// `store_item_id`. This is ByeTunes' existing `appleSubscriptionLyrics`
    /// behaviour, and it is the only path that yields genuine
    /// Apple-authored syllable timing.
    case appleCatalog

    /// Write Apple-shaped TTML into the `lyrics` column and claim the
    /// catalog payload is cached. The hypothesis under test: if that
    /// column is the offline cache for catalog lyrics, this gets
    /// highlighting with no subscription and no network.
    case cachedTTML

    /// Write raw LRC into the column. Cheap to try and cheap to rule out
    /// — if the renderer happens to sniff for `[mm:ss]` this is a
    /// one-line win, and if it does not you have lost nothing.
    case rawLRC

    /// Current ByeTunes behaviour, with the flags corrected so they stop
    /// claiming timing that is not there.
    case plainOnly

    var label: String {
        switch self {
        case .appleCatalog: return "Apple Music (subscription)"
        case .cachedTTML:   return "Local TTML (experimental)"
        case .rawLRC:       return "Local LRC (experimental)"
        case .plainOnly:    return "Static lyrics only"
        }
    }

    static var storageKey: String { "lyricsDeliveryMode" }

    static var current: LyricsDeliveryMode {
        let raw = UserDefaults.standard.string(forKey: storageKey) ?? ""
        if let mode = LyricsDeliveryMode(rawValue: raw) { return mode }
        // Preserve the meaning of the existing toggle for anyone who had
        // it on before this shipped.
        if UserDefaults.standard.bool(forKey: "appleSubscriptionLyrics") { return .appleCatalog }
        return .plainOnly
    }
}

// MARK: - The row

struct LyricsRow {
    var payload: String
    var storeLyricsAvailable: Int
    var timeSyncedLyricsAvailable: Int
    var downloadedCatalogLyricsAvailable: Int
    var checksum: Int64
    /// Written to `item_store`, not `lyrics`. `nil` leaves the column alone.
    var extendedLyricsAttribute: Int?

    /// FNV-1a over the payload, folded into 32 bits.
    ///
    /// `lyrics.checksum` / `pending_checksum` are almost certainly a
    /// staleness comparison against the server's copy. Two readings, and
    /// they want opposite values:
    ///   * "checksum of the cached payload" → set it, so the cache
    ///     validates and is used.
    ///   * "checksum of the last payload the server gave us" → leave it 0,
    ///     so the app does not conclude the cache is current and skip a
    ///     fetch it needs.
    /// `.cachedTTML` sets it (we are asserting the cache IS current);
    /// every other mode leaves it 0. Flip `lyricsChecksumEnabled` to test
    /// the other reading without a rebuild.
    static func fnv1a32(_ s: String) -> Int64 {
        var hash: UInt32 = 0x811c_9dc5
        for byte in Data(s.utf8) {
            hash ^= UInt32(byte)
            hash = hash &* 0x0100_0193
        }
        // Keep it positive — the column is a signed INTEGER and a
        // negative checksum is a weird thing to hand a parser.
        return Int64(hash & 0x7fff_ffff)
    }
}

// MARK: - Builder

enum LyricsSyncWriter {

    static var checksumEnabled: Bool {
        UserDefaults.standard.object(forKey: "lyricsChecksumEnabled") as? Bool ?? true
    }

    /// Build the row for one song.
    ///
    /// - Parameters:
    ///   - rawLyrics: whatever the provider returned — plain, LRC,
    ///     Enhanced LRC, NetEase word-timed, or already-TTML.
    ///   - hasCatalogMatch: `song.storeId > 0` **and** the metadata source
    ///     gate (`shouldWriteAppleCatalogStoreFields`) passed. Without
    ///     this, `.appleCatalog` has nothing to resolve against and
    ///     degrades to no lyrics at all, so it falls back.
    static func row(
        rawLyrics: String?,
        title: String?,
        artist: String?,
        trackDurationMs: Int?,
        hasCatalogMatch: Bool,
        mode: LyricsDeliveryMode = .current
    ) -> LyricsRow {

        let raw = (rawLyrics ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        // Subscription mode: empty column on purpose, so the local text
        // cannot shadow the catalog payload. Only honour it when there IS
        // a catalog match — otherwise it produces a track with no lyrics
        // whatsoever, which is strictly worse than static text.
        if mode == .appleCatalog {
            if hasCatalogMatch {
                return LyricsRow(
                    payload: "",
                    storeLyricsAvailable: 1,
                    timeSyncedLyricsAvailable: 1,
                    downloadedCatalogLyricsAvailable: 0,
                    checksum: 0,
                    extendedLyricsAttribute: 1)
            }
            Logger.shared.log("[LyricsSync] appleCatalog requested but no catalog match — falling back")
        }

        guard !raw.isEmpty else {
            // No payload and no catalog match. Say so honestly: claiming
            // availability over an empty column is what produces the
            // "lyrics button does nothing" state.
            return LyricsRow(
                payload: "",
                storeLyricsAvailable: hasCatalogMatch ? 1 : 0,
                timeSyncedLyricsAvailable: 0,
                downloadedCatalogLyricsAvailable: 0,
                checksum: 0,
                extendedLyricsAttribute: nil)
        }

        // Already TTML (a provider handed us Apple's own payload, or a
        // previous run cached one) — pass it straight through.
        if LyricsSyncFormat.isTTML(raw) {
            return LyricsRow(
                payload: raw,
                storeLyricsAvailable: 1,
                timeSyncedLyricsAvailable: 1,
                downloadedCatalogLyricsAvailable: 1,
                checksum: checksumEnabled ? LyricsRow.fnv1a32(raw) : 0,
                extendedLyricsAttribute: raw.contains(#"itunes:timing="Word""#) ? 1 : nil)
        }

        let cleaned = LyricsSyncFormat.cleanPreservingTiming(raw, title: title, artist: artist)
        let parsed = LyricsSyncFormat.parseAny(cleaned)

        switch mode {
        case .cachedTTML:
            guard parsed.granularity != .none else { break }
            var opts = LyricsSyncFormat.TTMLOptions.appleLike
            opts.trackDurationMs = trackDurationMs
            guard let xml = LyricsSyncFormat.ttml(from: parsed, options: opts) else { break }

            Logger.shared.log(
                "[LyricsSync] TTML built: \(parsed.lines.count) lines, granularity=\(parsed.granularity.rawValue), \(xml.count) bytes")
            return LyricsRow(
                payload: xml,
                storeLyricsAvailable: 1,
                timeSyncedLyricsAvailable: 1,
                downloadedCatalogLyricsAvailable: 1,
                checksum: checksumEnabled ? LyricsRow.fnv1a32(xml) : 0,
                extendedLyricsAttribute: parsed.granularity == .word ? 1 : nil)

        case .rawLRC:
            guard parsed.granularity != .none,
                  let lrc = LyricsSyncFormat.lrc(from: parsed) else { break }
            return LyricsRow(
                payload: lrc,
                storeLyricsAvailable: 1,
                timeSyncedLyricsAvailable: 1,
                downloadedCatalogLyricsAvailable: 1,
                checksum: checksumEnabled ? LyricsRow.fnv1a32(lrc) : 0,
                extendedLyricsAttribute: parsed.granularity == .word ? 1 : nil)

        case .appleCatalog, .plainOnly:
            break
        }

        // Static fallback. The one substantive change from today's
        // behaviour: `time_synced_lyrics_available` is 0, because the
        // payload has no timing in it. Telling the truth here is what
        // lets the renderer pick the static layout immediately instead of
        // waiting on a timed payload that never arrives.
        let plain = parsed.granularity == .none ? cleaned : parsed.plainText
        return LyricsRow(
            payload: plain,
            storeLyricsAvailable: 1,
            timeSyncedLyricsAvailable: 0,
            downloadedCatalogLyricsAvailable: 0,
            checksum: 0,
            extendedLyricsAttribute: nil)
    }

    // MARK: - Persistence

    /// Write the row with **bound parameters**.
    ///
    /// Every other SQL statement in ByeTunes is string-interpolated with
    /// `'` doubled by hand. That survives plain lyrics; it will not
    /// survive a 6 KB XML document full of quotes and ampersands, and a
    /// single missed escape corrupts the whole database mid-injection.
    /// This path binds instead, so the payload is opaque to the parser.
    @discardableResult
    static func write(
        db: OpaquePointer?,
        itemPid: Int64,
        row: LyricsRow
    ) -> Bool {
        let hasDownloadedColumn = columnExists(
            db: db, table: "lyrics", column: "downloaded_catalog_lyrics_available")

        let sql = hasDownloadedColumn
            ? """
              INSERT OR REPLACE INTO lyrics
                (item_pid, lyrics, checksum, store_lyrics_available,
                 time_synced_lyrics_available, downloaded_catalog_lyrics_available)
              VALUES (?, ?, ?, ?, ?, ?)
              """
            : """
              INSERT OR REPLACE INTO lyrics
                (item_pid, lyrics, checksum, store_lyrics_available,
                 time_synced_lyrics_available)
              VALUES (?, ?, ?, ?, ?)
              """

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            Logger.shared.log("[LyricsSync] prepare failed: \(String(cString: sqlite3_errmsg(db)))")
            return false
        }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_int64(stmt, 1, itemPid)
        sqlite3_bind_text(stmt, 2, row.payload, -1, LYRICS_SQLITE_TRANSIENT)
        sqlite3_bind_int64(stmt, 3, row.checksum)
        sqlite3_bind_int(stmt, 4, Int32(row.storeLyricsAvailable))
        sqlite3_bind_int(stmt, 5, Int32(row.timeSyncedLyricsAvailable))
        if hasDownloadedColumn {
            sqlite3_bind_int(stmt, 6, Int32(row.downloadedCatalogLyricsAvailable))
        }

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            Logger.shared.log("[LyricsSync] step failed: \(String(cString: sqlite3_errmsg(db)))")
            return false
        }

        // `extended_lyrics_attribute` lives on item_store, which has
        // already been inserted by the time we get here, so this is an
        // UPDATE. Guarded on the column existing because the iOS 16
        // schema branch may predate it.
        if let attr = row.extendedLyricsAttribute,
           columnExists(db: db, table: "item_store", column: "extended_lyrics_attribute") {
            var upd: OpaquePointer?
            let usql = "UPDATE item_store SET extended_lyrics_attribute = ? WHERE item_pid = ?"
            if sqlite3_prepare_v2(db, usql, -1, &upd, nil) == SQLITE_OK {
                sqlite3_bind_int(upd, 1, Int32(attr))
                sqlite3_bind_int64(upd, 2, itemPid)
                _ = sqlite3_step(upd)
            }
            sqlite3_finalize(upd)
        }

        return true
    }

    /// Self-contained copy — `MediaLibraryBuilder.columnExists` is
    /// `private static` and not reachable from another file.
    static func columnExists(db: OpaquePointer?, table: String, column: String) -> Bool {
        var stmt: OpaquePointer?
        let sql = "PRAGMA table_info(\(table))"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return false }
        defer { sqlite3_finalize(stmt) }
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let name = sqlite3_column_text(stmt, 1),
               String(cString: name).caseInsensitiveCompare(column) == .orderedSame {
                return true
            }
        }
        return false
    }
}

// MARK: - On-device probe

/// Read-only introspection to settle the format question against a real
/// device instead of against a guess.
///
/// The decisive experiment: find a track on the device that ALREADY shows
/// karaoke lyrics offline — a downloaded Apple Music catalog track — and
/// look at what is actually in its `lyrics` row. If the column holds
/// TTML, `.cachedTTML` is the right approach and only the attribute set
/// needs matching. If it is empty, the payload never touches SQLite and
/// no amount of local writing will produce highlighting; `.appleCatalog`
/// is then the only path and the work moves to catalog matching.
enum LyricsSyncProbe {

    struct Finding {
        var itemPid: Int64
        var title: String
        var payloadBytes: Int
        var payloadHead: String
        var looksLikeTTML: Bool
        var timingAttribute: String?
        var checksum: Int64
        var storeAvailable: Int
        var timeSynced: Int
        var downloadedCatalog: Int
        var storeItemId: Int64
        var extendedLyricsAttribute: Int
    }

    /// Inspect a staged local copy of the device's MediaLibrary.
    /// Deliberately takes a path rather than a live handle — call it on a
    /// database pulled with `downloadFileFromDevice`, never on the live
    /// one.
    static func inspect(dbPath: String, limit: Int = 25) -> [Finding] {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            Logger.shared.log("[LyricsProbe] could not open \(dbPath)")
            return []
        }
        defer { sqlite3_close(db) }

        let hasDownloaded = LyricsSyncWriter.columnExists(
            db: db, table: "lyrics", column: "downloaded_catalog_lyrics_available")
        let hasExtended = LyricsSyncWriter.columnExists(
            db: db, table: "item_store", column: "extended_lyrics_attribute")

        let sql = """
            SELECT l.item_pid,
                   COALESCE(ie.title, ''),
                   LENGTH(l.lyrics),
                   SUBSTR(l.lyrics, 1, 300),
                   l.checksum,
                   l.store_lyrics_available,
                   l.time_synced_lyrics_available,
                   \(hasDownloaded ? "l.downloaded_catalog_lyrics_available" : "0"),
                   COALESCE(s.store_item_id, 0),
                   \(hasExtended ? "COALESCE(s.extended_lyrics_attribute, 0)" : "0")
              FROM lyrics l
              LEFT JOIN item_extra ie ON ie.item_pid = l.item_pid
              LEFT JOIN item_store s  ON s.item_pid  = l.item_pid
             ORDER BY LENGTH(l.lyrics) DESC
             LIMIT \(limit)
            """

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            Logger.shared.log("[LyricsProbe] prepare failed: \(String(cString: sqlite3_errmsg(db)))")
            return []
        }
        defer { sqlite3_finalize(stmt) }

        func text(_ i: Int32) -> String {
            guard let c = sqlite3_column_text(stmt, i) else { return "" }
            return String(cString: c)
        }

        var findings: [Finding] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let head = text(3)
            var timing: String?
            if let r = head.range(of: #"itunes:timing="[A-Za-z]+""#, options: .regularExpression) {
                timing = String(head[r])
                    .replacingOccurrences(of: "itunes:timing=", with: "")
                    .replacingOccurrences(of: "\"", with: "")
            }
            findings.append(Finding(
                itemPid: sqlite3_column_int64(stmt, 0),
                title: text(1),
                payloadBytes: Int(sqlite3_column_int(stmt, 2)),
                payloadHead: head,
                looksLikeTTML: LyricsSyncFormat.isTTML(head),
                timingAttribute: timing,
                checksum: sqlite3_column_int64(stmt, 4),
                storeAvailable: Int(sqlite3_column_int(stmt, 5)),
                timeSynced: Int(sqlite3_column_int(stmt, 6)),
                downloadedCatalog: Int(sqlite3_column_int(stmt, 7)),
                storeItemId: sqlite3_column_int64(stmt, 8),
                extendedLyricsAttribute: Int(sqlite3_column_int(stmt, 9))))
        }
        return findings
    }

    /// Human-readable dump for the Debug Logs screen. Paste this into a
    /// GitHub issue — it is the single most useful artifact for settling
    /// whether local timed lyrics are possible at all.
    static func report(dbPath: String) -> String {
        let findings = inspect(dbPath: dbPath)
        guard !findings.isEmpty else {
            return "[LyricsProbe] no rows in `lyrics` — nothing on this device has stored lyrics."
        }

        var out = "[LyricsProbe] \(findings.count) rows, largest first\n"
        var sawTTML = false
        for f in findings {
            if f.looksLikeTTML { sawTTML = true }
            out += """
            ─ pid=\(f.itemPid) "\(f.title)"
              bytes=\(f.payloadBytes) ttml=\(f.looksLikeTTML) timing=\(f.timingAttribute ?? "—")
              flags store=\(f.storeAvailable) timed=\(f.timeSynced) cached=\(f.downloadedCatalog)
              checksum=\(f.checksum) storeItemId=\(f.storeItemId) extLyricsAttr=\(f.extendedLyricsAttribute)
              head: \(f.payloadHead.prefix(160).replacingOccurrences(of: "\n", with: "⏎"))

            """
        }

        out += sawTTML
            ? "\nVERDICT: TTML found in the lyrics column → local timed lyrics are viable. Match the attribute set above in LyricsSyncFormat.TTMLOptions.\n"
            : "\nVERDICT: no TTML in any row → the timed payload is not cached in SQLite on this device. Either no downloaded catalog track was present to compare against, or the cache lives outside the database (check /iTunes_Control/iTunes/ for a lyrics store, and the Music app container). If the latter, `.appleCatalog` + correct catalog matching is the only route.\n"

        return out
    }

    /// Bisect `item_store.extended_lyrics_attribute`.
    ///
    /// The column is never written by ByeTunes and defaults to 0. If it
    /// is the word-level capability bit, one of these values turns the
    /// karaoke view on for an already-matched catalog track. Values are a
    /// guess at a bitfield; run one per injection and note which sticks.
    static func sweepExtendedLyricsAttribute(
        db: OpaquePointer?, itemPid: Int64, value: Int
    ) -> Bool {
        guard LyricsSyncWriter.columnExists(
            db: db, table: "item_store", column: "extended_lyrics_attribute") else { return false }
        var stmt: OpaquePointer?
        let sql = "UPDATE item_store SET extended_lyrics_attribute = ? WHERE item_pid = ?"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return false }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int(stmt, 1, Int32(value))
        sqlite3_bind_int64(stmt, 2, itemPid)
        return sqlite3_step(stmt) == SQLITE_DONE
    }

    /// Candidate values for the sweep above, in the order worth trying.
    static let extendedLyricsCandidates = [1, 2, 3, 4, 8, 16, 32]
}
