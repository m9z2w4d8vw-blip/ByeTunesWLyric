//
//  LyricsSyncFormat.swift
//  MusicManager (ByeTunes)
//
//  Timed-lyrics parsing + Apple-shaped TTML emission.
//
//  WHY THIS FILE EXISTS
//  --------------------
//  ByeTunes currently throws away every piece of timing information it
//  fetches, in three separate places, and then tells the MediaLibrary
//  database that the track has time-synced lyrics anyway:
//
//    1. `SongMetadata.fetchLyricsFromLRCLIB` reads
//         (json["plainLyrics"] as? String) ?? (json["syncedLyrics"] as? String)
//       LRCLIB returns BOTH fields. `plainLyrics` is populated for almost
//       every track, so the `??` fallback to `syncedLyrics` is effectively
//       dead code and the timestamps are dropped at the source.
//
//    2. `SongMetadata.cleanLyrics` strips `[mm:ss.xx]` explicitly
//         #"\[\d{2,}:\d{2}(\.\d{2,})?\]"#
//       and then strips every remaining bracket group
//         #"\[[^\]]+\]"#
//       so even the one path that DOES prefer syncedLyrics
//       (`resolveLyrics(for:songTitle:songArtist:)`, the search sheet)
//       launders the timestamps back out before use.
//
//    3. `SongMetadata.stripTimedLyrics` does the same to the Musixmatch and
//       NetEase payloads — and its second alternation, `\([0-9]+,[0-9]+\)`,
//       is NetEase's per-word `(startMs,durationMs)` syllable timing. That
//       is word-level karaoke data being deleted.
//
//  Then `MediaLibraryBuilder.insertSongsWithExisting` writes
//    INSERT OR REPLACE INTO lyrics (..., store_lyrics_available,
//        time_synced_lyrics_available, downloaded_catalog_lyrics_available)
//    VALUES (..., 1, 1, 0)
//  i.e. it claims `time_synced_lyrics_available = 1` over a plain-text
//  payload with no timing in it at all, and hardcodes
//  `downloaded_catalog_lyrics_available = 0`.
//
//  This file is the missing middle: keep the timing, model it, and emit it
//  in the format the Music app's karaoke renderer consumes.
//
//  FORMAT NOTE / HONEST CAVEAT
//  ---------------------------
//  The TTML shape below is reconstructed from the structure Apple's
//  catalog lyrics endpoints return (`/lyrics` for line-level,
//  `/syllable-lyrics` for word-level "Apple Music Sing"). It is NOT
//  documented, and the exact attribute set the on-device renderer
//  requires has not been verified against a real device here. Run
//  `tools/lyrics-probe.sql` against a device database that has a working
//  downloaded catalog track first — that tells you the real shape, and
//  `TTMLOptions` exists so you can match whatever you find without
//  rewriting the emitter.
//

import Foundation

// MARK: - Model

/// One timed word / syllable inside a line.
struct TimedSyllable {
    var text: String
    var startMs: Int
    /// `nil` when the source only gave a start; resolved during
    /// `TimedLyrics.normalized()` from the following syllable's start, or
    /// from the line's end for the last one.
    var endMs: Int?
}

/// One timed line. `syllables` is empty for line-level-only sources
/// (plain LRC), populated for Enhanced LRC (A2) and NetEase word timing.
struct TimedLine {
    var startMs: Int
    var endMs: Int?
    var text: String
    var syllables: [TimedSyllable] = []

    var hasWordTiming: Bool { !syllables.isEmpty }
}

/// The parsed result. `granularity` is what decides whether the Music app
/// is told to highlight per line or per word.
struct TimedLyrics {
    enum Granularity: String {
        /// No usable timing — static lyrics only.
        case none = "None"
        /// Line-level highlight (whole line lights up).
        case line = "Line"
        /// Word-level highlight — the screenshot behaviour.
        case word = "Word"
    }

