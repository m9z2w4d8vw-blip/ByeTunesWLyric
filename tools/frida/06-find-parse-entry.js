// 06-find-parse-entry.js
//
// 05 showed elems=0 on all twelve variants, including ones with no
// itunes namespace and no time attributes. The document shape is
// therefore NOT the problem: `initWithTTMLData:` simply does not parse.
// It stores the bytes and returns. Something else drives the parse.
//
// Four lines of enquiry, in order of how likely they are to answer it:
//
//   1. The FULL method list (inherited too, not just $ownMethods) and the
//      superclass chain. A `parse` or `parseWithError:` on a superclass
//      would end this immediately, and $ownMethods would never show it.
//   2. MediaServices exported symbols matching lyric/ttml — if the parse
//      is a C function the ObjC surface won't mention it.
//   3. A live call trace: hook every method on every MSVLyrics* class
//      plus NSXMLParser, then invoke initWithTTMLData: and print the
//      exact internal sequence. That shows what it does instead of
//      parsing, and whether an NSXMLParser is even constructed.
//   4. The seeded-destination experiment: create an MSVLyricsSongInfo,
//      hand it over with setLyricsInfo:, and see whether anything then
//      populates it.
//
// Run (Music open on the phone):
//   frida -U -n Music -l tools\frida\06-find-parse-entry.js
// Then:  inspect()   then   go()

// ============================================ 1. full surface

function inspect() {
  var cls = ObjC.classes.MSVLyricsTTMLParser;
  if (!cls) { console.log("MSVLyricsTTMLParser absent"); return; }

  console.log("\n########## SUPERCLASS CHAIN ##########");
  var c = cls;
  while (c) {
    console.log("  " + c.$className);
    c = c.$superClass;
  }

  console.log("\n########## ALL METHODS (incl. inherited) matching parse/xml/ttml/delegate/lyric ##########");
  cls.$methods.filter(function (m) {
    return /parse|xml|ttml|delegate|lyric|load|read|process|element/i.test(m);
  }).sort().forEach(function (m) { console.log("  " + m); });

  console.log("\n########## MSVLyricsSongInfo — all methods ##########");
  var si = ObjC.classes.MSVLyricsSongInfo;
  if (si) si.$ownMethods.sort().forEach(function (m) { console.log("  " + m); });

  // 2. exported symbols — catches a C entry point the ObjC surface hides.
  console.log("\n########## MediaServices exports matching lyric/ttml ##########");
  try {
    var hits = Module.enumerateExports("MediaServices").filter(function (e) {
      return /lyric|ttml/i.test(e.name);
    });
    if (hits.length === 0) console.log("  (none)");
    hits.slice(0, 60).forEach(function (e) {
      console.log("  " + e.type + "  " + e.name);
    });
  } catch (e) { console.log("  enumerateExports threw: " + e.message); }

  console.log("\n########## classes matching /MSV/ ##########");
  Object.keys(ObjC.classes).filter(function (n) { return /^MSV/.test(n); })
    .sort().forEach(function (n) { console.log("  " + n); });
}

// ============================================ 3. live call trace

var log = [];
var hooked = 0;

function hookAll() {
  // Every method on every MSVLyrics* class.
  Object.keys(ObjC.classes).filter(function (n) { return /^MSVLyrics/.test(n); })
    .forEach(function (name) {
      var cls = ObjC.classes[name];
      cls.$ownMethods.forEach(function (sel) {
        if (sel.indexOf(".cxx") !== -1) return;
        try {
          Interceptor.attach(cls[sel].implementation, {
            onEnter: function () { log.push(name + " " + sel); }
          });
          hooked++;
        } catch (e) {}
      });
    });

  // Is an NSXMLParser ever built, and does it report an error?
  [["NSXMLParser", "- initWithData:"],
   ["NSXMLParser", "- initWithStream:"],
   ["NSXMLParser", "- parse"],
   ["NSXMLParser", "- setDelegate:"],
   ["NSXMLParser", "- parserError"]].forEach(function (p) {
    var cls = ObjC.classes[p[0]];
    if (!cls || !cls[p[1]]) return;
    try {
      Interceptor.attach(cls[p[1]].implementation, {
        onEnter: function () { log.push(">>> " + p[0] + " " + p[1]); },
        onLeave: function (r) {
          if (p[1] === "- parse") log.push(">>> parse returned " + r.toInt32());
        }
      });
      hooked++;
    } catch (e) {}
  });

  console.log("hooked " + hooked + " methods");
}

