// 08-find-swift-seam.js
//
// STATUS: the payload half is solved. 07 proved MSVLyricsTTMLParser
// accepts the TTML that LyricsSyncFormat.ttml() emits, that
// itunes:timing="Word" produces info.type = 2 ("Timed Words"), that
// <span> children become MSVLyricsWord objects with per-word start/end,
// and that wordsAtTimeOffset:errorMargin: / lyricsLineStartingBefore-
// TimeOffset: both answer. Every clock format works.
//
// REMAINING UNKNOWN: how an MSVLyricsSongInfo reaches the renderer.
// MusicCoreUI.SyncedLyricsManager and MusicCoreUI.Lyrics report no
// ObjC-visible methods, so the consumer is Swift and cannot be reached
// through ObjC.classes. Swift symbols are still in the symbol table
// though, and that is what this enumerates.
//
// Note: 06's `Module.enumerateExports("MediaServices")` threw "not a
// function" — that API was removed in Frida 17. The module object's own
// method is the replacement.
//
// Run (Music open):
//   frida -U -n Music -l tools\frida\08-find-swift-seam.js
// Then:  symbols()   and separately   watch()
// For watch(): open the lyrics view on the phone afterwards.

// ============================================ symbol search

function scan(moduleName, pattern, limit) {
  console.log("\n########## " + moduleName + "  /" + pattern.source + "/ ##########");
  var m;
  try { m = Process.getModuleByName(moduleName); }
  catch (e) { console.log("  module not loaded: " + e.message); return; }

  var seen = {};
  var out = [];

  function take(list, kind) {
    list.forEach(function (s) {
      if (!pattern.test(s.name)) return;
      if (seen[s.name]) return;
      seen[s.name] = 1;
      out.push("  [" + kind + "] " + s.name);
    });
  }

  try { take(m.enumerateSymbols(), "sym"); } catch (e) { console.log("  enumerateSymbols: " + e.message); }
  try { take(m.enumerateExports(), "exp"); } catch (e) { console.log("  enumerateExports: " + e.message); }

  if (out.length === 0) { console.log("  (no matches)"); return; }
  out.sort().slice(0, limit || 80).forEach(function (l) { console.log(l); });
  if (out.length > (limit || 80)) console.log("  … " + (out.length - (limit || 80)) + " more");
}

function symbols() {
  // Who constructs or consumes a lyrics song-info on the UI side.
  scan("MusicCoreUI", /SongInfo|Lyrics|TTML/, 120);
  scan("MusicApplication", /Lyrics|SongInfo/, 80);

  // And the provider side: what hands TTML to the parser normally.
  scan("MediaServices", /Lyric|TTML/i, 60);
  scan("MediaPlayer", /TTML|TimeSynced|LyricsItem/i, 60);

  // MusicCore sits between them.
  scan("MusicCore", /Lyrics|SongInfo|TTML/, 80);
}

// ============================================ live consumer watch

// Anything that queries an MSVLyricsSongInfo is, by definition, the
// renderer. Hooking the three query methods catches the consumer in the
// act and the backtrace names the Swift frame that owns it — which is
// the seam a tweak has to occupy.
function watch() {
  var info = ObjC.classes.MSVLyricsSongInfo;
  if (!info) { console.log("MSVLyricsSongInfo absent"); return; }

  [ "- lyricsLinesAtTimeOffset:errorMargin:",
    "- lyricsWordsAtTimeOffset:errorMargin:",
    "- lyricsLineStartingBeforeTimeOffset:",
    "- lyricsLines",
    "- setLyricsLines:",
    "- type" ].forEach(function (sel) {
    if (!info[sel]) { console.log("[absent] " + sel); return; }
    Interceptor.attach(info[sel].implementation, {
      onEnter: function () {
        console.log("\n*** CONSUMER: MSVLyricsSongInfo " + sel);
        console.log("  " + Thread.backtrace(this.context, Backtracer.ACCURATE)
          .map(DebugSymbol.fromAddress).slice(0, 14).join("\n  "));
      }
    });
    console.log("[watching] MSVLyricsSongInfo " + sel);
  });

  // And the provider side — if Music ever tries to fetch TTML for the
  // current track, these fire and the backtrace shows the requester.
  [ ["MSVLyricsTTMLParser", "- parseWithError:"],
    ["MSVLyricsTTMLParser", "- parseWithCompletion:"],
    ["MSVLyricsTTMLParser", "- initWithTTMLData:"],
    ["MPStoreLyricsResponse", "- setLyricsContent:"],
    ["MusicLyricsLoader", "+ supportsLyricsFor:"] ].forEach(function (p) {
    var cls = ObjC.classes[p[0]];
    if (!cls || !cls[p[1]]) { console.log("[absent] " + p[0] + " " + p[1]); return; }
    Interceptor.attach(cls[p[1]].implementation, {
      onEnter: function () {
        console.log("\n*** PROVIDER: " + p[0] + " " + p[1]);
        console.log("  " + Thread.backtrace(this.context, Backtracer.ACCURATE)
          .map(DebugSymbol.fromAddress).slice(0, 14).join("\n  "));
      }
    });
    console.log("[watching] " + p[0] + " " + p[1]);
  });

  // Force the availability flags so Music is at least willing to try.
  [ ["MPAVItem", "- hasTimeSyncedLyrics"],
    ["MPCModelGenericAVItem", "- hasTimeSyncedLyrics"],
    ["MPStoreItemMetadata", "- hasTimeSyncedLyrics"],
    ["MPStoreItemMetadata", "- hasLyrics"],
    ["MPAVItem", "- hasStoreLyrics"],
    ["MPCModelGenericAVItem", "- hasStoreLyrics"] ].forEach(function (p) {
    var cls = ObjC.classes[p[0]];
    if (!cls || !cls[p[1]]) return;
    Interceptor.attach(cls[p[1]].implementation, {
      onLeave: function (r) { if (r.toInt32() === 0) r.replace(ptr(1)); }
    });
  });
  console.log("[forcing] hasTimeSyncedLyrics / hasStoreLyrics -> YES");

  console.log("\nNow on the phone: play a track and open the lyrics view.");
}

console.log("\nReady.  symbols()   then   watch()  (then open lyrics on the phone)");
