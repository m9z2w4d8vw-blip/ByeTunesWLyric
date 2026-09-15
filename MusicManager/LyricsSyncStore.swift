//
//  LyricsSyncStore.swift
//  MusicManager (ByeTunes)
//
//  Keeps the timed lyrics ByeTunes fetches, keyed so the karaoke view can
//  find them again for whatever Apple Music is playing.
//
//  WHY A SIDECAR AND NOT THE MEDIA DATABASE
//  ----------------------------------------
//  The `lyrics` table on iOS 17 has nowhere to put timing: no TTML
//  column, no `downloaded_catalog_lyrics_available`, and the Music app
//  renders that column as static text regardless. Anything written there
//  is display text and nothing more.
//
//  So the timed copy lives in ByeTunes' own app-group container instead,
//  where it is ours to read and cannot be rewritten by a PC sync or by
//  the Music app.
//
//  KEYING
//  ------
//  Primary key is `item_pid`, because `MPMediaItem.persistentID` is the
//  same number — the value ByeTunes itself generated and wrote into the
//  `item` table. That makes the lookup exact for anything it injected.
//
//  Secondary key is a normalised title|artist, for two cases the PID
//  cannot cover: a track that was re-injected and got a new PID, and a
//  track that arrived on the device some other way.
//

import Foundation

final class LyricsSyncStore {

    static let shared = LyricsSyncStore()

    private let fm = FileManager.default

    private var root: URL {
        let base = DeviceManager.sharedContainerURL ?? URL.documentsDirectory
        return base.appendingPathComponent("TimedLyrics", isDirectory: true)
    }

    private init() {
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
    }

    // MARK: - Keys

    private func pidURL(_ pid: Int64) -> URL {
        root.appendingPathComponent("pid_\(pid).lrc")
    }

    /// Lowercased, alphanumerics only. Mirrors the spirit of the
    /// signature ByeTunes already uses for duplicate detection
    /// (`title|artist|album`), minus the album — the karaoke view is
    /// matching against whatever MediaPlayer reports, and that does not
    /// always carry the same album string the injection used.
    private func slug(title: String, artist: String) -> String {
        let raw = "\(title)|\(artist)".lowercased()
        let cleaned = raw.unicodeScalars
            .map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "-" }
            .reduce(into: "") { $0.append($1) }
        let collapsed = cleaned
            .replacingOccurrences(of: "-+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        // Long non-ASCII titles can exceed the filename limit once
        // percent-escaped, so it is truncated rather than risking a
        // write failure that would look like "no lyrics".
        return String(collapsed.prefix(120))
    }

    private func slugURL(title: String, artist: String) -> URL {
        root.appendingPathComponent("name_\(slug(title: title, artist: artist)).lrc")
    }

    // MARK: - Write

    /// Store the timed source for a track, if it has any timing at all.
    ///
    /// Called at injection time, where both the raw provider payload and
    /// the freshly generated `item_pid` are in scope. Plain lyrics are
    /// skipped: a file with no timestamps would make the karaoke view
    /// offer a track it cannot actually sync.
    @discardableResult
    func save(rawLyrics: String?, itemPid: Int64, title: String, artist: String) -> Bool {
        guard let raw = rawLyrics?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return false }

        let parsed = LyricsSyncFormat.parseAny(raw)
        guard parsed.granularity != .none else {
            Logger.shared.log("[LyricsStore] \(title): no timing, not stored")
            return false
        }

        // Normalised back out to LRC so the stored form is one format
        // regardless of which provider it came from — LRCLIB line-level,
        // Enhanced LRC, or NetEase word-timed all round-trip through
        // `TimedLyrics`.
        guard let lrc = LyricsSyncFormat.lrc(from: parsed) else { return false }

        do {
            try fm.createDirectory(at: root, withIntermediateDirectories: true)
            let data = Data(lrc.utf8)
            try data.write(to: pidURL(itemPid), options: .atomic)
            try? data.write(to: slugURL(title: title, artist: artist), options: .atomic)
            Logger.shared.log(
                "[LyricsStore] stored \(parsed.granularity.rawValue)-timed lyrics for pid=\(itemPid) (\(parsed.lines.count) lines): \(title)")
            return true
        } catch {
            Logger.shared.log("[LyricsStore] write failed for \(title): \(error)")
            return false
        }
    }

    // MARK: - Read

    /// Look up by PID first, then by name. Returns the parsed model
    /// rather than the text, because every caller wants the timing.
    func lyrics(forItemPid pid: UInt64, title: String, artist: String) -> TimedLyrics? {
        if pid != 0, let text = try? String(contentsOf: pidURL(Int64(bitPattern: pid)), encoding: .utf8) {
            let parsed = LyricsSyncFormat.parseAny(text)
            if parsed.granularity != .none { return parsed }
        }
        if let text = try? String(contentsOf: slugURL(title: title, artist: artist), encoding: .utf8) {
            let parsed = LyricsSyncFormat.parseAny(text)
            if parsed.granularity != .none { return parsed }
        }
        return nil
    }

    /// Hand-attach lyrics for the current track — the escape hatch for
    /// anything already on the device whose timing was thrown away by the
    /// old code path, which is every track injected before this build.
    @discardableResult
    func saveRaw(_ text: String, itemPid: UInt64, title: String, artist: String) -> Bool {
        let parsed = LyricsSyncFormat.parseAny(text)
        guard parsed.granularity != .none,
              let lrc = LyricsSyncFormat.lrc(from: parsed) else { return false }
        let data = Data(lrc.utf8)
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
        if itemPid != 0 {
            try? data.write(to: pidURL(Int64(bitPattern: itemPid)), options: .atomic)
        }
        try? data.write(to: slugURL(title: title, artist: artist), options: .atomic)
        return true
    }

    // MARK: - Housekeeping

    var storedCount: Int {
        (try? fm.contentsOfDirectory(atPath: root.path))?
            .filter { $0.hasPrefix("pid_") && $0.hasSuffix(".lrc") }.count ?? 0
    }

    func deleteAll() {
        try? fm.removeItem(at: root)
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
    }
}
