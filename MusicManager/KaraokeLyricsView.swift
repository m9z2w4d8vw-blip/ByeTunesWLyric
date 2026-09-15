//
//  KaraokeLyricsView.swift
//  MusicManager (ByeTunes)
//
//  The karaoke view Music.app will not give us for local files.
//
//  It follows the system player — whatever Apple Music is playing — and
//  renders the timed lyrics ByeTunes stored at injection time: line
//  highlight, per-word sweep when the source has word timing, auto-scroll
//  and tap-to-seek.
//
//  Requires the Media Library entitlement prompt, hence
//  NSAppleMusicUsageDescription in Info.plist. Read-only: nothing here
//  modifies the library.
//

import SwiftUI
import MediaPlayer

struct KaraokeLyricsView: View {

    @StateObject private var clock = KaraokeClock()
    @Environment(\.dismiss) private var dismiss

    @State private var lyrics: TimedLyrics?
    @State private var loadedForID: UInt64 = 0
    @State private var authorized = false
    @State private var userScrolling = false
    @State private var lastAutoScrollLine = -1

    /// Lines resolved once per track rather than per frame. `normalized`
    /// fills in every missing end time, which the highlight maths depends
    /// on — see TimedLyrics.normalized(trackDurationMs:).
    private var lines: [TimedLine] { lyrics?.lines ?? [] }

    private var activeIndex: Int {
        let pos = clock.positionMs
        // Linear scan. A lyric sheet is tens of lines, and a binary
        // search here would be optimising the wrong thing while making
        // the "before the first line" and "in a gap" cases harder to
        // read.
        var found = -1
        for (i, line) in lines.enumerated() {
            if pos >= line.startMs { found = i } else { break }
        }
        // Past a line's end with a gap before the next one: nothing is
        // active, which is what makes an instrumental break look right.
        if found >= 0, let end = lines[found].endMs, pos > end {
            let nextStart = found + 1 < lines.count ? lines[found + 1].startMs : Int.max
            if nextStart - pos > 1200 { return -1 }
        }
        return found
    }

