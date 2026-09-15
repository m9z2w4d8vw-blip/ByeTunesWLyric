// 10-hijack-lyrics.js
//
// THE DECISIVE TEST.
//
// 09 established:
//   * LyricsLoader.supportsLyrics(for:) already returns true — the gate
//     was never blocking.
//   * loadLyrics(for:completion:) IS called for a local track, from
//     NowPlayingViewController.viewDidLoad and again on the button tap.
//   * SyncedLyricsManager.init never fires, so the Result carries static
//     text and Music picks StaticLyricsViewController.
//   * MusicCoreUI.Lyrics.init(identifier: String?, songInfo:
//     MSVLyricsSongInfo) exists — Lyrics is built straight from the
//     object type we already know how to synthesise.
//
// So: if Music constructs a Lyrics from a "Not Timed" songInfo for your
// track, replacing that one argument with a word-timed songInfo should
// flip Lyrics.type and route the whole thing to the synced renderer.
//
//   observe()   log what is actually passed and which VC appears.
//               Read-only. Run this first.
//   hijack()    swap the songInfo argument for one parsed from our own
//               TTML. This MUTATES Music's behaviour in memory — nothing
//               on disk, and it ends when you detach or kill the app.
//
// Swift calling convention note: for an allocating initialiser the
// metatype travels in x20 and the arguments start at x0. Optional<String>
// occupies two registers (x0, x1), so `songInfo` lands in x2.
//
// Run (Music open):
//   frida -U -n Music -l tools\frida\10-hijack-lyrics.js
// Then:  observe()   → play a track, open lyrics, note the output
// Then:  hijack()    → close and reopen the lyrics view

var MOD = null;
["MusicApplication", "Music"].forEach(function (n) {
  if (MOD) return;
  try { MOD = Process.getModuleByName(n); } catch (e) {}
});
if (!MOD) console.log("could not locate the Music module");
else console.log("module @ " + MOD.base);

var EXPORTS = null;
function addr(name) {
  if (!MOD) return null;
  if (!EXPORTS) { try { EXPORTS = MOD.enumerateExports(); } catch (e) { return null; } }
  var hit = EXPORTS.filter(function (s) { return s.name === name; });
  return hit.length ? hit[0].address : null;
}

var SYM = {
  lyricsInit:   "$s11MusicCoreUI6LyricsC10identifier8songInfoACSSSg_So013MSVLyricsSongG0CtcfC",
  lyricsType:   "$s11MusicCoreUI6LyricsC4typeAC0D4TypeOvg",
  lyricsLines:  "$s11MusicCoreUI6LyricsC5linesSayAA0D4Line_pGvg",
  staticTextSet:"$s11MusicCoreUI6LyricsC10staticTextSSvs",
  vcLyricsSet:  "$s11MusicCoreUI26SyncedLyricsViewControllerC6lyricsAA0E0CSgvs",
  mgrInit:      "$s11MusicCoreUI19SyncedLyricsManagerC6lyrics13configuration8delegateAcA0E0C_AC13ConfigurationVAA0deF8Delegate_ptcfC"
};

// ============================================ our payload

function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }
function clk(ms) {
  return pad(Math.floor(ms/3600000),2) + ":" + pad(Math.floor(ms/60000)%60,2) +
         ":" + pad(Math.floor(ms/1000)%60,2) + "." + pad(ms%1000,3);
}

// 20 word-timed lines, one every 3s starting at 2s. Deliberately
// numbered so there is no ambiguity about whose lyrics are on screen,
// and so the sweep timing can be checked against the progress bar.
function buildTTML() {
  var parts = [];
  for (var i = 0; i < 20; i++) {
    var start = 2000 + i * 3000;
    var w1 = start, w2 = start + 900, w3 = start + 1800, end = start + 2700;
    parts.push(
      '<p begin="' + clk(start) + '" end="' + clk(end) + '" itunes:key="L' + (i+1) + '" ttm:agent="v1">' +
      '<span begin="' + clk(w1) + '" end="' + clk(w2) + '">HIJACK </span>' +
      '<span begin="' + clk(w2) + '" end="' + clk(w3) + '">line </span>' +
      '<span begin="' + clk(w3) + '" end="' + clk(end) + '">' + (i+1) + '</span>' +
      '</p>');
  }
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<tt xmlns="http://www.w3.org/ns/ttml"' +
    ' xmlns:ttm="http://www.w3.org/ns/ttml#metadata"' +
    ' xmlns:itunes="http://music.apple.com/lyric-ttml-internal"' +
    ' itunes:timing="Word" xml:lang="en">' +
    '<head><metadata><ttm:agent type="person" xml:id="v1"/></metadata></head>' +
    '<body dur="' + clk(200000) + '">' +
    '<div begin="' + clk(2000) + '" end="' + clk(62000) + '">' + parts.join("") + '</div>' +
    '</body></tt>';
}