    var lines: [TimedLine]
    var granularity: Granularity
    /// Language tag if the source declared one (LRC `[la:]`, rare).
    var language: String?

    var isEmpty: Bool { lines.isEmpty }

    /// Flattened plain text, for the fallback write and for the
    /// `USLT`/`©lyr` tag path.
    var plainText: String {
        lines.map(\.text).joined(separator: "\n")
    }

    /// Fill in every missing `endMs` so the emitter never has to guess.
    ///
    /// A line with no explicit end gets the next line's start; the last
    /// line gets `trackDurationMs` when known, otherwise its own start
    /// plus a nominal tail. Syllables are chained the same way inside
    /// their line. Highlighting looks wrong in two distinct ways if this
    /// is skipped: a missing line end makes the current line never
    /// un-highlight, and a missing syllable end makes the sweep jump
    /// instead of sliding.
    func normalized(trackDurationMs: Int?) -> TimedLyrics {
        guard !lines.isEmpty else { return self }

        let tailPaddingMs = 3_000
        var out = lines.sorted { $0.startMs < $1.startMs }

        for i in out.indices {
            if out[i].endMs == nil {
                if i + 1 < out.count {
                    out[i].endMs = out[i + 1].startMs
                } else if let dur = trackDurationMs, dur > out[i].startMs {
                    out[i].endMs = dur
                } else {
                    out[i].endMs = out[i].startMs + tailPaddingMs
                }
            }

            // Clamp: a malformed source can hand us end < start, which
            // renders as a zero-or-negative-width highlight window.
            if let end = out[i].endMs, end <= out[i].startMs {
                out[i].endMs = out[i].startMs + 1
            }

            guard !out[i].syllables.isEmpty else { continue }

            let lineEnd = out[i].endMs ?? out[i].startMs
            var syls = out[i].syllables.sorted { $0.startMs < $1.startMs }
            for j in syls.indices {
                if syls[j].endMs == nil {
                    syls[j].endMs = (j + 1 < syls.count) ? syls[j + 1].startMs : lineEnd
                }
                if let e = syls[j].endMs, e <= syls[j].startMs {
                    syls[j].endMs = syls[j].startMs + 1
                }
            }
            out[i].syllables = syls
        }

        return TimedLyrics(lines: out, granularity: granularity, language: language)
    }
}

// MARK: - Parsing

enum LyricsSyncFormat {

    // MARK: LRC (and Enhanced LRC / A2 word timing)

    /// Line timestamp: `[mm:ss.xx]`, `[mm:ss.xxx]`, `[mm:ss]`, `[h:mm:ss.xx]`.
    /// Deliberately permissive on the fractional part — LRCLIB emits 2
    /// digits, Musixmatch 3, and some taggers emit none.
    private static let lineStampPattern =
        #"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]"#

    /// Enhanced-LRC word timestamp: `<mm:ss.xx>`.
    private static let wordStampPattern =
        #"<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>"#

    /// Metadata tag: `[ar:…]`, `[ti:…]`, `[offset:…]`, `[la:…]`.
    private static let metaTagPattern = #"^\[([a-zA-Z#]+):(.*)\]$"#

    /// Parse LRC or Enhanced LRC.
    ///
    /// Returns `.none` granularity (and no lines) when the input has no
    /// timestamps at all, so callers can cheaply detect "this was really
    /// plain text" without a second pass.
    static func parseLRC(_ raw: String) -> TimedLyrics {
        var offsetMs = 0
        var language: String?
        var lines: [TimedLine] = []
        var sawWordTiming = false

        let lineRegex = try? NSRegularExpression(pattern: lineStampPattern)
        let wordRegex = try? NSRegularExpression(pattern: wordStampPattern)
        let metaRegex = try? NSRegularExpression(pattern: metaTagPattern)

        for rawLine in raw.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }

