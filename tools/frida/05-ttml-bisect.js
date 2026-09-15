// 05-ttml-bisect.js
//
// The parser accepted the document object but produced zero lines and a
// nil lyricsInfo, so the failure is semantic, not a crash and not a
// rejection of the file as XML. This finds the correct shape by trying a
// matrix of candidate documents and reporting how many lines each yields.
//
// Prime suspect: TTML clock-time is `hours:minutes:seconds`, and 04 used
// `0:22.820` — only two components. A strict parser drops every timed
// element and you get exactly what we saw.
//
// It also watches the parser's own internals, which distinguishes two
// very different failures:
//   * setElementName: fires with tt/body/div/p  -> XML parsed fine, the
//     time attributes are what it choked on
//   * setElementName: never fires               -> it never got as far as
//     walking the tree, so the problem is the document envelope
//
// Run (open Music on the phone first):
//   frida -U -n Music -l tools\frida\05-ttml-bisect.js
// Then, at the prompt:  bisect()

var NSUTF8 = 4;

// ---------------------------------------------------------------- probes

// Did the XML walker see elements at all?
var seenElements = [];
(function () {
  var cls = ObjC.classes.MSVLyricsXMLElement;
  if (!cls || !cls["- setElementName:"]) { console.log("[absent] MSVLyricsXMLElement setElementName:"); return; }
  Interceptor.attach(cls["- setElementName:"].implementation, {
    onEnter: function (args) {
      try { seenElements.push(new ObjC.Object(args[2]).toString()); } catch (e) {}
    }
  });
  console.log("[probe] MSVLyricsXMLElement setElementName:");
})();

// Did it ever build a line or a section?
var built = { lines: 0, words: 0, sections: 0 };
[["MSVLyricsLine", "- setWords:", "words"],
 ["MSVLyricsSection", "- setLines:", "lines"]].forEach(function (p) {
  var cls = ObjC.classes[p[0]];
  if (!cls || !cls[p[1]]) { console.log("[absent] " + p[0] + " " + p[1]); return; }
  Interceptor.attach(cls[p[1]].implementation, {
    onEnter: function () { built[p[2]] += 1; }
  });
  console.log("[probe] " + p[0] + " " + p[1]);
});

// ---------------------------------------------------------------- corpus

// One line of text, two lines of lyric, expressed every plausible way.
// `t` is a time formatter so each variant differs only in the thing being
// tested.
function doc(opts) {
  var t = opts.time;
  var itunesNS = opts.noItunes ? "" :
    ' xmlns:itunes="' + (opts.ns || "http://music.apple.com/lyric-ttml-internal") + '"';
  var timing = opts.noItunes || opts.noTiming ? "" :
    ' itunes:timing="' + (opts.timing || "Line") + '"';
  var head = opts.noHead ? "" :
    "<head><metadata>" +
    (opts.noAgent ? "" : '<ttm:agent type="person" xml:id="v1"/>') +
    "</metadata></head>";
  var agentAttr = (opts.noAgent || opts.noItunes) ? "" : ' ttm:agent="v1"';
  var keyAttr = opts.noKey || opts.noItunes ? "" : ' itunes:key="L1"';
  var bodyDur = opts.noDur ? "" : ' dur="' + t(197333) + '"';
  var divTimes = opts.noDivTimes ? "" :
    ' begin="' + t(22820) + '" end="' + t(34000) + '"';

  var p1 = '<p begin="' + t(22820) + '" end="' + t(28300) + '"' + keyAttr + agentAttr + '>' +
           (opts.words
             ? '<span begin="' + t(22820) + '" end="' + t(24000) + '">When </span>' +
               '<span begin="' + t(24000) + '" end="' + t(26000) + '">I met </span>' +
               '<span begin="' + t(26000) + '" end="' + t(28300) + '">you</span>'
             : "When I met you in that hotel room") +
           '</p>';
  var p2 = '<p begin="' + t(28300) + '" end="' + t(34000) + '"' +
           (opts.noKey || opts.noItunes ? "" : ' itunes:key="L2"') + agentAttr + '>' +
           "I could tell that you were so bad news</p>";

  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<tt xmlns="http://www.w3.org/ns/ttml"' +
    ' xmlns:ttm="http://www.w3.org/ns/ttml#metadata"' +
    itunesNS + timing + ' xml:lang="en">' +
    head +
    "<body" + bodyDur + ">" +
    "<div" + divTimes + ">" + p1 + p2 + "</div>" +
    "</body></tt>";
}

