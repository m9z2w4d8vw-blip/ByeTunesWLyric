// 03-ttml-selftest.js
//
// Two jobs.
//
// (A) SELF-TEST. Feed MSVLyricsTTMLParser the exact TTML that
//     LyricsSyncFormat.ttml() emits and see whether Apple's own parser
//     accepts it. `initWithTTMLData:` takes bytes and returns a parsed
//     MSVLyricsSongInfo — no network, no entitlement. If this produces
//     lines, the emitter is validated against the real consumer and the
//     tweak has a guaranteed path. If it returns nil or zero lines, the
//     emitter is wrong and the error tells us how.
//
// (B) RECON. Dump the loader and the two view controllers, and watch for
//     anything that would ever hand TTML to the parser. Run 02 proved
//     the flags alone don't get us there, so the decision between
//     StaticLyricsViewController and SyncedLyricsViewController is made
//     somewhere else — this looks for where.
//
// Run: frida -U -f com.apple.Music -l 03-ttml-selftest.js

var NSUTF8 = 4;

function nsdata(str) {
  var NSString = ObjC.classes.NSString;
  var s = NSString.stringWithUTF8String_(Memory.allocUtf8String(str));
  return s.dataUsingEncoding_(NSUTF8);
}

// ---------------------------------------------------------------- (A)

// Line-level, the shape LRCLIB data produces. Byte-for-byte what
// LyricsSyncFormat.TTMLOptions.appleLike emits.
var TTML_LINE =
'<?xml version="1.0" encoding="UTF-8"?>' +
'<tt xmlns="http://www.w3.org/ns/ttml" ' +
'xmlns:ttm="http://www.w3.org/ns/ttml#metadata" ' +
'xmlns:itunes="http://music.apple.com/lyric-ttml-internal" ' +
'itunes:timing="Line" xml:lang="en">' +
'<head><metadata><ttm:agent type="person" xml:id="v1"/></metadata></head>' +
'<body dur="3:17.333">' +
'<div begin="0:22.820" end="0:34.000">' +
'<p begin="0:22.820" end="0:28.300" itunes:key="L1" ttm:agent="v1">When I met you in that hotel room</p>' +
'<p begin="0:28.300" end="0:34.000" itunes:key="L2" ttm:agent="v1">I could tell that you were so bad news</p>' +
'</div></body></tt>';

// Word-level, the shape NetEase yrc / Enhanced LRC produces. This is the
// one that would give the per-glyph sweep.
var TTML_WORD =
'<?xml version="1.0" encoding="UTF-8"?>' +
'<tt xmlns="http://www.w3.org/ns/ttml" ' +
'xmlns:ttm="http://www.w3.org/ns/ttml#metadata" ' +
'xmlns:itunes="http://music.apple.com/lyric-ttml-internal" ' +
'itunes:timing="Word" xml:lang="en">' +
'<head><metadata><ttm:agent type="person" xml:id="v1"/></metadata></head>' +
'<body dur="3:17.333">' +
'<div begin="0:36.240" end="0:40.000">' +
'<p begin="0:36.240" end="0:40.000" itunes:key="L1" ttm:agent="v1">' +
'<span begin="0:36.240" end="0:36.610">Fuck </span>' +
'<span begin="0:36.610" end="0:36.860">my </span>' +
'<span begin="0:36.860" end="0:37.150">life, </span>' +
'<span begin="0:37.150" end="0:37.400">can\'t </span>' +
'</p></div></body></tt>';