    var body: some View {
        NavigationStack {
            Group {
                if !authorized {
                    permissionPrompt
                } else if clock.nowPlayingID == 0 && clock.nowPlayingTitle.isEmpty {
                    message("Nothing playing",
                            "Start a track in the Music app and it will appear here.")
                } else if lyrics == nil {
                    message("No timed lyrics for this track",
                            "ByeTunes stores timed lyrics when it injects a song. Re-inject this track with Fetch Lyrics on, or attach an LRC by hand.")
                } else {
                    lyricsScroller
                }
            }
            .navigationTitle(clock.nowPlayingTitle.isEmpty ? "Lyrics" : clock.nowPlayingTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear {
            requestAuthorization()
            clock.start()
        }
        .onDisappear { clock.stop() }
        .onChange(of: clock.nowPlayingID) { _ in loadLyricsIfNeeded() }
        .onChange(of: clock.nowPlayingTitle) { _ in loadLyricsIfNeeded() }
    }

    // MARK: - Scroller

    private var lyricsScroller: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    // Padding at both ends so the first and last lines can
                    // still reach the centre of the viewport when
                    // auto-scrolled.
                    Spacer().frame(height: 120)

                    ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                        lineView(line, index: index)
                            .id(index)
                            .onTapGesture { clock.seek(toMs: line.startMs) }
                    }

                    Spacer().frame(height: 200)
                }
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: activeIndex) { newValue in
                guard newValue >= 0, newValue != lastAutoScrollLine else { return }
                lastAutoScrollLine = newValue
                withAnimation(.easeInOut(duration: 0.45)) {
                    proxy.scrollTo(newValue, anchor: .center)
                }
            }
        }
    }

    @ViewBuilder
    private func lineView(_ line: TimedLine, index: Int) -> some View {
        let isActive = index == activeIndex
        let isPast = index < activeIndex

        Group {
            if line.text.isEmpty {
                // Instrumental marker. Rendered as a small glyph rather
                // than an empty gap so the scroll position still has
                // something to land on.
                Image(systemName: "music.note")
                    .font(.title3)
                    .foregroundStyle(.secondary.opacity(isActive ? 0.9 : 0.25))
            } else if isActive && line.hasWordTiming {
                wordSweep(line)
            } else {
                Text(line.text)
                    .font(.system(size: isActive ? 30 : 26, weight: .bold, design: .rounded))
                    .foregroundStyle(isActive ? .primary : .secondary)
                    .opacity(isActive ? 1.0 : (isPast ? 0.35 : 0.5))
            }
        }
        .animation(.easeInOut(duration: 0.25), value: isActive)
    }

    /// Per-word highlight for the active line.
    ///
    /// Each syllable is its own Text so the sweep can advance without
    /// re-laying-out the line. The words are laid out with a wrapping
    /// HStack rather than one attributed string because a single string
    /// cannot animate a substring's colour independently.
    @ViewBuilder
    private func wordSweep(_ line: TimedLine) -> some View {
        let pos = clock.positionMs
        // FlowLayout is the one already declared in SettingsView.swift —
        // same `spacing` API, and a second copy in the same module is a
        // redeclaration error.
        FlowLayout(spacing: 0) {
            ForEach(Array(line.syllables.enumerated()), id: \.offset) { _, syl in
                let started = pos >= syl.startMs
                let ended = pos >= (syl.endMs ?? syl.startMs)
                Text(syl.text)
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(started ? .primary : .secondary)
                    .opacity(started ? 1.0 : 0.45)
                    // A small lift on the word currently being sung. The
                    // scale is deliberately subtle: anything larger
                    // reflows the line and the text visibly jitters.
                    .scaleEffect(started && !ended ? 1.06 : 1.0, anchor: .bottom)
                    .animation(.easeOut(duration: 0.18), value: started)
                    .animation(.easeOut(duration: 0.18), value: ended)
            }
        }
    }

    // MARK: - Chrome

    private var permissionPrompt: some View {
        message("Media Library access needed",
                "ByeTunes needs permission to see what the Music app is playing so it can follow along.") {
            Button("Allow Access") { requestAuthorization(force: true) }
                .buttonStyle(.borderedProminent)
        }
    }

    @ViewBuilder
    private func message(_ title: String, _ detail: String,
                         @ViewBuilder action: () -> some View = { EmptyView() }) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "quote.bubble")
                .font(.system(size: 42))
                .foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            action()
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Loading

    private func requestAuthorization(force: Bool = false) {
        let status = MPMediaLibrary.authorizationStatus()
        if status == .authorized {
            authorized = true
            loadLyricsIfNeeded()
            return
        }
        guard force || status == .notDetermined else { return }
        MPMediaLibrary.requestAuthorization { newStatus in
            DispatchQueue.main.async {
                authorized = (newStatus == .authorized)
                if authorized { loadLyricsIfNeeded() }
            }
        }
    }

    private func loadLyricsIfNeeded() {
        guard authorized else { return }
        let id = clock.nowPlayingID
        // Reload on a title change too: a re-injected track keeps its
        // title but gets a fresh PID, and the PID alone would miss that.
        if id == loadedForID && lyrics != nil && id != 0 { return }
        loadedForID = id
        lastAutoScrollLine = -1

        let found = LyricsSyncStore.shared.lyrics(
            forItemPid: id,
            title: clock.nowPlayingTitle,
            artist: clock.nowPlayingArtist)

        lyrics = found?.normalized(
            trackDurationMs: clock.durationMs > 0 ? clock.durationMs : nil)

        Logger.shared.log(
            "[Karaoke] pid=\(id) \"\(clock.nowPlayingTitle)\" -> " +
            (lyrics == nil ? "no stored lyrics"
                           : "\(lyrics!.lines.count) lines, \(lyrics!.granularity.rawValue)-timed"))
    }
}
