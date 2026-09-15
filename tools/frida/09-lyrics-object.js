// 09-lyrics-object.js
//
// WHERE WE ARE
//   Payload: solved. MSVLyricsTTMLParser accepts our TTML; timing="Word"
//   yields info.type=2 with per-word MSVLyricsWord objects and working
//   wordsAtTimeOffset: queries.
//
//   Seam: found. From 08's symbol dump —
//     static LyricsLoader.supportsLyrics(for: MPModelSong) -> Bool
//     LyricsLoader.loadLyrics(for: MPModelSong,
//                             completion: (Result?, Error?) -> ())
//     SyncedLyricsManager.init(lyrics: Lyrics, configuration:, delegate:)
//     SyncedLyricsManager.elapsedTimeProvider: (() -> Double)?  { get set }
//
// MISSING LINK
//   What turns an MSVLyricsSongInfo into the `MusicCoreUI.Lyrics` object
//   that SyncedLyricsManager.init wants. 08 truncated at 1219 symbols and
//   the Lyrics class members were in the cut. This finds them, and reads
//   the ivars of the Swift classes — they are ObjC-visible classes even
//   though they expose no ObjC methods, so the runtime still reports
//   their stored properties, which is the fastest way to see whether
//   Lyrics simply wraps a songInfo.
//
// Run (Music open):
//   frida -U -n Music -l tools\frida\09-lyrics-object.js
// Then:  ivars()    syms()    hooks()
// After hooks(), play a track and open lyrics on the phone.

// MusicCoreUI is statically linked into the Music binary — 08 could not
// find it as its own module but MusicApplication exported all of its
// symbols. Resolve once and reuse.
var MOD = null;
["MusicApplication", "Music"].forEach(function (n) {
  if (MOD) return;
  try { MOD = Process.getModuleByName(n); console.log("module: " + n + " @ " + MOD.base); }
  catch (e) {}
});
if (!MOD) console.log("could not locate the Music module");

// ============================================ ivars

function ivars() {
  ["MusicCoreUI.Lyrics",
   "MusicCoreUI.SyncedLyricsManager",
   "MusicCoreUI.SyncedLyricsViewController",
   "MusicCoreUI.SyncedLyricsLineView",
   "MusicApplication.StaticLyricsViewController",
   "MusicNowPlayingLyricsViewController"].forEach(function (name) {
    var cls = ObjC.classes[name];
    console.log("\n### " + name);
    if (!cls) { console.log("   absent"); return; }
    try {
      var iv = cls.$ivars;
      var keys = Object.keys(iv);
      if (keys.length === 0) { console.log("   (no ivars reported)"); return; }
      keys.forEach(function (k) { console.log("   ivar  " + k); });
    } catch (e) { console.log("   $ivars threw: " + e.message); }
    try {
      var own = cls.$ownMethods;
      if (own.length) own.forEach(function (m) { console.log("   meth  " + m); });
    } catch (e) {}
  });
}

// ============================================ targeted symbol search

// Each entry: label, mangled prefix. Swift mangling: 11MusicCoreUI is
// the module, then <len><name>, then C=class O=enum V=struct P=protocol.
var TARGETS = [
  ["MusicCoreUI.Lyrics (class)",        "$s11MusicCoreUI6LyricsC"],
  ["LyricsLoader.Result (enum)",        "$s11MusicCoreUI12LyricsLoaderC6ResultO"],
  ["LyricsLine (protocol)",             "$s11MusicCoreUI10LyricsLine"],
  ["LyricsWord",                        "$s11MusicCoreUI10LyricsWord"],
  ["TimedElement (protocol)",           "$s11MusicCoreUI12TimedElement"],
  ["SyncedLyricsViewController",        "$s11MusicCoreUI26SyncedLyricsViewControllerC"],
  ["SyncedLyricsManagerDelegate",       "$s11MusicCoreUI27SyncedLyricsManagerDelegate"]
];

function syms() {
  if (!MOD) return;
  var all;
  try { all = MOD.enumerateExports(); }
  catch (e) { console.log("enumerateExports: " + e.message); return; }

  TARGETS.forEach(function (t) {
    console.log("\n########## " + t[0] + " ##########");
    var hits = all.filter(function (s) { return s.name.indexOf(t[1]) === 0; });
    if (hits.length === 0) { console.log("  (none)"); return; }
    // Initialisers (fC/fc), getters (vg), setters (vs) and plain funcs
    // (F) are the useful ones; metadata accessors (Ma/Mn/N/MV/Wv) are
    // noise, so sort them to the bottom rather than dropping them.
    var interesting = hits.filter(function (s) { return /fC$|fc$|vg$|vs$|F$|FZ$|yF$/.test(s.name); });
    var rest = hits.filter(function (s) { return interesting.indexOf(s) === -1; });
    interesting.forEach(function (s) { console.log("  * " + s.name); });
    rest.slice(0, 25).forEach(function (s) { console.log("    " + s.name); });
    if (rest.length > 25) console.log("    … " + (rest.length - 25) + " more metadata symbols");
  });
}