// ============================================ 4. the actual experiment

function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }
function hmsm(ms) {
  var h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60,
      s = Math.floor(ms / 1000) % 60, f = ms % 1000;
  return pad(h,2) + ":" + pad(m,2) + ":" + pad(s,2) + "." + pad(f,3);
}

var TTML =
'<?xml version="1.0" encoding="UTF-8"?>' +
'<tt xmlns="http://www.w3.org/ns/ttml" ' +
'xmlns:ttm="http://www.w3.org/ns/ttml#metadata" ' +
'xmlns:itunes="http://music.apple.com/lyric-ttml-internal" ' +
'itunes:timing="Line" xml:lang="en">' +
'<head><metadata><ttm:agent type="person" xml:id="v1"/></metadata></head>' +
'<body dur="' + hmsm(197333) + '">' +
'<div begin="' + hmsm(22820) + '" end="' + hmsm(34000) + '">' +
'<p begin="' + hmsm(22820) + '" end="' + hmsm(28300) + '" itunes:key="L1" ttm:agent="v1">When I met you in that hotel room</p>' +
'<p begin="' + hmsm(28300) + '" end="' + hmsm(34000) + '" itunes:key="L2" ttm:agent="v1">I could tell that you were so bad news</p>' +
'</div></body></tt>';

function go() {
  ObjC.schedule(ObjC.mainQueue, function () {
    var pool = ObjC.classes.NSAutoreleasePool.alloc().init();
    try {
      var NSString = ObjC.classes.NSString;
      var data = NSString.stringWithUTF8String_(Memory.allocUtf8String(TTML))
                         .dataUsingEncoding_(4);

      console.log("\n########## CALL TRACE: initWithTTMLData: ##########");
      log = [];
      var parser = ObjC.classes.MSVLyricsTTMLParser.alloc().initWithTTMLData_(data);
      log.forEach(function (l) { console.log("  " + l); });
      if (log.length === 0) console.log("  (nothing — it really does only store)");

      console.log("\n  ttmlData length after init = " +
        (function () {
          try { var d = parser.ttmlData();
                return (d && !d.handle.isNull()) ? d.length() : "nil"; }
          catch (e) { return "threw " + e.message; }
        })());

      // --- seed a destination and see if anything fills it ---
      console.log("\n########## SEEDED DESTINATION ##########");
      var info = ObjC.classes.MSVLyricsSongInfo.alloc().init();
      console.log("  fresh MSVLyricsSongInfo = " + info.$className);
      log = [];
      try { parser.setLyricsInfo_(info); } catch (e) { console.log("  setLyricsInfo: threw " + e.message); }
      log.forEach(function (l) { console.log("  " + l); });

      try {
        var li = info.lyricsLines();
        console.log("  seeded info.lyricsLines = " + (li && !li.handle.isNull() ? li.count() : "nil"));
      } catch (e) { console.log("  lyricsLines threw " + e.message); }

      // --- try every plausible parse trigger we can name ---
      console.log("\n########## PARSE TRIGGER PROBES ##########");
      ["parse", "parseTTML", "parseLyrics", "load", "reload",
       "lyricsInfo", "lyricLines"].forEach(function (sel) {
        var key = "- " + sel;
        if (!parser[key]) { console.log("  " + sel + ": no such selector"); return; }
        log = [];
        try {
          var r = parser[key]();
          var desc = (r === null) ? "nil"
                   : (typeof r === "object" && r.handle)
                      ? (r.handle.isNull() ? "nil" : r.$className + " " + r.toString().slice(0, 80))
                      : String(r);
          console.log("  " + sel + "() -> " + desc + "   (inner calls: " + log.length + ")");
          log.slice(0, 12).forEach(function (l) { console.log("      " + l); });
        } catch (e) { console.log("  " + sel + "() threw " + e.message); }
      });

      console.log("\n########## DONE ##########");
    } catch (e) {
      console.log("EXCEPTION: " + e.message);
    } finally {
      pool.release();
    }
  });
}

hookAll();
console.log("\nReady.  inspect()   then   go()");
