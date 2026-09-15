// 11-hijack-v2.js
//
// 10 revealed two things and exposed two mistakes of mine.
//
// GOOD: SyncedLyricsViewController is ALREADY the view controller in use
// for local tracks, and its `lyrics` setter fires. Apple's synced
// renderer is on screen; it is simply being handed a Lyrics object with
// no timing, so it lays the text out statically.
//
// MISTAKE 1: I hooked only the allocating initialiser (…CtcfC). Swift
// frequently calls the non-allocating form (…Ctcfc) for a type in the
// same binary. Both are hooked now.
//
// MISTAKE 2: LyricsLoader caches. It has a `lyricsOperations` dictionary
// and a `hasRequest(for:)` predicate, so a track whose lyrics were
// already loaded this session never gets reconstructed — the setter
// fires with a pre-existing object. hasRequest(for:) is forced to false
// here so every open triggers a fresh load.
//
// (Lyrics.type being silent has a third explanation: for a stored
// property inside one binary, Swift reads the field directly rather than
// calling the getter thunk, so hooking the thunk catches nothing. Not a
// problem — we no longer need to read it.)
//
// Run (Music open):
//   frida -U -n Music -l tools\frida\11-hijack-v2.js
// Then:  observe()
//        → play a track whose lyrics you have NOT opened yet this
//          session, and open the lyrics view
// Then:  hijack()   → close lyrics, reopen, or skip track

var MOD = null;
["MusicApplication", "Music"].forEach(function (n) {
  if (MOD) return; try { MOD = Process.getModuleByName(n); } catch (e) {}
});
console.log(MOD ? "module @ " + MOD.base : "module not found");

var EXPORTS = null;
function addr(name) {
  if (!MOD) return null;
  if (!EXPORTS) { try { EXPORTS = MOD.enumerateExports(); } catch (e) { return null; } }
  var h = EXPORTS.filter(function (s) { return s.name === name; });
  return h.length ? h[0].address : null;
}

var SYM = {
  initAlloc: "$s11MusicCoreUI6LyricsC10identifier8songInfoACSSSg_So013MSVLyricsSongG0CtcfC",
  initPlain: "$s11MusicCoreUI6LyricsC10identifier8songInfoACSSSg_So013MSVLyricsSongG0Ctcfc",
  vcSet:     "$s11MusicCoreUI26SyncedLyricsViewControllerC6lyricsAA0E0CSgvs",
  vcGet:     "$s11MusicCoreUI26SyncedLyricsViewControllerC6lyricsAA0E0CSgvg",
  hasReq:    "$s11MusicCoreUI12LyricsLoaderC10hasRequest3forSbSo11MPModelSongC_tF",
  loadCb:    "$s11MusicCoreUI12LyricsLoaderC04loadD03for10completionySo11MPModelSongC_yAC6ResultOSg_s5Error_pSgtctF",
  mgrInit:   "$s11MusicCoreUI19SyncedLyricsManagerC6lyrics13configuration8delegateAcA0E0C_AC13ConfigurationVAA0deF8Delegate_ptcfC",
  mgrElapsed:"$s11MusicCoreUI19SyncedLyricsManagerC19elapsedTimeProviderSdycSgvs"
};

// ---------------------------------------------------------- payload

function pad(n,w){var s=String(n);while(s.length<w)s="0"+s;return s;}
function clk(ms){
  return pad(Math.floor(ms/3600000),2)+":"+pad(Math.floor(ms/60000)%60,2)+
         ":"+pad(Math.floor(ms/1000)%60,2)+"."+pad(ms%1000,3);
}

function buildTTML() {
  var parts = [];
  for (var i = 0; i < 25; i++) {
    var s0 = 2000 + i*3000, w2 = s0+900, w3 = s0+1800, e0 = s0+2700;
    parts.push('<p begin="'+clk(s0)+'" end="'+clk(e0)+'" itunes:key="L'+(i+1)+'" ttm:agent="v1">'+
      '<span begin="'+clk(s0)+'" end="'+clk(w2)+'">HIJACK </span>'+
      '<span begin="'+clk(w2)+'" end="'+clk(w3)+'">line </span>'+
      '<span begin="'+clk(w3)+'" end="'+clk(e0)+'">'+(i+1)+'</span></p>');
  }
  return '<?xml version="1.0" encoding="UTF-8"?>'+
    '<tt xmlns="http://www.w3.org/ns/ttml"'+
    ' xmlns:ttm="http://www.w3.org/ns/ttml#metadata"'+
    ' xmlns:itunes="http://music.apple.com/lyric-ttml-internal"'+
    ' itunes:timing="Word" xml:lang="en">'+
    '<head><metadata><ttm:agent type="person" xml:id="v1"/></metadata></head>'+
    '<body dur="'+clk(300000)+'">'+
    '<div begin="'+clk(2000)+'" end="'+clk(80000)+'">'+parts.join("")+'</div>'+
    '</body></tt>';
}

