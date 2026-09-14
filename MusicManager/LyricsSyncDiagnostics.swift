//
//  LyricsSyncDiagnostics.swift
//  MusicManager (ByeTunes)
//
//  In-app replacement for tools/lyrics-probe.sql, for when pulling the
//  database off the device by hand isn't an option.
//
//  Everything here is READ-ONLY. It downloads a copy of
//  MediaLibrary.sqlitedb over AFC, opens that copy with
//  SQLITE_OPEN_READONLY, and writes what it finds to Logger so it shows
//  up in Settings → Debug Options → Debug Logs.
//
//  WHAT IT IS FOR
//  --------------
//  The question that decides whether local time-synced lyrics are even
//  possible: does the Music app store timed lyrics in this database, or
//  does it stream them?
//
//  To answer it you need a CONTROL — a track on the device that already
//  shows word-by-word karaoke lyrics. That means an Apple Music catalog
//  track, downloaded for offline playback, on an active subscription.
//  `report()` flags any row that looks like TTML and says plainly what
//  the absence of one does and does not prove.
//

import Foundation
import SQLite3

enum LyricsSyncDiagnostics {

    private static let dbRemotePath = "/iTunes_Control/iTunes/MediaLibrary.sqlitedb"
    private static let walRemotePath = "/iTunes_Control/iTunes/MediaLibrary.sqlitedb-wal"
    private static let shmRemotePath = "/iTunes_Control/iTunes/MediaLibrary.sqlitedb-shm"

