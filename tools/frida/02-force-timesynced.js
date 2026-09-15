// 02-force-timesynced.js — the five-minute experiment.
//
// Forces every hasTimeSyncedLyrics to YES and logs whoever then asks for
// a TTML payload. The point is not to make lyrics work; it is to find out
// WHICH selector gets called next, because that is the one that has to be
// fed. If MSVLyricsTTMLParser starts appearing, Route 2 is confirmed.
//
// Read-only apart from the four return values. Nothing is written to disk
// or to the library database.
//
// Run: frida -U -f com.apple.Music -l 02-force-timesynced.js

function forceYes(className, sel) {
  var cls = ObjC.classes[className];
  if (!cls || !cls[sel]) { console.log("[skip] " + className + " " + sel); return; }
  Interceptor.attach(cls[sel].implementation, {
    onLeave: function (retval) {
      if (retval.toInt32() === 0) {
        retval.replace(ptr(1));
        console.log("[forced YES] " + className + " " + sel);
      }
    }
  });
  console.log("[hooked] " + className + " " + sel);
}

[
  ["MPAVItem",            "- hasTimeSyncedLyrics"],
  ["MPCModelGenericAVItem","- hasTimeSyncedLyrics"],
  ["MPStoreItemMetadata", "- hasTimeSyncedLyrics"],
  ["MPAVItem",            "- hasStoreLyrics"],
  ["MPCModelGenericAVItem","- hasStoreLyrics"],
  ["MPStoreItemMetadata", "- hasLyrics"]
].forEach(function (p) { forceYes(p[0], p[1]); });

// Swift class name has a module prefix, so it needs the bracket syntax.
var swiftMeta = ObjC.classes["MusicCore.ModelObjectBackedStoreItemMetadata"];
if (swiftMeta) {
  ["- hasTimeSyncedLyrics", "- hasLyrics"].forEach(function (sel) {
    if (!swiftMeta[sel]) return;
    Interceptor.attach(swiftMeta[sel].implementation, {
      onLeave: function (retval) {
        if (retval.toInt32() === 0) retval.replace(ptr(1));
      }
    });
    console.log("[hooked] MusicCore.ModelObjectBackedStoreItemMetadata " + sel);
  });
}

// Now watch for anyone reaching for a timed payload. These are the
// selectors that were instrumented but never fired in the trace — if any
// of them wake up, that is the provider we have to satisfy.
[
  ["MSVLyricsTTMLParser",  "- setLyricsInfo:"],
  ["MSVLyricsTTMLParser",  "- setLyricLines:"],
  ["MSVLyricsSongInfo",    "- setLyricsLines:"],
  ["MSVLyricsSongInfo",    "- _sortLyricsLinesByStartTime:"],
  ["MPStoreLyricsResponse","- setLyricsContent:"],
  ["MPNowPlayingInfoLyricsItem", "- initWithLyrics:userProvided:token:"]
].forEach(function (p) {
  var cls = ObjC.classes[p[0]];
  if (!cls || !cls[p[1]]) { console.log("[absent] " + p[0] + " " + p[1]); return; }
  Interceptor.attach(cls[p[1]].implementation, {
    onEnter: function () {
      console.log("*** WOKE UP: " + p[0] + " " + p[1]);
      console.log(Thread.backtrace(this.context, Backtracer.ACCURATE)
        .map(DebugSymbol.fromAddress).slice(0, 8).join("\n  "));
    }
  });
  console.log("[watching] " + p[0] + " " + p[1]);
});

console.log("\nReady. On the phone: play a track, open lyrics, watch here.");
