// 12-feed-ttml.js   — the last Frida script.
//
// WHY THIS INSTEAD OF AN ASM STUB
//
// 11 showed SyncedLyricsViewController.lyrics being set to nil:
// LyricsLoader has nothing to build a Lyrics from, which is why
// Lyrics.init(identifier:songInfo:) never fired in 10 or 11.
//
// What the loader reads is already in our notes from 01 and 08:
//     MPModelSong   __lyrics_KEY               -> MPModelLyrics
//     MPModelLyrics __TTML_KEY                 -> the TTML payload
//     MediaPlayer   MPModelPropertyLyricsTTML  -> the key constant
//
// MPModelLyrics is an ordinary ObjC class with dictionary-backed
// properties. Return a TTML string from its TTML property and Music's
// own loader does the rest — parse, MSVLyricsSongInfo, Lyrics.init,
// VC.lyrics, elapsedTimeProvider, per-glyph render. No Swift ABI, no x20,
// no CModule.
//
// Run (Music open):
//   frida -U -n Music -l tools\frida\12-feed-ttml.js
// Then:  probe()    play a track, open lyrics — see which accessor is
//                   used and which property keys are asked for
// Then:  feed()     answer the TTML key with our payload, reopen lyrics

// ---------------------------------------------------------- key constants

function dataSymbol(mod, name) {
  try {
    var m = Process.getModuleByName(mod);
    var p = m.findExportByName(name);
    if (!p || p.isNull()) return null;
    var s = p.readPointer();
    if (s.isNull()) return null;
    return new ObjC.Object(s).toString();
  } catch (e) { return null; }
}

var KEY_TTML   = dataSymbol("MediaPlayer", "MPModelPropertyLyricsTTML");
var KEY_TIMED  = dataSymbol("MediaPlayer", "MPModelPropertyLyricsHasTimeSyncedLyrics");
var KEY_LYRICS = dataSymbol("MediaPlayer", "MPModelRelationshipSongLyrics");
console.log("MPModelPropertyLyricsTTML = " + KEY_TTML);
console.log("…HasTimeSyncedLyrics      = " + KEY_TIMED);
console.log("MPModelRelationshipSongLyrics = " + KEY_LYRICS);

// ---------------------------------------------------------- payload