            // Metadata tag lines (`[offset:+250]`) carry no lyric text.
            if let metaRegex,
               let m = metaRegex.firstMatch(
                   in: line, range: NSRange(line.startIndex..<line.endIndex, in: line)),
               let keyRange = Range(m.range(at: 1), in: line),
               let valRange = Range(m.range(at: 2), in: line) {
                let key = line[keyRange].lowercased()
                let value = line[valRange].trimmingCharacters(in: .whitespaces)
                switch key {
                case "offset":
                    // Positive offset means "shift lyrics later" in the
                    // de-facto LRC convention most editors follow.
                    offsetMs = Int(value) ?? 0
                case "la", "lang":
                    language = value.isEmpty ? nil : value
                default:
                    break
                }
                continue
            }

            guard let lineRegex else { continue }
            let nsLine = NSRange(line.startIndex..<line.endIndex, in: line)
            let stamps = lineRegex.matches(in: line, range: nsLine)
            guard !stamps.isEmpty else { continue }

            // One physical line can carry several timestamps (a repeated
            // chorus is stored once with N stamps). Emit one TimedLine per
            // stamp and let normalization sort them.
            let bodyStart = stamps.map(\.range.upperBound).max() ?? 0
            guard let bodyRange = Range(
                NSRange(location: bodyStart, length: nsLine.length - bodyStart), in: line)
            else { continue }
            let body = String(line[bodyRange])

            let (text, syllables) = splitWordStamps(
                body, regex: wordRegex, offsetMs: offsetMs)
            if !syllables.isEmpty { sawWordTiming = true }

