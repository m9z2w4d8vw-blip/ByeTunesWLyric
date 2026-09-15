// 04-ttml-selftest-safe.js
//
// Replaces 03, which crashed Music.app. Cause: `frida -f` spawns the
// process SUSPENDED and runs the script before resuming the main thread.
// Building an NSData and running MSVLyricsTTMLParser in that state means
// XML parsing with no run loop and no autorelease pool, which segfaults
// rather than returning nil. Nothing to do with the TTML itself.
//
// Three changes:
//   1. Recon runs FIRST. It is pure introspection — no methods called on
//      Apple objects — so it cannot crash, and a later crash can't cost
//      you the output.
//   2. The self-test is deferred and scheduled on the main queue inside
//      an autorelease pool, so it runs in a fully live process.
//   3. `selftest()` is also callable by hand from the REPL, which is the
//      safest moment of all — after the app has finished launching.
//
// Run (attach, preferred — open Music on the phone first):
//   frida -U -n Music -l tools\frida\04-ttml-selftest-safe.js
//
// Or spawn, which now survives it:
//   frida -U -f com.apple.Music -l tools\frida\04-ttml-selftest-safe.js

// ============================================================ RECON

function dump(name) {
  var cls = ObjC.classes[name];
  if (!cls) { console.log("\n### MISSING: " + name); return; }
  console.log("\n### " + name);
  var own = cls.$ownMethods;
  if (own.length === 0) { console.log("   (no ObjC-visible methods — pure Swift)"); return; }
  own.forEach(function (m) { console.log("   " + m); });
}

console.log("########## RECON ##########");

// The loader and the two competing view controllers. Music picks
// StaticLyricsViewController today; SyncedLyricsViewController is the one
// with the per-glyph renderer. Whatever chooses between them is the
// target — and if these come back "pure Swift" that tells us the choice
// is made above the ObjC boundary and we hook underneath it instead.
[
  "MusicLyricsLoader",
  "MusicNowPlayingLyricsViewController",
  "MusicApplication.StaticLyricsViewController",
  "MusicApplication.StaticLyricsContentViewController",
  "MusicCoreUI.SyncedLyricsViewController",
  "MusicCoreUI.SyncedLyricsManager",
  "MusicCoreUI.Lyrics"
].forEach(dump);

// What the parser produces, i.e. what the renderer consumes.
["MSVLyricsLine", "MSVLyricsWord", "MSVLyricsSection", "MSVLyricsAgent",
 "MSVLyricsElement", "MSVLyricsXMLElement"].forEach(dump);

// ============================================================ WATCHES

console.log("\n########## WATCHES ##########");

[
  ["MSVLyricsTTMLParser", "- initWithTTMLData:"],
  ["MSVLyricsTTMLParser", "- initWithTTMLStream:"],
  ["MSVLyricsTTMLParser", "- setTtmlData:"],
  ["MusicLyricsLoader",   "+ supportsLyricsFor:"],
  ["MPCModelGenericAVItem", "- nowPlayingInfoCenter:lyricsForContentItem:completion:"]
].forEach(function (p) {
  var cls = ObjC.classes[p[0]];
  if (!cls || !cls[p[1]]) { console.log("[absent]   " + p[0] + " " + p[1]); return; }
  Interceptor.attach(cls[p[1]].implementation, {
    onEnter: function () {
      console.log("\n*** CALLED: " + p[0] + " " + p[1]);
      console.log("  " + Thread.backtrace(this.context, Backtracer.ACCURATE)
        .map(DebugSymbol.fromAddress).slice(0, 10).join("\n  "));
    }
  });
  console.log("[watching] " + p[0] + " " + p[1]);
});

// ============================================================ SELF-TEST

var NSUTF8 = 4;

// Byte-for-byte what LyricsSyncFormat.ttml() emits, line-level (LRCLIB).
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

// Word-level — the shape that yields the per-glyph sweep.
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
'</p></div></body></tt>';

function runOne(label, xml) {
  console.log("\n===== SELF-TEST: " + label + " =====");

  var cls = ObjC.classes.MSVLyricsTTMLParser;
  if (!cls) { console.log("  MSVLyricsTTMLParser absent"); return; }

  var NSString = ObjC.classes.NSString;
  var s = NSString.stringWithUTF8String_(Memory.allocUtf8String(xml));
  var data = s.dataUsingEncoding_(NSUTF8);
  if (!data || data.handle.isNull()) { console.log("  could not build NSData"); return; }
  console.log("  NSData length = " + data.length());

  var parser = cls.alloc().initWithTTMLData_(data);
  if (!parser || parser.handle.isNull()) {
    console.log("  initWithTTMLData: returned NIL — the parser rejected this document");
    return;
  }
  console.log("  parser: OK (" + parser.$className + ")");

  var lines = parser.lyricLines();
  if (lines && !lines.handle.isNull()) {
    console.log("  lyricLines count = " + lines.count());
    if (lines.count() > 0) {
      var l0 = lines.objectAtIndex_(0);
      console.log("  line[0] class = " + l0.$className);
      console.log("  line[0] = " + l0.toString());
    }
  } else {
    console.log("  lyricLines = nil");
  }

  var info = parser.lyricsInfo();
  if (!info || info.handle.isNull()) { console.log("  lyricsInfo = nil"); return; }
  console.log("  lyricsInfo class = " + info.$className);

  try { console.log("  lyricsInfo.lyricsLines count = " + info.lyricsLines().count()); }
  catch (e) { console.log("  lyricsLines threw: " + e.message); }

  // The three queries the karaoke view makes every frame. If these
  // answer from our synthetic TTML, the whole pipeline is proven.
  try {
    var at = info.lyricsLinesAtTimeOffset_errorMargin_(25.0, 0.5);
    console.log("  linesAtTimeOffset(25.0) -> " + (at && !at.handle.isNull() ? at.toString() : "nil"));
  } catch (e) { console.log("  linesAtTimeOffset threw: " + e.message); }

  try {
    var w = info.lyricsWordsAtTimeOffset_errorMargin_(36.7, 0.5);
    console.log("  wordsAtTimeOffset(36.7) -> " + (w && !w.handle.isNull() ? w.toString() : "nil"));
  } catch (e) { console.log("  wordsAtTimeOffset threw: " + e.message); }

  try {
    var b = info.lyricsLineStartingBeforeTimeOffset_(30.0);
    console.log("  lineStartingBefore(30.0) -> " + (b && !b.handle.isNull() ? b.toString() : "nil"));
  } catch (e) { console.log("  lineStartingBefore threw: " + e.message); }
}

// Main queue + autorelease pool. Both matter: the parser is not
// documented as thread-safe, and without a pool every temporary it
// creates leaks into a thread that has none.
function selftest() {
  ObjC.schedule(ObjC.mainQueue, function () {
    var pool = ObjC.classes.NSAutoreleasePool.alloc().init();
    try {
      runOne("line-level", TTML_LINE);
      runOne("word-level", TTML_WORD);
      console.log("\n===== SELF-TEST DONE =====");
    } catch (e) {
      console.log("SELF-TEST EXCEPTION: " + e.message);
    } finally {
      pool.release();
    }
  });
}

// Exposed so it can be re-run by hand from the REPL once the app is
// visibly up, which is the safest moment.
global.selftest = selftest;

console.log("\n########## SELF-TEST ##########");
console.log("Auto-running in 5s. If nothing appears, type:  selftest()");
setTimeout(selftest, 5000);
