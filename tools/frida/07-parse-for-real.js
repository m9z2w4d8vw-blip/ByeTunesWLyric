// 07-parse-for-real.js
//
// 06 found the trigger. MSVLyricsTTMLParser is an NSXMLParser delegate:
//
//   - parseWithError:      <- synchronous, returns BOOL + NSError**
//   - parseWithCompletion: <- async, dispatches on -parseQueue
//   - parser:didStartElement:namespaceURI:qualifiedName:attributes:
//   - parser:foundCharacters:
//   - parser:parseErrorOccurred:
//   - elementStack / currentTextElement   <- SAX accumulators
//
// `initWithTTMLData:` only wraps the bytes in a stream (ttmlData comes
// back nil afterwards). Nothing is parsed until parseWithError: runs,
// which is why 05 saw elems=0 on every variant — the format was never
// evaluated at all.
//
// Now each attempt yields a BOOL and a real NSError, so a rejection is
// diagnostic instead of silent.
//
// Run (Music open):
//   frida -U -n Music -l tools\frida\07-parse-for-real.js
// Then:  go()

var NSUTF8 = 4;

// ---------------------------------------------------------- time formats

function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }
function hmsm(ms) {   // 00:00:22.820 — full TTML clock-time
  return pad(Math.floor(ms/3600000),2) + ":" + pad(Math.floor(ms/60000)%60,2) +
         ":" + pad(Math.floor(ms/1000)%60,2) + "." + pad(ms%1000,3);
}
function msm(ms) {    // 0:22.820
  return Math.floor(ms/60000) + ":" + pad(Math.floor(ms/1000)%60,2) + "." + pad(ms%1000,3);
}
function secs(ms) { return (ms/1000).toFixed(3) + "s"; }

// ---------------------------------------------------------- documents

function doc(o) {
  var t = o.time;
  var timing = o.timing || "Line";
  var songPart = o.songPart ? ' itunes:songPart="Verse"' : "";
  var body =
    '<div begin="' + t(22820) + '" end="' + t(34000) + '"' + songPart + '>' +
    '<p begin="' + t(22820) + '" end="' + t(28300) + '" itunes:key="L1" ttm:agent="v1">' +
      (o.words
        ? '<span begin="' + t(22820) + '" end="' + t(24500) + '">When </span>' +
          '<span begin="' + t(24500) + '" end="' + t(26500) + '">I met </span>' +
          '<span begin="' + t(26500) + '" end="' + t(28300) + '">you</span>'
        : "When I met you in that hotel room") +
    '</p>' +
    '<p begin="' + t(28300) + '" end="' + t(34000) + '" itunes:key="L2" ttm:agent="v1">' +
      "I could tell that you were so bad news</p>" +
    '</div>';

  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<tt xmlns="http://www.w3.org/ns/ttml"' +
    ' xmlns:ttm="http://www.w3.org/ns/ttml#metadata"' +
    ' xmlns:itunes="' + (o.ns || "http://music.apple.com/lyric-ttml-internal") + '"' +
    ' itunes:timing="' + timing + '" xml:lang="en">' +
    '<head><metadata><ttm:agent type="person" xml:id="v1"/></metadata></head>' +
    '<body dur="' + t(197333) + '">' + body + '</body></tt>';
}

var VARIANTS = [
  ["1  full clock HH:MM:SS.mmm",          { time: hmsm }],
  ["2  M:SS.mmm",                         { time: msm }],
  ["3  offset-time 22.820s",              { time: secs }],
  ["4  full clock + itunes:songPart",     { time: hmsm, songPart: true }],
  ["5  full clock, timing=Word + spans",  { time: hmsm, timing: "Word", words: true }],
  ["6  full clock, alt namespace",        { time: hmsm, ns: "http://music.apple.com/lyric-ttml" }]
];

// ---------------------------------------------------------- SAX probe

// Which elements the delegate actually receives. Empty means the XML
// itself was rejected; populated means the tree walked and any failure
// after that is semantic.
var sax = [];
(function () {
  var cls = ObjC.classes.MSVLyricsTTMLParser;
  var sel = "- parser:didStartElement:namespaceURI:qualifiedName:attributes:";
  if (!cls || !cls[sel]) { console.log("[absent] didStartElement"); return; }
  Interceptor.attach(cls[sel].implementation, {
    onEnter: function (args) {
      try { sax.push(new ObjC.Object(args[3]).toString()); } catch (e) {}
    }
  });
  console.log("[probe] parser:didStartElement:…");
})();

var saxErrors = [];
(function () {
  var cls = ObjC.classes.MSVLyricsTTMLParser;
  var sel = "- parser:parseErrorOccurred:";
  if (!cls || !cls[sel]) { console.log("[absent] parseErrorOccurred"); return; }
  Interceptor.attach(cls[sel].implementation, {
    onEnter: function (args) {
      try { saxErrors.push(new ObjC.Object(args[3]).toString()); } catch (e) {}
    }
  });
  console.log("[probe] parser:parseErrorOccurred:");
})();

// ---------------------------------------------------------- runner