function pad(n,w){var s=String(n);while(s.length<w)s="0"+s;return s;}
function clk(ms){
  return pad(Math.floor(ms/3600000),2)+":"+pad(Math.floor(ms/60000)%60,2)+
         ":"+pad(Math.floor(ms/1000)%60,2)+"."+pad(ms%1000,3);
}
function buildTTML() {
  var parts = [];
  for (var i = 0; i < 30; i++) {
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
    '<body dur="'+clk(400000)+'">'+
    '<div begin="'+clk(2000)+'" end="'+clk(95000)+'">'+parts.join("")+'</div>'+
    '</body></tt>';
}

// Retained: Music holds this well past our hook returning.
var TTML_NS = null;
function ttmlString() {
  if (TTML_NS) return TTML_NS;
  var s = ObjC.classes.NSString.stringWithUTF8String_(Memory.allocUtf8String(buildTTML()));
  s.retain();
  TTML_NS = s;
  console.log("payload ready: " + buildTTML().length + " bytes of TTML");
  return TTML_NS;
}

// ---------------------------------------------------------- discovery

function probe() {
  var cls = ObjC.classes.MPModelLyrics;
  if (!cls) { console.log("MPModelLyrics absent"); return; }

  console.log("\n### MPModelLyrics superclass chain");
  var c = cls; while (c) { console.log("  " + c.$className); c = c.$superClass; }

  console.log("\n### accessor-shaped methods (incl. inherited)");
  cls.$methods.filter(function (m) {
    return /valueForProperty|objectForProperty|valueForKey|TTML|hasTimeSynced|_value|propertyS/i.test(m);
  }).sort().forEach(function (m) { console.log("  " + m); });

  // Hook every accessor that exists and log the keys requested. One of
  // these is how the loader asks for TTML.
  var CANDIDATES = [
    ["MPModelLyrics", "- valueForProperty:"],
    ["MPModelLyrics", "- objectForProperty:"],
    ["MPModelLyrics", "- _valueForProperty:"],
    ["MPModelLyrics", "- valueForKey:"],
    ["MPModelLyrics", "- TTML"],
    ["MPModelObject", "- valueForProperty:"],
    ["MPModelObject", "- objectForProperty:"],
    ["MPModelObject", "- _valueForProperty:"],
    ["MPModelSong",   "- valueForProperty:"],
    ["MPModelSong",   "- objectForProperty:"]
  ];

  console.log("\n### hooking accessors");
  CANDIDATES.forEach(function (p) {
    var k = ObjC.classes[p[0]];
    if (!k || !k[p[1]]) { console.log("  [absent] " + p[0] + " " + p[1]); return; }
    Interceptor.attach(k[p[1]].implementation, {
      onEnter: function (args) {
        var key = "(void)";
        if (p[1].indexOf(":") !== -1) {
          try { key = new ObjC.Object(args[2]).toString(); } catch (e) { key = "?"; }
        }
        // Only lyrics-relevant keys, or this floods.
        if (p[1].indexOf(":") === -1 || /lyric|ttml|synced/i.test(key)) {
          console.log("  [accessor] " + p[0] + " " + p[1] + "  key=" + key);
        }
        this.key = key;
      },
      onLeave: function (r) {
        if (this.key && /ttml/i.test(this.key)) {
          console.log("    -> returned " + (r.isNull() ? "nil" : "non-nil"));
          if (FEEDING) {
            var s = ttmlString();
            r.replace(s.handle);
            console.log("    >>> FED our TTML (" + buildTTML().length + " bytes)");
          }
        }
      }
    });
    console.log("  [hooked] " + p[0] + " " + p[1]);
  });

  // Watch the cascade we expect to light up once TTML is non-nil.
  var MOD = null;
  ["MusicApplication", "Music"].forEach(function (n) {
    if (MOD) return; try { MOD = Process.getModuleByName(n); } catch (e) {}
  });
  if (MOD) {
    var ex = MOD.enumerateExports();
    function hook(label, sym) {
      var h = ex.filter(function (s) { return s.name === sym; });
      if (!h.length) { console.log("  [miss] " + label); return; }
      Interceptor.attach(h[0].address, {
        onEnter: function () { console.log("\n*** " + label); }
      });
      console.log("  [hooked] " + label);
    }
    console.log("\n### cascade watches");
    hook("Lyrics.init(identifier:songInfo:) ALLOC",
      "$s11MusicCoreUI6LyricsC10identifier8songInfoACSSSg_So013MSVLyricsSongG0CtcfC");
    hook("Lyrics.init(identifier:songInfo:) PLAIN",
      "$s11MusicCoreUI6LyricsC10identifier8songInfoACSSSg_So013MSVLyricsSongG0Ctcfc");
    hook("SyncedLyricsManager.init  — TIMED PATH",
      "$s11MusicCoreUI19SyncedLyricsManagerC6lyrics13configuration8delegateAcA0E0C_AC13ConfigurationVAA0deF8Delegate_ptcfC");
    hook("elapsedTimeProvider set  — CLOCK WIRED",
      "$s11MusicCoreUI19SyncedLyricsManagerC19elapsedTimeProviderSdycSgvs");
    hook("hasRequest(for:)",
      "$s11MusicCoreUI12LyricsLoaderC10hasRequest3forSbSo11MPModelSongC_tF");
  }

  // Defeat the loader cache so each open rebuilds.
  if (MOD) {
    var h = MOD.enumerateExports().filter(function (s) {
      return s.name === "$s11MusicCoreUI12LyricsLoaderC10hasRequest3forSbSo11MPModelSongC_tF"; });
    if (h.length) {
      Interceptor.attach(h[0].address, {
        onLeave: function (r) { if (r.toInt32() & 1) r.replace(ptr(0)); }
      });
      console.log("  [hooked] hasRequest -> false (cache defeated)");
    }
  }

  // And keep the availability flags true, since the loader may consult them.
  [["MPAVItem","- hasTimeSyncedLyrics"],["MPCModelGenericAVItem","- hasTimeSyncedLyrics"],
   ["MPStoreItemMetadata","- hasTimeSyncedLyrics"],["MPStoreItemMetadata","- hasLyrics"],
   ["MPAVItem","- hasStoreLyrics"],["MPCModelGenericAVItem","- hasStoreLyrics"]].forEach(function (p) {
    var k = ObjC.classes[p[0]];
    if (!k || !k[p[1]]) return;
    Interceptor.attach(k[p[1]].implementation, {
      onLeave: function (r) { if (r.toInt32() === 0) r.replace(ptr(1)); }
    });
  });
  console.log("  [forcing] hasTimeSyncedLyrics / hasStoreLyrics -> YES");

  console.log("\nNow: play a track and open the lyrics view. Note which accessor logs a TTML key.");
}

var FEEDING = false;
function feed() {
  ttmlString();
  FEEDING = true;
  console.log("[FEEDING] TTML will be returned for any *TTML* property key.");
  console.log("Close the lyrics view and reopen it, or skip to the next track.");
}
function stop() { FEEDING = false; console.log("[stopped]"); }

console.log("\nReady.  probe()   then   feed()   (stop() to halt)");
