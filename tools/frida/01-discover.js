// 01-discover.js — dump the exact selector names we need to hook.
//
// The frida-trace pass proved MSVLyricsTTMLParser and MSVLyricsSongInfo
// exist in-process and are never called, and that MPModelLyrics carries
// an MPModelPropertyLyricsTTML with no database mapping. What it did NOT
// give us is the accessor names, because trace only shows what actually
// ran. This enumerates them.
//
// Run: frida -U -f com.apple.Music -l 01-discover.js

function dump(name) {
  var cls = ObjC.classes[name];
  if (!cls) { console.log("\n### MISSING: " + name); return; }
  console.log("\n### " + name);

  // Own methods only — inherited NSObject noise is not useful here.
  var hits = cls.$ownMethods.filter(function (m) {
    return /lyric|ttml|sync|syllable|timing|token|seek|scrub/i.test(m);
  });
  if (hits.length === 0) { console.log("   (no matching selectors)"); return; }
  hits.forEach(function (m) { console.log("   " + m); });
}

// The model + item layer: where the availability answer and the payload live.
[
  "MPModelLyrics",
  "MPModelSong",
  "MPAVItem",
  "MPCModelGenericAVItem",
  "MPStoreItemMetadata",
  "MPNowPlayingInfoLyricsItem",
  "MPNowPlayingInfoLyricsItemToken",
  "MPNowPlayingContentItem"
].forEach(dump);

// The renderer side: what consumes TTML once something provides it.
[
  "MSVLyricsTTMLParser",
  "MSVLyricsSongInfo",
  "MSVLyricsTextElement",
  "MSVLyricsTranslationText"
].forEach(dump);

// Anything else in the process whose name smells like the lyrics UI.
// This is how we find the view controller to hook for Route 3, and any
// class that takes a TTML string as input.
console.log("\n### classes matching /Lyric/ (name only)");
ObjC.enumerateLoadedClassesSync()  // grouped by module
  && Object.keys(ObjC.classes).filter(function (n) {
       return /Lyric/i.test(n);
     }).sort().forEach(function (n) { console.log("   " + n); });

console.log("\n### done — paste everything above");