function attempt(label, xml, seedInfo) {
  sax = []; saxErrors = [];

  var data = ObjC.classes.NSString
    .stringWithUTF8String_(Memory.allocUtf8String(xml))
    .dataUsingEncoding_(NSUTF8);

  // Fresh parser each time — initWithTTMLData: consumes the stream.
  var p = ObjC.classes.MSVLyricsTTMLParser.alloc().initWithTTMLData_(data);
  if (!p || p.handle.isNull()) { console.log("  " + label + " -> parser NIL"); return false; }

  if (seedInfo) {
    try { p.setLyricsInfo_(ObjC.classes.MSVLyricsSongInfo.alloc().init()); } catch (e) {}
  }

  // NSError** out-parameter.
  var errPtr = Memory.alloc(Process.pointerSize);
  errPtr.writePointer(NULL);

  var ok = false, threw = null;
  try { ok = p.parseWithError_(errPtr); } catch (e) { threw = e.message; }

  var out = "  " + label + " -> parseWithError: ";
  out += threw ? ("THREW " + threw) : (ok ? "YES" : "NO");

  var errObj = errPtr.readPointer();
  if (!errObj.isNull()) {
    try { out += " | NSError: " + new ObjC.Object(errObj).toString(); } catch (e) {}
  }

  var n = 0;
  try {
    var lines = p.lyricLines();
    n = (lines && !lines.handle.isNull()) ? lines.count() : 0;
  } catch (e) {}
  out += " | lines=" + n;

  out += " | sax=" + sax.length;
  if (sax.length) {
    var uniq = sax.filter(function (v, i, a) { return a.indexOf(v) === i; });
    out += " [" + uniq.slice(0, 10).join(",") + "]";
  }
  if (saxErrors.length) out += " | saxErr=" + saxErrors[0].slice(0, 120);

  console.log(out);

  if (n === 0) return false;

  // ---- winner: dump everything the renderer would read ----
  console.log("    *** ACCEPTED ***");
  try {
    var info = p.lyricsInfo();
    if (info && !info.handle.isNull()) {
      console.log("    info = " + info.toString());
      try { console.log("    info.type = " + info.type()); } catch (e) {}
      try { console.log("    info.songDuration = " + info.songDuration()); } catch (e) {}
      try { console.log("    info.leadingSilence = " + info.leadingSilence()); } catch (e) {}
      try { console.log("    info.lyricsLines = " + info.lyricsLines().count()); } catch (e) {}
      try { console.log("    info.lyricsSections = " + info.lyricsSections().count()); } catch (e) {}

      // The three queries the karaoke view makes every frame.
      try { console.log("    linesAtTimeOffset(25.0)  = " + info.lyricsLinesAtTimeOffset_errorMargin_(25.0, 0.5)); } catch (e) { console.log("    linesAt threw " + e.message); }
      try { console.log("    wordsAtTimeOffset(25.0)  = " + info.lyricsWordsAtTimeOffset_errorMargin_(25.0, 0.5)); } catch (e) { console.log("    wordsAt threw " + e.message); }
      try { console.log("    lineStartingBefore(30.0) = " + info.lyricsLineStartingBeforeTimeOffset_(30.0)); } catch (e) { console.log("    lineBefore threw " + e.message); }
    } else {
      console.log("    info = nil (lines exist but no songInfo — try seeded pass)");
    }
  } catch (e) { console.log("    info inspect threw " + e.message); }

  try {
    var l0 = p.lyricLines().objectAtIndex_(0);
    console.log("    line[0] = " + l0.toString());
    try { console.log("    line[0].primaryVocalText = " + l0.primaryVocalText()); } catch (e) {}
    try {
      var w = l0.words();
      console.log("    line[0].words = " + (w && !w.handle.isNull() ? w.count() : "nil"));
      if (w && !w.handle.isNull() && w.count() > 0) {
        console.log("    word[0] = " + w.objectAtIndex_(0).toString());
      }
    } catch (e) {}
  } catch (e) { console.log("    line inspect threw " + e.message); }

  return true;
}

function go() {
  ObjC.schedule(ObjC.mainQueue, function () {
    var pool = ObjC.classes.NSAutoreleasePool.alloc().init();
    try {
      console.log("\n########## PASS 1 — parser creates its own songInfo ##########");
      var wins = [];
      VARIANTS.forEach(function (v) {
        try { if (attempt(v[0], doc(v[1]), false)) wins.push(v[0]); }
        catch (e) { console.log("  " + v[0] + " -> EXCEPTION " + e.message); }
      });

      console.log("\n########## PASS 2 — seed MSVLyricsSongInfo first ##########");
      VARIANTS.forEach(function (v) {
        try { attempt(v[0] + " [seeded]", doc(v[1]), true); }
        catch (e) { console.log("  " + v[0] + " [seeded] -> EXCEPTION " + e.message); }
      });

      console.log("\n########## RESULT ##########");
      console.log(wins.length ? "Accepted: " + wins.join(" | ")
                              : "None accepted — read the NSError and saxErr columns.");
    } catch (e) {
      console.log("EXCEPTION: " + e.message);
    } finally {
      pool.release();
    }
  });
}

console.log("\nReady. Type:  go()");