// ============================================ hooks

function addr(name) {
  if (!MOD) return null;
  try {
    var hit = MOD.enumerateExports().filter(function (s) { return s.name === name; });
    return hit.length ? hit[0].address : null;
  } catch (e) { return null; }
}

function hooks() {
  // 1. The gate. Forcing this true is what should make Music consider a
  //    local track eligible for synced lyrics at all.
  var supports = addr("$s11MusicCoreUI12LyricsLoaderC08supportsD03forSbSo11MPModelSongC_tFZ");
  if (supports) {
    Interceptor.attach(supports, {
      onLeave: function (r) {
        var was = r.toInt32() & 1;
        if (!was) { r.replace(ptr(1)); }
        console.log("[LyricsLoader.supportsLyrics] " + was + " -> 1");
      }
    });
    console.log("[hooked] static LyricsLoader.supportsLyrics(for:)  @ " + supports);
  } else console.log("[miss] supportsLyrics symbol not found");

  // 2. The loader. Watching it tells us whether forcing the gate makes
  //    Music actually request lyrics, and the Result type is what a
  //    tweak would have to fabricate.
  [["loadLyrics(for:completion:)",
    "$s11MusicCoreUI12LyricsLoaderC04loadD03for10completionySo11MPModelSongC_yAC6ResultOSg_s5Error_pSgtctF"],
   ["loadLyrics(for:) async",
    "$s11MusicCoreUI12LyricsLoaderC04loadD03forAC6ResultOSo11MPModelSongC_tYaKF"],
   ["LyricsLoader.hasRequest(for:)",
    "$s11MusicCoreUI12LyricsLoaderC10hasRequest3forSbSo11MPModelSongC_tF"],
   ["LyricsLoader.requiredProperties()",
    "$s11MusicCoreUI12LyricsLoaderC18requiredPropertiesSo13MPPropertySetCyFZ"]
  ].forEach(function (p) {
    var a = addr(p[1]);
    if (!a) { console.log("[miss] " + p[0]); return; }
    Interceptor.attach(a, {
      onEnter: function () {
        console.log("\n*** " + p[0]);
        console.log("  " + Thread.backtrace(this.context, Backtracer.ACCURATE)
          .map(DebugSymbol.fromAddress).slice(0, 12).join("\n  "));
      }
    });
    console.log("[hooked] " + p[0] + "  @ " + a);
  });

  // 3. The renderer's constructor and its clock. If init ever fires we
  //    have won; if elapsedTimeProvider is set we know exactly how the
  //    position is fed in.
  [["SyncedLyricsManager.init(lyrics:configuration:delegate:)",
    "$s11MusicCoreUI19SyncedLyricsManagerC6lyrics13configuration8delegateAcA0E0C_AC13ConfigurationVAA0deF8Delegate_ptcfC"],
   ["SyncedLyricsManager.elapsedTimeProvider setter",
    "$s11MusicCoreUI19SyncedLyricsManagerC19elapsedTimeProviderSdycSgvs"],
   ["SyncedLyricsManager.update()",
    "$s11MusicCoreUI19SyncedLyricsManagerC6updateyyF"],
   ["SyncedLyricsManager.lyrics getter",
    "$s11MusicCoreUI19SyncedLyricsManagerC6lyricsAA0E0Cvg"]
  ].forEach(function (p) {
    var a = addr(p[1]);
    if (!a) { console.log("[miss] " + p[0]); return; }
    Interceptor.attach(a, {
      onEnter: function () {
        console.log("\n*** " + p[0]);
        console.log("  " + Thread.backtrace(this.context, Backtracer.ACCURATE)
          .map(DebugSymbol.fromAddress).slice(0, 12).join("\n  "));
      }
    });
    console.log("[hooked] " + p[0] + "  @ " + a);
  });

  // 4. Keep the ObjC-level availability flags true as well, since the
  //    Swift gate may consult them.
  [["MPAVItem", "- hasTimeSyncedLyrics"],
   ["MPCModelGenericAVItem", "- hasTimeSyncedLyrics"],
   ["MPStoreItemMetadata", "- hasTimeSyncedLyrics"],
   ["MPStoreItemMetadata", "- hasLyrics"],
   ["MPAVItem", "- hasStoreLyrics"],
   ["MPCModelGenericAVItem", "- hasStoreLyrics"]].forEach(function (p) {
    var cls = ObjC.classes[p[0]];
    if (!cls || !cls[p[1]]) return;
    Interceptor.attach(cls[p[1]].implementation, {
      onLeave: function (r) { if (r.toInt32() === 0) r.replace(ptr(1)); }
    });
  });
  console.log("[forcing] ObjC hasTimeSyncedLyrics / hasStoreLyrics -> YES");

  console.log("\nNow on the phone: play a track, then open the lyrics view.");
}

console.log("\nReady.  ivars()   syms()   hooks()");
