//
//  KaraokeClock.swift
//  MusicManager (ByeTunes)
//
//  A smooth playback clock for whatever Apple Music is playing.
//
//  WHY THIS EXISTS
//  ---------------
//  Twelve Frida sessions established that Music.app's own synced-lyrics
//  renderer will not accept a locally-supplied payload: the TTML can only
//  arrive through a catalog fetch, and for a sideloaded track there is no
//  MPModelLyrics object for the loader to read at all.
//
//  What those sessions DID establish is that the timing model is sound.
//  So ByeTunes renders the karaoke view itself, and takes the clock from
//  the system player over public API.
//
//  THE PRECISION PROBLEM
//  ---------------------
//  `MPMusicPlayerController.currentPlaybackTime` is not a high-resolution
//  clock. It advances in coarse steps — often only a few times a second —
//  because it is a cross-process query, not a sample counter. Polling it
//  at 60 Hz and using the raw value makes a word-level highlight jump in
//  visible chunks rather than sweeping.
//
//  So it is used as an ANCHOR, not as the clock. Each time the reported
//  value actually changes we record (playbackTime, CACurrentMediaTime)
//  and thereafter interpolate forward from that pair. The system value
//  corrects drift; the media clock provides smoothness. A seek or a
//  pause shows up as a discontinuity and re-anchors immediately.
//

import Foundation
import MediaPlayer
import QuartzCore
import Combine

@MainActor
final class KaraokeClock: ObservableObject {

    /// Interpolated playback position. Updated at `tickHz`.
    @Published private(set) var positionMs: Int = 0
    @Published private(set) var isPlaying: Bool = false
    /// `persistentID` of the current item, which is the same value
    /// ByeTunes wrote as `item.item_pid`.
    @Published private(set) var nowPlayingID: UInt64 = 0
    @Published private(set) var nowPlayingTitle: String = ""
    @Published private(set) var nowPlayingArtist: String = ""
    @Published private(set) var durationMs: Int = 0

    /// Display refresh for the interpolated value.
    private let tickHz: Double = 30
    /// How often the system player is re-read. More often than this is
    /// wasted work — the value does not change faster.
    private let resyncInterval: TimeInterval = 0.25

    private var anchorPlayback: TimeInterval = 0
    private var anchorHost: CFTimeInterval = 0
    private var lastRawPlayback: TimeInterval = -1
    private var lastResync: CFTimeInterval = 0

    private var timer: Timer?
    private let player = MPMusicPlayerController.systemMusicPlayer

    /// A jump larger than this between two reads is treated as a seek or
    /// a track change rather than as drift, and re-anchors hard. Chosen
    /// above the worst-case reporting lag but below the shortest seek a
    /// user would make.
    private let seekThreshold: TimeInterval = 1.0

    deinit { timer?.invalidate() }

    func start() {
        guard timer == nil else { return }

        player.beginGeneratingPlaybackNotifications()
        NotificationCenter.default.addObserver(
            self, selector: #selector(playbackStateChanged),
            name: .MPMusicPlayerControllerPlaybackStateDidChange, object: player)
        NotificationCenter.default.addObserver(
            self, selector: #selector(nowPlayingChanged),
            name: .MPMusicPlayerControllerNowPlayingItemDidChange, object: player)

        readNowPlaying()
        hardResync()

        let t = Timer(timeInterval: 1.0 / tickHz, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        // .common so the clock keeps running while the user drags a
        // scroll view — otherwise the highlight freezes exactly when
        // someone is looking at it.
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        NotificationCenter.default.removeObserver(self)
        player.endGeneratingPlaybackNotifications()
    }

    /// Seek the system player. Used by tap-to-seek on a lyric line.
    func seek(toMs ms: Int) {
        let seconds = Double(max(0, ms)) / 1000.0
        player.currentPlaybackTime = seconds
        anchorPlayback = seconds
        anchorHost = CACurrentMediaTime()
        lastRawPlayback = seconds
        positionMs = ms
    }

    // MARK: - Internals

    @objc private func playbackStateChanged() {
        Task { @MainActor in
            isPlaying = (player.playbackState == .playing)
            hardResync()
        }
    }

    @objc private func nowPlayingChanged() {
        Task { @MainActor in
            readNowPlaying()
            hardResync()
        }
    }

    private func readNowPlaying() {
        let item = player.nowPlayingItem
        nowPlayingID = item?.persistentID ?? 0
        nowPlayingTitle = item?.title ?? ""
        nowPlayingArtist = item?.artist ?? ""
        durationMs = Int((item?.playbackDuration ?? 0) * 1000)
        isPlaying = (player.playbackState == .playing)
    }

    private func hardResync() {
        let raw = player.currentPlaybackTime
        // NaN shows up between tracks and would poison every later
        // comparison, so it is rejected rather than clamped.
        guard raw.isFinite, raw >= 0 else { return }
        anchorPlayback = raw
        anchorHost = CACurrentMediaTime()
        lastRawPlayback = raw
        lastResync = anchorHost
        positionMs = Int(raw * 1000)
    }

    private func tick() {
        let now = CACurrentMediaTime()

        // Re-read the system player occasionally to correct drift and to
        // notice seeks made elsewhere (Control Center, the Music app
        // itself, a Bluetooth remote).
        if now - lastResync >= resyncInterval {
            lastResync = now
            let raw = player.currentPlaybackTime
            if raw.isFinite, raw >= 0 {
                if lastRawPlayback < 0 || abs(raw - lastRawPlayback) > seekThreshold {
                    // Seek or track change: trust the new value outright.
                    anchorPlayback = raw
                    anchorHost = now
                } else if raw != lastRawPlayback {
                    // The reported value stepped forward. Re-anchor on it,
                    // which keeps interpolation from accumulating error
                    // over a long track.
                    anchorPlayback = raw
                    anchorHost = now
                }
                lastRawPlayback = raw
            }
        }

        guard isPlaying else {
            // Paused: hold position rather than letting the media clock
            // run on. Not doing this makes the highlight drift away from
            // the audio while the user reads.
            positionMs = Int(anchorPlayback * 1000)
            return
        }

        let interpolated = anchorPlayback + (now - anchorHost)
        let clamped = durationMs > 0
            ? min(interpolated, Double(durationMs) / 1000.0)
            : interpolated
        positionMs = Int(max(0, clamped) * 1000)
    }
}