    /// Pull the library database and log a full report.
    ///
    /// Downloads the `-wal` and `-shm` too and checkpoints before reading.
    /// Without that the copy is stale and a row the Music app wrote
    /// minutes ago is invisible — which reads as "there are no lyrics"
    /// and is the single easiest way to draw the wrong conclusion here.
    static func run(completion: @escaping (String) -> Void) {
        Logger.shared.log("[LyricsDiag] ===== starting lyrics diagnostics =====")
        Logger.shared.log("[LyricsDiag] active mode: \(LyricsDeliveryMode.current.rawValue)")
        Logger.shared.log("[LyricsDiag] fetchLyrics=\(UserDefaults.standard.bool(forKey: "fetchLyrics")) appleSubscriptionLyrics=\(UserDefaults.standard.bool(forKey: "appleSubscriptionLyrics"))")
        Logger.shared.log("[LyricsDiag] metadataSource=\(UserDefaults.standard.string(forKey: "metadataSource") ?? "apple") flagOverride=\(UserDefaults.standard.string(forKey: "lyricsFlagOverride") ?? "none")")

        DispatchQueue.global(qos: .userInitiated).async {
            let manager = DeviceManager.shared

            func pull(_ path: String) -> Data? {
                let sem = DispatchSemaphore(value: 0)
                var out: Data?
                manager.downloadFileFromDevice(remotePath: path) { data in
                    out = data
                    sem.signal()
                }
                _ = sem.wait(timeout: .now() + 180)
                return out
            }

            guard let dbData = pull(dbRemotePath) else {
                let msg = "Could not download MediaLibrary.sqlitedb. Is the device connected?"
                Logger.shared.log("[LyricsDiag] ERROR: \(msg)")
                DispatchQueue.main.async { completion(msg) }
                return
            }
            let walData = pull(walRemotePath)
            let shmData = pull(shmRemotePath)

            Logger.shared.log("[LyricsDiag] pulled db=\(dbData.count)B wal=\(walData?.count ?? 0)B shm=\(shmData?.count ?? 0)B")

            let dir = FileManager.default.temporaryDirectory
                .appendingPathComponent("lyricsdiag_\(UUID().uuidString)", isDirectory: true)
            defer { try? FileManager.default.removeItem(at: dir) }

            let dbURL = dir.appendingPathComponent("MediaLibrary.sqlitedb")
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try dbData.write(to: dbURL)
                if let walData, !walData.isEmpty {
                    try walData.write(to: dir.appendingPathComponent("MediaLibrary.sqlitedb-wal"))
                }
                if let shmData, !shmData.isEmpty {
                    try shmData.write(to: dir.appendingPathComponent("MediaLibrary.sqlitedb-shm"))
                }
            } catch {
                let msg = "Could not stage the database copy: \(error)"
                Logger.shared.log("[LyricsDiag] ERROR: \(msg)")
                DispatchQueue.main.async { completion(msg) }
                return
            }

            // Checkpoint the WAL into the copy (read-write open, on OUR
            // copy only — the device's file is never touched).
            var wdb: OpaquePointer?
            if sqlite3_open(dbURL.path, &wdb) == SQLITE_OK {
                sqlite3_exec(wdb, "PRAGMA wal_checkpoint(TRUNCATE)", nil, nil, nil)
                sqlite3_close(wdb)
                Logger.shared.log("[LyricsDiag] WAL checkpointed into local copy")
            }

            let summary = report(dbPath: dbURL.path)
            for line in summary.components(separatedBy: "\n") where !line.isEmpty {
                Logger.shared.log("[LyricsDiag] \(line)")
            }
            Logger.shared.log("[LyricsDiag] ===== diagnostics complete =====")
            DispatchQueue.main.async { completion(summary) }
        }
    }

    // MARK: - Report

    private struct Row {
        var pid: Int64 = 0
        var title = ""
        var artist = ""
        var bytes = 0
        var head = ""
        var checksum: Int64 = 0
        var storeAvail = 0
        var timed = 0
        var cached = 0
        var storeItemId: Int64 = 0
        var subStoreItemId: Int64 = 0
        var ext = 0
        var sagaId: Int64 = 0

        var looksTTML: Bool { head.hasPrefix("<") && head.contains("<tt") }
        var looksLRC: Bool {
            head.range(of: #"\[\d{1,3}:\d{2}"#, options: .regularExpression) != nil
        }
        /// A ByeTunes-injected track claims a catalog match by stamping
        /// `store_saga_id`; a genuine catalog track does not.
        var isInjected: Bool { sagaId != 0 || storeItemId == 0 }
    }

    static func report(dbPath: String) -> String {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            return "Could not open the database copy."
        }
        defer { sqlite3_close(db) }

        let hasCached = LyricsSyncWriter.columnExists(
            db: db, table: "lyrics", column: "downloaded_catalog_lyrics_available")
        let hasExt = LyricsSyncWriter.columnExists(
            db: db, table: "item_store", column: "extended_lyrics_attribute")

        var out = ""
        out += "schema: downloaded_catalog_lyrics_available=\(hasCached ? "yes" : "NO") extended_lyrics_attribute=\(hasExt ? "yes" : "NO")\n"

        // --- counts ---
        func scalar(_ sql: String) -> Int {
            var s: OpaquePointer?
            defer { sqlite3_finalize(s) }
            guard sqlite3_prepare_v2(db, sql, -1, &s, nil) == SQLITE_OK,
                  sqlite3_step(s) == SQLITE_ROW else { return -1 }
            return Int(sqlite3_column_int(s, 0))
        }

        let totalTracks = scalar("SELECT COUNT(*) FROM item WHERE media_type = 8")
        let lyricsRows = scalar("SELECT COUNT(*) FROM lyrics")
        let nonEmpty = scalar("SELECT COUNT(*) FROM lyrics WHERE LENGTH(lyrics) > 0")
        let timedFlag = scalar("SELECT COUNT(*) FROM lyrics WHERE time_synced_lyrics_available = 1")
        let cachedFlag = hasCached
            ? scalar("SELECT COUNT(*) FROM lyrics WHERE downloaded_catalog_lyrics_available = 1")
            : -1
        out += "counts: tracks=\(totalTracks) lyricsRows=\(lyricsRows) nonEmpty=\(nonEmpty) timedFlag=\(timedFlag) cachedFlag=\(cachedFlag)\n"

        if hasExt {
            let extSet = scalar("SELECT COUNT(*) FROM item_store WHERE extended_lyrics_attribute <> 0")
            out += "extended_lyrics_attribute non-zero on \(extSet) tracks\n"
        }

        // --- rows, biggest payload first ---
        let sql = """
            SELECT l.item_pid,
                   COALESCE(ie.title, ''),
                   COALESCE(ia.item_artist, ''),
                   LENGTH(COALESCE(l.lyrics, '')),
                   SUBSTR(COALESCE(l.lyrics, ''), 1, 240),
                   l.checksum,
                   l.store_lyrics_available,
                   l.time_synced_lyrics_available,
                   \(hasCached ? "l.downloaded_catalog_lyrics_available" : "-1"),
                   COALESCE(s.store_item_id, 0),
                   COALESCE(s.subscription_store_item_id, 0),
                   \(hasExt ? "COALESCE(s.extended_lyrics_attribute, 0)" : "-1"),
                   COALESCE(s.store_saga_id, 0)
              FROM lyrics l
              LEFT JOIN item_extra  ie ON ie.item_pid = l.item_pid
              LEFT JOIN item        it ON it.item_pid = l.item_pid
              LEFT JOIN item_artist ia ON ia.item_artist_pid = it.item_artist_pid
              LEFT JOIN item_store  s  ON s.item_pid  = l.item_pid
             ORDER BY LENGTH(COALESCE(l.lyrics, '')) DESC
             LIMIT 30
            """

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            return out + "query failed: \(String(cString: sqlite3_errmsg(db)))\n"
        }
        defer { sqlite3_finalize(stmt) }

        func text(_ i: Int32) -> String {
            guard let c = sqlite3_column_text(stmt, i) else { return "" }
            return String(cString: c)
        }

        var rows: [Row] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            var r = Row()
            r.pid = sqlite3_column_int64(stmt, 0)
            r.title = text(1)
            r.artist = text(2)
            r.bytes = Int(sqlite3_column_int(stmt, 3))
            r.head = text(4)
            r.checksum = sqlite3_column_int64(stmt, 5)
            r.storeAvail = Int(sqlite3_column_int(stmt, 6))
            r.timed = Int(sqlite3_column_int(stmt, 7))
            r.cached = Int(sqlite3_column_int(stmt, 8))
            r.storeItemId = sqlite3_column_int64(stmt, 9)
            r.subStoreItemId = sqlite3_column_int64(stmt, 10)
            r.ext = Int(sqlite3_column_int(stmt, 11))
            r.sagaId = sqlite3_column_int64(stmt, 12)
            rows.append(r)
        }

        out += "\n--- top \(rows.count) lyrics rows by payload size ---\n"
        for r in rows {
            let kind = r.looksTTML ? "TTML" : (r.looksLRC ? "LRC" : (r.bytes == 0 ? "empty" : "plain"))
            let origin = r.isInjected ? "injected" : "catalog"
            out += "[\(origin)/\(kind)] \"\(r.title)\" — \(r.artist)\n"
            out += "   bytes=\(r.bytes) flags(store/timed/cached)=\(r.storeAvail)/\(r.timed)/\(r.cached) checksum=\(r.checksum)\n"
            out += "   storeItemId=\(r.storeItemId) subStoreId=\(r.subStoreItemId) sagaId=\(r.sagaId) extLyrics=\(r.ext)\n"
            let oneLine = r.head
                .replacingOccurrences(of: "\n", with: "|")
                .replacingOccurrences(of: "\r", with: "")
            out += "   head: \(oneLine.prefix(200))\n"
        }

        // --- verdict ---
        let ttmlRows = rows.filter(\.looksTTML)
        let catalogRows = rows.filter { !$0.isInjected }
        let catalogWithPayload = catalogRows.filter { $0.bytes > 0 }

        out += "\n--- VERDICT ---\n"
        if let first = ttmlRows.first {
            out += "TTML FOUND in the lyrics column (\"\(first.title)\").\n"
            out += "Local timed lyrics ARE viable. Copy the attribute set from that row's head\n"
            out += "into LyricsSyncFormat.TTMLOptions and use mode=cachedTTML.\n"
            if let timing = first.head.range(of: #"itunes:timing="[A-Za-z]+""#, options: .regularExpression) {
                out += "Its timing attribute: \(first.head[timing])\n"
            }
        } else if catalogRows.isEmpty {
            out += "INCONCLUSIVE: no genuine catalog track found in the top rows.\n"
            out += "Every row looks ByeTunes-injected, so there is nothing to compare against.\n"
            out += "To settle this you need a control: download an Apple Music catalog track\n"
            out += "that shows word-by-word lyrics, confirm the karaoke view still works with\n"
            out += "Wi-Fi and cellular OFF, then run this again.\n"
        } else if catalogWithPayload.isEmpty {
            out += "NO local payload on any catalog track (\(catalogRows.count) checked).\n"
            out += "If one of those shows karaoke lyrics OFFLINE, the payload is not kept in\n"
            out += "this database and mode=cachedTTML cannot work — the only route is\n"
            out += "mode=appleCatalog plus a correct store_item_id per track.\n"
        } else {
            out += "Catalog tracks DO carry a local payload but none of it is TTML.\n"
            out += "Look at the head values above: whatever format they use is the one to emit.\n"
        }

        let injectedTimedLying = rows.filter { $0.isInjected && $0.timed == 1 && !$0.looksTTML && !$0.looksLRC && $0.bytes > 0 }
        if !injectedTimedLying.isEmpty {
            out += "\nWARNING: \(injectedTimedLying.count) injected row(s) still claim time_synced_lyrics_available=1\n"
            out += "over plain text. Those were written by the OLD code — re-inject them.\n"
        }

        return out
    }
}