            for stamp in stamps {
                guard let startMs = clockFromMatch(stamp, in: line) else { continue }
                let shifted = max(0, startMs + offsetMs)

                // Re-base the syllables of a repeated line onto this stamp.
                let rebased: [TimedSyllable]
                if syllables.isEmpty {
                    rebased = []
                } else if let first = syllables.first?.startMs {
                    let delta = shifted - first
                    rebased = syllables.map {
                        TimedSyllable(
                            text: $0.text,
                            startMs: max(0, $0.startMs + delta),
                            endMs: $0.endMs.map { max(0, $0 + delta) })
                    }
                } else {
                    rebased = syllables
                }

                let trimmed = text.trimmingCharacters(in: .whitespaces)
                // An empty body with a stamp is an interlude marker. Keep
                // it: it is what makes the previous line stop being
                // highlighted during an instrumental break.
                lines.append(TimedLine(
                    startMs: shifted, endMs: nil, text: trimmed, syllables: rebased))
            }
        }

        guard !lines.isEmpty else {
            return TimedLyrics(lines: [], granularity: .none, language: language)
        }
        return TimedLyrics(
            lines: lines,
            granularity: sawWordTiming ? .word : .line,
            language: language)
    }

    /// Split an Enhanced-LRC body into display text plus syllables.
    /// Returns `(text, [])` when the body carries no `<mm:ss.xx>` markers.
    private static func splitWordStamps(
        _ body: String, regex: NSRegularExpression?, offsetMs: Int
    ) -> (String, [TimedSyllable]) {
        guard let regex, !body.isEmpty else { return (body, []) }
        let ns = NSRange(body.startIndex..<body.endIndex, in: body)
        let marks = regex.matches(in: body, range: ns)
        guard !marks.isEmpty else { return (body, []) }

        var syllables: [TimedSyllable] = []
        var display = ""

        // Text before the first marker belongs to no syllable but is still
        // part of the line (some editors put a leading space there).
        if let lead = Range(NSRange(location: 0, length: marks[0].range.location), in: body) {
            display += body[lead]
        }

        for (idx, mark) in marks.enumerated() {
            guard let startMs = clockFromMatch(mark, in: body) else { continue }
            let textStart = mark.range.upperBound
            let textEnd = (idx + 1 < marks.count) ? marks[idx + 1].range.location : ns.length
            guard textEnd >= textStart,
                  let r = Range(NSRange(location: textStart, length: textEnd - textStart), in: body)
            else { continue }

            let chunk = String(body[r])
            display += chunk
            // Keep trailing whitespace ON the syllable: Apple's spans
            // include the separating space, and stripping it makes the
            // highlight visibly stutter at word boundaries.
            if !chunk.trimmingCharacters(in: .whitespaces).isEmpty {
                syllables.append(TimedSyllable(
                    text: chunk, startMs: max(0, startMs + offsetMs), endMs: nil))
            }
        }

        return (display, syllables)
    }

    private static func clockFromMatch(
        _ match: NSTextCheckingResult, in source: String
    ) -> Int? {
        func group(_ i: Int) -> String? {
            guard match.range(at: i).location != NSNotFound,
                  let r = Range(match.range(at: i), in: source) else { return nil }
            return String(source[r])
        }
        guard let a = group(1), let b = group(2),
              let first = Int(a), let second = Int(b) else { return nil }

        // Two-group form is mm:ss. There is no three-group LRC form in the
        // wild that we need here — `[h:mm:ss]` is vanishingly rare and
        // `[mm:ss]` with mm > 59 is the convention for long tracks.
        var ms = (first * 60 + second) * 1_000
        if let frac = group(3) {
            // "5" -> 500ms, "50" -> 500ms, "500" -> 500ms.
            let padded = frac.padding(toLength: 3, withPad: "0", startingAt: 0)
            ms += Int(padded) ?? 0
        }
        return ms
    }

    // MARK: NetEase word-timed (yrc / klyric)

    /// Line header `[startMs,durMs]` followed by `(startMs,durMs[,0])word`
    /// tuples. This is the payload `SongMetadata.stripTimedLyrics`
    /// currently deletes with `\([0-9]+,[0-9]+\)`.
    static func parseNetEaseWordTimed(_ raw: String) -> TimedLyrics {
        let headerPattern = #"^\[(\d+),(\d+)\]"#
        let tuplePattern = #"\((\d+),(\d+)(?:,\d+)?\)"#
        guard let headerRegex = try? NSRegularExpression(pattern: headerPattern),
              let tupleRegex = try? NSRegularExpression(pattern: tuplePattern)
        else { return TimedLyrics(lines: [], granularity: .none, language: nil) }

        var lines: [TimedLine] = []

        for rawLine in raw.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            let ns = NSRange(line.startIndex..<line.endIndex, in: line)

            var lineStart = 0
            var lineEnd: Int?
            var bodyStart = 0

            if let h = headerRegex.firstMatch(in: line, range: ns),
               let sr = Range(h.range(at: 1), in: line),
               let dr = Range(h.range(at: 2), in: line),
               let s = Int(line[sr]), let d = Int(line[dr]) {
                lineStart = s
                lineEnd = s + d
                bodyStart = h.range.upperBound
            }

            guard let bodyRange = Range(
                NSRange(location: bodyStart, length: ns.length - bodyStart), in: line)
            else { continue }
            let body = String(line[bodyRange])
            let bodyNS = NSRange(body.startIndex..<body.endIndex, in: body)
            let tuples = tupleRegex.matches(in: body, range: bodyNS)
            guard !tuples.isEmpty else { continue }

            var syllables: [TimedSyllable] = []
            var display = ""

            for (idx, t) in tuples.enumerated() {
                guard let sr = Range(t.range(at: 1), in: body),
                      let dr = Range(t.range(at: 2), in: body),
                      let rawStart = Int(body[sr]), let dur = Int(body[dr]) else { continue }

                // yrc uses absolute ms; some klyric dumps use an offset
                // from the line start. Treat a value below the line start
                // as relative — an absolute stamp can never precede its
                // own line.
                let startMs = rawStart >= lineStart ? rawStart : lineStart + rawStart

                let textStart = t.range.upperBound
                let textEnd = (idx + 1 < tuples.count) ? tuples[idx + 1].range.location : bodyNS.length
                guard textEnd >= textStart,
                      let r = Range(
                        NSRange(location: textStart, length: textEnd - textStart), in: body)
                else { continue }

                let chunk = String(body[r])
                display += chunk
                if !chunk.trimmingCharacters(in: .whitespaces).isEmpty {
                    syllables.append(TimedSyllable(
                        text: chunk, startMs: startMs, endMs: startMs + dur))
                }
            }

            guard !syllables.isEmpty else { continue }
            lines.append(TimedLine(
                startMs: syllables[0].startMs,
                endMs: lineEnd ?? syllables.last?.endMs,
                text: display.trimmingCharacters(in: .whitespaces),
                syllables: syllables))
        }

        guard !lines.isEmpty else {
            return TimedLyrics(lines: [], granularity: .none, language: nil)
        }
        return TimedLyrics(lines: lines, granularity: .word, language: nil)
    }

    // MARK: Auto-detect

    /// Try every parser, best granularity wins. Use this when the source
    /// is unknown (an embedded tag, a user paste, a provider that changed
    /// format).
    static func parseAny(_ raw: String) -> TimedLyrics {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return TimedLyrics(lines: [], granularity: .none, language: nil)
        }

        // TTML already? Hand it back untouched — re-parsing XML into our
        // line model and re-emitting would be lossy for no gain.
        if trimmed.hasPrefix("<") && trimmed.contains("<tt") {
            return TimedLyrics(lines: [], granularity: .none, language: nil)
        }

        let netease = parseNetEaseWordTimed(trimmed)
        if netease.granularity == .word { return netease }

        let lrc = parseLRC(trimmed)
        if lrc.granularity != .none { return lrc }

        return TimedLyrics(lines: [], granularity: .none, language: nil)
    }

    static func isTTML(_ raw: String) -> Bool {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.hasPrefix("<") && t.contains("<tt")
    }

    // MARK: - TTML emission

    struct TTMLOptions {
        /// `itunes:timing` value. Overriding lets you force line-level on
        /// a word-timed source (useful when bisecting a renderer that
        /// rejects syllable spans).
        var timingOverride: TimedLyrics.Granularity?
        /// Wrap each line's spans in `<div>` blocks. Apple groups lines
        /// into stanza divs; a single div holding every `<p>` is the
        /// simpler shape and worth trying first.
        var groupIntoStanzas: Bool = true
        /// Emit `ttm:agent` + a `head/metadata` agent declaration. Apple
        /// does this for duet/背景 vocal attribution.
        var emitAgent: Bool = true
        /// Emit `itunes:key="L1"` per line. Present in Apple payloads;
        /// unclear whether the renderer needs it.
        var emitLineKeys: Bool = true
        /// `<body dur="…">`. Omitted when the track duration is unknown.
        var trackDurationMs: Int?
        var language: String = "en"

        static let appleLike = TTMLOptions()
    }

    /// Emit Apple-shaped TTML for `lyrics`.
    ///
    /// The three attributes that carry the actual behaviour:
    ///   * `itunes:timing="Word"` — per-syllable sweep (the screenshot)
    ///   * `itunes:timing="Line"` — whole-line highlight
    ///   * `itunes:timing="None"` — static text, no highlight
    static func ttml(from lyrics: TimedLyrics, options: TTMLOptions = .appleLike) -> String? {
        let normalized = lyrics.normalized(trackDurationMs: options.trackDurationMs)
        guard !normalized.isEmpty else { return nil }

        let timing = options.timingOverride ?? normalized.granularity
        let lang = normalized.language ?? options.language

        var out = """
        <?xml version="1.0" encoding="UTF-8"?>
        <tt xmlns="http://www.w3.org/ns/ttml" \
        xmlns:ttm="http://www.w3.org/ns/ttml#metadata" \
        xmlns:itunes="http://music.apple.com/lyric-ttml-internal" \
        itunes:timing="\(timing.rawValue)" xml:lang="\(escape(lang))">
        """

        out += "<head><metadata>"
        if options.emitAgent {
            out += #"<ttm:agent type="person" xml:id="v1"/>"#
        }
        out += "</metadata></head>"

        if let dur = options.trackDurationMs {
            out += #"<body dur="\#(clock(dur))">"#
        } else {
            out += "<body>"
        }

        func paragraph(_ line: TimedLine, index: Int) -> String {
            let begin = clock(line.startMs)
            let end = clock(line.endMs ?? line.startMs)
            var attrs = #"begin="\#(begin)" end="\#(end)""#
            if options.emitLineKeys { attrs += #" itunes:key="L\#(index + 1)""# }
            if options.emitAgent { attrs += #" ttm:agent="v1""# }

            // An empty line is an interlude. Emit it with no content so
            // the renderer has something to advance to.
            guard !line.text.isEmpty else { return "<p \(attrs)></p>" }

            if timing == .word, line.hasWordTiming {
                let spans = line.syllables.map { syl in
                    #"<span begin="\#(clock(syl.startMs))" end="\#(clock(syl.endMs ?? syl.startMs))">\#(escape(syl.text))</span>"#
                }.joined()
                return "<p \(attrs)>\(spans)</p>"
            }
            return "<p \(attrs)>\(escape(line.text))</p>"
        }

        if options.groupIntoStanzas {
            // Break on interlude gaps: an empty line, or a >4s hole
            // between consecutive lines, starts a new stanza. That is
            // roughly how Apple's payloads are chunked.
            let gapThresholdMs = 4_000
            var stanzas: [[Int]] = []
            var current: [Int] = []
            for (i, line) in normalized.lines.enumerated() {
                let gap: Bool
                if let prev = current.last {
                    let prevEnd = normalized.lines[prev].endMs ?? normalized.lines[prev].startMs
                    gap = line.text.isEmpty || (line.startMs - prevEnd) > gapThresholdMs
                } else {
                    gap = false
                }
                if gap && !current.isEmpty {
                    stanzas.append(current)
                    current = []
                }
                if !line.text.isEmpty { current.append(i) }
            }
            if !current.isEmpty { stanzas.append(current) }

            for stanza in stanzas {
                guard let first = stanza.first, let last = stanza.last else { continue }
                let begin = clock(normalized.lines[first].startMs)
                let end = clock(normalized.lines[last].endMs ?? normalized.lines[last].startMs)
                out += #"<div begin="\#(begin)" end="\#(end)">"#
                for i in stanza { out += paragraph(normalized.lines[i], index: i) }
                out += "</div>"
            }
        } else {
            out += "<div>"
            for (i, line) in normalized.lines.enumerated() {
                out += paragraph(line, index: i)
            }
            out += "</div>"
        }

        out += "</body></tt>"
        return out
    }

    /// TTML clock-time. Apple's payloads use `M:SS.mmm` (and `H:MM:SS.mmm`
    /// past an hour); bare `SS.mmm` under a minute is also valid TTML and
    /// appears in some payloads.
    static func clock(_ ms: Int) -> String {
        let total = max(0, ms)
        let millis = total % 1_000
        let seconds = (total / 1_000) % 60
        let minutes = (total / 60_000) % 60
        let hours = total / 3_600_000
        if hours > 0 {
            return String(format: "%d:%02d:%02d.%03d", hours, minutes, seconds, millis)
        }
        return String(format: "%d:%02d.%03d", minutes, seconds, millis)
    }

    /// LRC round-trip, for the "write raw LRC and see what happens" test
    /// mode and for exporting a `.lrc` sidecar.
    static func lrc(from lyrics: TimedLyrics, includeWordTiming: Bool = true) -> String? {
        let normalized = lyrics.normalized(trackDurationMs: nil)
        guard !normalized.isEmpty else { return nil }

        func stamp(_ ms: Int, angle: Bool) -> String {
            let cs = (ms % 1_000) / 10
            let s = (ms / 1_000) % 60
            let m = ms / 60_000
            let body = String(format: "%02d:%02d.%02d", m, s, cs)
            return angle ? "<\(body)>" : "[\(body)]"
        }

        return normalized.lines.map { line in
            let head = stamp(line.startMs, angle: false)
            if includeWordTiming, line.hasWordTiming {
                let body = line.syllables
                    .map { stamp($0.startMs, angle: true) + $0.text }
                    .joined()
                return head + body
            }
            return head + line.text
        }.joined(separator: "\n")
    }

    // MARK: XML escaping

    /// `&` first, always — escaping it after `<` would double-escape the
    /// entities we just introduced.
    static func escape(_ s: String) -> String {
        var out = s.replacingOccurrences(of: "&", with: "&amp;")
        out = out.replacingOccurrences(of: "<", with: "&lt;")
        out = out.replacingOccurrences(of: ">", with: "&gt;")
        out = out.replacingOccurrences(of: "\"", with: "&quot;")
        out = out.replacingOccurrences(of: "'", with: "&apos;")
        // A stray control character makes the whole document unparseable,
        // which shows up as "no lyrics" rather than as an error.
        return String(out.unicodeScalars.filter {
            $0 == "\n" || $0 == "\t" || $0.value >= 0x20
        }.map(Character.init))
    }
}

// MARK: - Non-destructive cleaning

extension LyricsSyncFormat {

    /// The replacement for `SongMetadata.cleanLyrics` on timed input.
    ///
    /// `cleanLyrics` is fine for plain text and actively harmful for LRC:
    /// its `\[[^\]]+\]` catch-all removes the timestamps along with the
    /// junk. This does the same junk removal *per line body*, leaving
    /// every timing construct intact.
    static func cleanPreservingTiming(_ raw: String, title: String?, artist: String?) -> String {
        let noiseWords = ["lyrics", "letra", "contributors", "official", "video", "audio"]
        let lowTitle = title?.lowercased()

        var kept: [String] = []
        for rawLine in raw.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }

            // Keep LRC metadata tags — `[offset:]` in particular is load
            // bearing and dropping it silently desyncs everything.
            if line.range(of: #"^\[[a-zA-Z#]+:"#, options: .regularExpression) != nil {
                kept.append(line)
                continue
            }

            // Split leading timestamps from the body, scrub only the body.
            let stampPrefix = #"^((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]|\[\d+,\d+\])+)"#
            var head = ""
            var body = line
            if let r = line.range(of: stampPrefix, options: .regularExpression) {
                head = String(line[r])
                body = String(line[r.upperBound...])
            }

            var scrubbed = body.replacingOccurrences(
                of: #"\d+\s+Contributors"#, with: "", options: .regularExpression)
            // Section markers like "[Chorus]" — but only when they are the
            // entire body, so an in-line bracket in the lyric survives.
            if scrubbed.trimmingCharacters(in: .whitespaces)
                .range(of: #"^\[[^\]]+\]$"#, options: .regularExpression) != nil {
                scrubbed = ""
            }

            let trimmedBody = scrubbed.trimmingCharacters(in: .whitespaces)

            if let lowTitle, !trimmedBody.isEmpty {
                let low = trimmedBody.lowercased()
                if low == lowTitle { continue }
                if low.contains(lowTitle) {
                    var remainder = low.replacingOccurrences(of: lowTitle, with: "")
                    for noise in noiseWords {
                        remainder = remainder.replacingOccurrences(of: noise, with: "")
                    }
                    let clean = remainder
                        .trimmingCharacters(in: .punctuationCharacters)
                        .trimmingCharacters(in: .whitespaces)
                    if clean.isEmpty { continue }
                }
            }

            if head.isEmpty && trimmedBody.isEmpty { continue }
            kept.append(head + trimmedBody)
        }

        _ = artist  // parity with cleanLyrics' signature; unused there too
        return kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