// Time formatters under test.
function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }
function hmsm(ms) {           // 00:00:22.820  — full TTML clock-time
  var h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60,
      s = Math.floor(ms / 1000) % 60, f = ms % 1000;
  return pad(h,2) + ":" + pad(m,2) + ":" + pad(s,2) + "." + pad(f,3);
}
function msm(ms) {            // 0:22.820 — what 04 used, expected to fail
  var m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, f = ms % 1000;
  return m + ":" + pad(s,2) + "." + pad(f,3);
}
function msmPadded(ms) {      // 00:22.820
  var m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, f = ms % 1000;
  return pad(m,2) + ":" + pad(s,2) + "." + pad(f,3);
}
function secs(ms) {           // 22.820s — TTML offset-time
  return (ms / 1000).toFixed(3) + "s";
}
function bare(ms) {           // 22.820
  return (ms / 1000).toFixed(3);
}
function ms_(ms) {            // 22820ms — TTML offset-time in ms
  return ms + "ms";
}

var VARIANTS = [
  ["A  M:SS.mmm (what 04 used)",        { time: msm }],
  ["B  HH:MM:SS.mmm full clock",        { time: hmsm }],
  ["C  MM:SS.mmm padded",               { time: msmPadded }],
  ["D  offset-time 22.820s",            { time: secs }],
  ["E  bare seconds 22.820",            { time: bare }],
  ["F  offset-time 22820ms",            { time: ms_ }],
  ["G  full clock, no itunes ns",       { time: hmsm, noItunes: true }],
  ["H  full clock, no itunes:timing",   { time: hmsm, noTiming: true }],
  ["I  full clock, no ttm:agent",       { time: hmsm, noAgent: true }],
  ["J  full clock, no div times",       { time: hmsm, noDivTimes: true }],
  ["K  full clock, no head/dur/key",    { time: hmsm, noHead: true, noDur: true, noKey: true }],
  ["L  full clock, timing=Word + spans",{ time: hmsm, timing: "Word", words: true }]
];

// ---------------------------------------------------------------- runner

function tryOne(label, xml) {
  seenElements = [];
  built.lines = 0; built.words = 0; built.sections = 0;

  var NSString = ObjC.classes.NSString;
  var s = NSString.stringWithUTF8String_(Memory.allocUtf8String(xml));
  var data = s.dataUsingEncoding_(NSUTF8);

  var parser = ObjC.classes.MSVLyricsTTMLParser.alloc().initWithTTMLData_(data);
  var out = "  " + label + "  -> ";
  if (!parser || parser.handle.isNull()) { console.log(out + "parser NIL"); return 0; }

  var n = 0, info = null;
  try {
    var lines = parser.lyricLines();
    n = (lines && !lines.handle.isNull()) ? lines.count() : 0;
  } catch (e) {}
  try {
    info = parser.lyricsInfo();
    if (info && info.handle.isNull()) info = null;
  } catch (e) { info = null; }

  out += "lines=" + n + " info=" + (info ? "OK" : "nil");
  out += " | elems=" + seenElements.length;
  if (seenElements.length > 0) {
    var uniq = seenElements.filter(function (v, i, a) { return a.indexOf(v) === i; });
    out += " [" + uniq.slice(0, 8).join(",") + "]";
  }
  out += " | setLines=" + built.lines + " setWords=" + built.words;
  console.log(out);

  // Only dig in on a winner.
  if (n > 0 && info) {
    console.log("    *** WINNER ***");
    try {
      var l0 = parser.lyricLines().objectAtIndex_(0);
      console.log("    line[0] = " + l0.toString());
      console.log("    line[0].primaryVocalText = " + l0.primaryVocalText());
      var w = l0.words();
      console.log("    line[0].words = " + (w && !w.handle.isNull() ? w.count() : "nil"));
    } catch (e) { console.log("    line inspect threw: " + e.message); }
    try {
      console.log("    linesAtTimeOffset(25.0) = " + info.lyricsLinesAtTimeOffset_errorMargin_(25.0, 0.5));
      console.log("    wordsAtTimeOffset(25.0) = " + info.lyricsWordsAtTimeOffset_errorMargin_(25.0, 0.5));
      console.log("    lineStartingBefore(30.0) = " + info.lyricsLineStartingBeforeTimeOffset_(30.0));
    } catch (e) { console.log("    query threw: " + e.message); }
  }
  return n;
}

function bisect() {
  ObjC.schedule(ObjC.mainQueue, function () {
    var pool = ObjC.classes.NSAutoreleasePool.alloc().init();
    try {
      console.log("\n########## TTML BISECT ##########");
      var wins = [];
      VARIANTS.forEach(function (v) {
        try {
          if (tryOne(v[0], doc(v[1])) > 0) wins.push(v[0]);
        } catch (e) {
          console.log("  " + v[0] + "  -> EXCEPTION " + e.message);
        }
      });
      console.log("\n########## RESULT ##########");
      console.log(wins.length ? "Accepted: " + wins.join(" | ")
                              : "Nothing accepted. Paste the elems= column — that says whether the XML was walked at all.");
    } catch (e) {
      console.log("BISECT EXCEPTION: " + e.message);
    } finally {
      pool.release();
    }
  });
}

console.log("\nReady. Type:  bisect()");