var OUR_INFO = null;
function ourSongInfo() {
  if (OUR_INFO) return OUR_INFO;
  var d = ObjC.classes.NSString
    .stringWithUTF8String_(Memory.allocUtf8String(buildTTML()))
    .dataUsingEncoding_(4);
  var p = ObjC.classes.MSVLyricsTTMLParser.alloc().initWithTTMLData_(d);
  var e = Memory.alloc(Process.pointerSize); e.writePointer(NULL);
  var ok = p.parseWithError_(e);
  var info = p.lyricsInfo();
  if (!ok || !info || info.handle.isNull()) { console.log("!! songInfo build failed"); return null; }
  info.retain();                    // Music outlives our hook
  OUR_INFO = info;
  console.log("payload: " + info.toString().split("\n")[0]);
  return OUR_INFO;
}

// ---------------------------------------------------------- helpers

// Swift native classes appear in ObjC.classes but are not NSObject
// subclasses, so `description` can fault. Only the class name is read.
function swiftClassName(p) {
  if (p.isNull()) return "nil";
  try { return new ObjC.Object(p).$className; }
  catch (e) { return "raw " + p; }
}
function objcDesc(p) {
  if (p.isNull()) return "nil";
  try { var o = new ObjC.Object(p); return o.$className + " :: " + o.toString().split("\n")[0].slice(0,140); }
  catch (e) { return "raw " + p; }
}

var hijacking = false;
var installed = false;

function install() {
  if (installed) return; installed = true;

  // Both initialiser forms. songInfo is the third argument: Optional<String>
  // takes x0+x1, so it lands in x2. (Allocating init keeps the metatype
  // in x20, non-allocating keeps self there — either way args start x0.)
  [["init ALLOC", SYM.initAlloc], ["init PLAIN", SYM.initPlain]].forEach(function (p) {
    var a = addr(p[1]);
    if (!a) { console.log("[miss] Lyrics." + p[0]); return; }
    Interceptor.attach(a, {
      onEnter: function () {
        console.log("\n*** Lyrics." + p[0] + "(identifier:songInfo:)");
        console.log("    songInfo = " + objcDesc(this.context.x2));
        if (hijacking) {
          var info = ourSongInfo();
          if (info) {
            this.context.x2 = info.handle;
            console.log("    >>> REPLACED with " + objcDesc(this.context.x2));
          }
        }
      }
    });
    console.log("[hooked] Lyrics." + p[0] + " @ " + a);
  });

  // What object reaches the renderer. self is in x20, new value in x0.
  var a = addr(SYM.vcSet);
  if (a) {
    Interceptor.attach(a, {
      onEnter: function () {
        console.log("\n*** SyncedLyricsViewController.lyrics = " + swiftClassName(this.context.x0));
      }
    });
    console.log("[hooked] VC.lyrics setter @ " + a);
  }

  a = addr(SYM.mgrInit);
  if (a) {
    Interceptor.attach(a, { onEnter: function () {
      console.log("\n*** SyncedLyricsManager.init  — timed path engaged");
    }});
    console.log("[hooked] SyncedLyricsManager.init");
  }

  a = addr(SYM.mgrElapsed);
  if (a) {
    Interceptor.attach(a, { onEnter: function () {
      console.log("*** elapsedTimeProvider set — clock wired up");
    }});
    console.log("[hooked] elapsedTimeProvider setter");
  }

  a = addr(SYM.loadCb);
  if (a) {
    Interceptor.attach(a, { onEnter: function () { console.log("\n*** loadLyrics(for:completion:)"); } });
    console.log("[hooked] loadLyrics");
  }
}

function observe() {
  install();
  // Defeat the cache so every open rebuilds the Lyrics object. This is
  // why 10 saw the setter fire without the initialiser.
  var a = addr(SYM.hasReq);
  if (a) {
    Interceptor.attach(a, {
      onLeave: function (r) { if (r.toInt32() & 1) { r.replace(ptr(0)); console.log("[cache] hasRequest 1 -> 0"); } }
    });
    console.log("[hooked] hasRequest(for:) forced false — no cached reuse");
  } else console.log("[miss] hasRequest");

  console.log("\nNow: play a track you have NOT opened lyrics for yet, and open the lyrics view.");
}

function hijack() {
  install();
  if (!ourSongInfo()) return;
  hijacking = true;
  console.log("[ARMED] Lyrics.init songInfo will be replaced.");
  console.log("Close the lyrics view and reopen it, or skip to the next track.");
}

function disarm() { hijacking = false; console.log("[disarmed]"); }

console.log("\nReady.  observe()   then   hijack()   (disarm() to stop)");