// Built once and retained, because Music will hold onto it long after
// our hook returns and a collected object would crash the renderer.
var OUR_INFO = null;
function ourSongInfo() {
  if (OUR_INFO) return OUR_INFO;
  var data = ObjC.classes.NSString
    .stringWithUTF8String_(Memory.allocUtf8String(buildTTML()))
    .dataUsingEncoding_(4);
  var p = ObjC.classes.MSVLyricsTTMLParser.alloc().initWithTTMLData_(data);
  var errPtr = Memory.alloc(Process.pointerSize); errPtr.writePointer(NULL);
  var ok = p.parseWithError_(errPtr);
  var info = p.lyricsInfo();
  if (!ok || !info || info.handle.isNull()) {
    console.log("!! could not build our songInfo (ok=" + ok + ")");
    return null;
  }
  info.retain();
  OUR_INFO = info;
  console.log("our songInfo ready: " + info.toString().split("\n")[0]);
  return OUR_INFO;
}

// ============================================ observe

function describe(p) {
  if (p.isNull()) return "nil";
  try {
    var o = new ObjC.Object(p);
    return o.$className + " :: " + o.toString().split("\n")[0].slice(0, 140);
  } catch (e) { return "raw " + p + " (" + e.message + ")"; }
}

function observe() {
  var a = addr(SYM.lyricsInit);
  if (a) {
    Interceptor.attach(a, {
      onEnter: function () {
        console.log("\n*** Lyrics.init(identifier:songInfo:)");
        console.log("    x2 (songInfo) = " + describe(this.context.x2));
      }
    });
    console.log("[observing] Lyrics.init  @ " + a);
  } else console.log("[miss] Lyrics.init");

  a = addr(SYM.lyricsType);
  if (a) {
    Interceptor.attach(a, {
      onLeave: function (r) {
        console.log("    Lyrics.type -> " + r.toInt32() +
          "   (0/1/2 ~ static/line/word)");
      }
    });
    console.log("[observing] Lyrics.type");
  }

  a = addr(SYM.staticTextSet);
  if (a) {
    Interceptor.attach(a, { onEnter: function () { console.log("    Lyrics.staticText was SET"); } });
    console.log("[observing] Lyrics.staticText setter");
  }

  a = addr(SYM.vcLyricsSet);
  if (a) {
    Interceptor.attach(a, { onEnter: function () { console.log("\n*** SyncedLyricsViewController.lyrics = …"); } });
    console.log("[observing] SyncedLyricsViewController.lyrics setter");
  }

  a = addr(SYM.mgrInit);
  if (a) {
    Interceptor.attach(a, { onEnter: function () { console.log("\n*** SyncedLyricsManager.init — SYNCED PATH REACHED"); } });
    console.log("[observing] SyncedLyricsManager.init");
  }

  // Which view controller actually loads. This is the visible outcome.
  [["MusicApplication.StaticLyricsViewController", "STATIC"],
   ["MusicCoreUI.SyncedLyricsViewController", "SYNCED"]].forEach(function (p) {
    var cls = ObjC.classes[p[0]];
    if (!cls || !cls["- viewDidLoad"]) { console.log("[miss] " + p[0]); return; }
    Interceptor.attach(cls["- viewDidLoad"].implementation, {
      onEnter: function () { console.log("\n>>> VIEW CONTROLLER LOADED: " + p[1]); }
    });
    console.log("[observing] " + p[1] + " viewDidLoad");
  });

  console.log("\nNow: play a track and open the lyrics view.");
}

// ============================================ hijack

var hijacking = false;

function hijack() {
  if (!ourSongInfo()) return;
  var a = addr(SYM.lyricsInit);
  if (!a) { console.log("[miss] Lyrics.init — cannot hijack"); return; }

  Interceptor.attach(a, {
    onEnter: function () {
      if (!hijacking) return;
      var info = ourSongInfo();
      if (!info) return;
      console.log("\n*** HIJACK: replacing songInfo");
      console.log("    was = " + describe(this.context.x2));
      this.context.x2 = info.handle;
      console.log("    now = " + describe(this.context.x2));
    }
  });

  hijacking = true;
  console.log("[hijack ARMED] Lyrics.init songInfo will be replaced.");
  console.log("Close the lyrics view and reopen it, or skip to the next track.");
  console.log("Type  disarm()  to stop.");
}

function disarm() { hijacking = false; console.log("[hijack disarmed]"); }

console.log("\nReady.  observe()   then   hijack()   (disarm() to stop)");