function selftest(label, xml) {
  console.log("\n===== SELF-TEST: " + label + " =====");
  try {
    var cls = ObjC.classes.MSVLyricsTTMLParser;
    if (!cls) { console.log("  MSVLyricsTTMLParser absent"); return; }

    var parser = cls.alloc().initWithTTMLData_(nsdata(xml));
    if (parser === null || parser.handle.isNull()) {
      console.log("  initWithTTMLData: returned NIL — parser rejected this document");
      return;
    }
    console.log("  parser: OK");

    var lines = parser.lyricLines();
    if (lines && !lines.handle.isNull()) {
      console.log("  lyricLines count = " + lines.count());
      // First line's class + description tells us the model shape.
      if (lines.count() > 0) {
        var l0 = lines.objectAtIndex_(0);
        console.log("  line[0] class = " + l0.$className);
        console.log("  line[0] = " + l0.toString());
      }
    } else {
      console.log("  lyricLines = nil");
    }

    var info = parser.lyricsInfo();
    if (info && !info.handle.isNull()) {
      console.log("  lyricsInfo class = " + info.$className);
      try { console.log("  lyricsInfo.lyricsLines = " + info.lyricsLines().count()); } catch (e) {}
      try { console.log("  lyricsInfo.lyricsSections = " + info.lyricsSections()); } catch (e) {}

      // The karaoke queries. If these answer, the renderer has
      // everything it needs.
      try {
        var at = info.lyricsLinesAtTimeOffset_errorMargin_(25.0, 0.5);
        console.log("  lyricsLinesAtTimeOffset(25.0) -> " + (at ? at.toString() : "nil"));
      } catch (e) { console.log("  lyricsLinesAtTimeOffset threw: " + e.message); }
      try {
        var w = info.lyricsWordsAtTimeOffset_errorMargin_(36.5, 0.5);
        console.log("  lyricsWordsAtTimeOffset(36.5) -> " + (w ? w.toString() : "nil"));
      } catch (e) { console.log("  lyricsWordsAtTimeOffset threw: " + e.message); }
      try {
        var before = info.lyricsLineStartingBeforeTimeOffset_(30.0);
        console.log("  lyricsLineStartingBeforeTimeOffset(30.0) -> " + (before ? before.toString() : "nil"));
      } catch (e) { console.log("  lyricsLineStartingBefore threw: " + e.message); }
    } else {
      console.log("  lyricsInfo = nil");
    }
  } catch (e) {
    console.log("  EXCEPTION: " + e.message);
  }
}

selftest("line-level", TTML_LINE);
selftest("word-level", TTML_WORD);

// ---------------------------------------------------------------- (B)

function dump(name) {
  var cls = ObjC.classes[name];
  if (!cls) { console.log("\n### MISSING: " + name); return; }
  console.log("\n### " + name);
  var own = cls.$ownMethods;
  if (own.length === 0) { console.log("   (no ObjC-visible methods — pure Swift)"); return; }
  own.forEach(function (m) { console.log("   " + m); });
}

// The loader and the two competing view controllers. Swift classes only
// expose @objc members, so these may come back thin — thin is itself
// information, because it means the decision is in Swift and has to be
// reached a different way.
[
  "MusicLyricsLoader",
  "MusicNowPlayingLyricsViewController",
  "MusicApplication.StaticLyricsViewController",
  "MusicApplication.StaticLyricsContentViewController",
  "MusicCoreUI.SyncedLyricsViewController",
  "MusicCoreUI.SyncedLyricsManager",
  "MusicCoreUI.Lyrics"
].forEach(dump);

// The parsed model objects, so we know what the renderer consumes.
["MSVLyricsLine", "MSVLyricsWord", "MSVLyricsSection", "MSVLyricsAgent"].forEach(dump);

// Watch every route into the parser. If ANY of these fires for any
// track, that is the seam to inject at.
[
  ["MSVLyricsTTMLParser", "- initWithTTMLData:"],
  ["MSVLyricsTTMLParser", "- initWithTTMLStream:"],
  ["MSVLyricsTTMLParser", "- setTtmlData:"],
  ["MusicLyricsLoader",   "+ supportsLyricsFor:"],
  ["MPCModelGenericAVItem", "- nowPlayingInfoCenter:lyricsForContentItem:completion:"]
].forEach(function (p) {
  var cls = ObjC.classes[p[0]];
  if (!cls || !cls[p[1]]) { console.log("[absent] " + p[0] + " " + p[1]); return; }
  Interceptor.attach(cls[p[1]].implementation, {
    onEnter: function () {
      console.log("\n*** CALLED: " + p[0] + " " + p[1]);
      console.log("  " + Thread.backtrace(this.context, Backtracer.ACCURATE)
        .map(DebugSymbol.fromAddress).slice(0, 10).join("\n  "));
    }
  });
  console.log("[watching] " + p[0] + " " + p[1]);
});

console.log("\nSelf-test is above and already done. Now play a track and open lyrics to exercise the watches.");
