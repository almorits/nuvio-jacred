/**
 * jacred - Nuvio provider: torrent search via JacRed/Jackett API.
 * Streams are returned as magnet links and played by Nuvio's built-in TorrServer (P2P).
 */
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

var TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";
var TMDB_BASE_URL = "https://api.themoviedb.org/3";
var UA = "Lampa";

var DEFAULT_JACKETT_URL = "jac.red";
var DEFAULT_JACKETT_KEY = "878b0c138b0b4944aba9321e1d54b182";

function cfg() {
  try {
    return globalThis.SCRAPER_SETTINGS || {};
  } catch (e) {
    return {};
  }
}

function jackettUrl() {
  var u = String(cfg().jackettUrl || DEFAULT_JACKETT_URL).trim();
  u = u.replace(/\/+$/, "");
  if (u.indexOf("http") !== 0) u = "https://" + u;
  return u;
}

function jackettKey() {
  return String(cfg().jackettApiKey || DEFAULT_JACKETT_KEY).trim();
}

function hasTimers() {
  try {
    return typeof setTimeout === "function" && typeof clearTimeout === "function";
  } catch (e) {
    return false;
  }
}

function fetchWithTimeout(url, options, timeoutMs) {
  return __async(this, null, function* () {
    if (!hasTimers()) {
      return fetch(url, options || {});
    }
    var timer = null;
    try {
      var fetchPromise = fetch(url, options || {});
      var timeoutPromise = new Promise(function (_, reject) {
        timer = setTimeout(function () {
          reject(new Error("timeout after " + timeoutMs + "ms"));
        }, timeoutMs || 20000);
      });
      var res = yield Promise.race([fetchPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);
      return res;
    } catch (e) {
      if (timer) clearTimeout(timer);
      throw e;
    }
  });
}

var metaCache = {};
function fetchTmdbMeta(tmdbId, mediaType) {
  return __async(this, null, function* () {
    var type = mediaType === "tv" ? "tv" : "movie";
    var key = type + ":" + tmdbId;
    if (metaCache[key]) return metaCache[key];
    var url = TMDB_BASE_URL + "/" + type + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
    var meta = { title: "", originalTitle: "", year: null };
    try {
      var res = yield fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 15000);
      if (!res.ok) throw new Error("TMDB HTTP " + res.status);
      var data = yield res.json();
      meta.title = type === "movie" ? (data.title || "") : (data.name || "");
      meta.originalTitle = data.original_title || data.original_name || meta.title;
      var date = data.release_date || data.first_air_date || "";
      meta.year = date ? parseInt(String(date).substring(0, 4), 10) || null : null;
    } catch (e) {
      console.log("[jacred][tmdb] " + e.message);
    }
    metaCache[key] = meta;
    return meta;
  });
}

function parseQuality(title, apiQuality) {
  var s = String(title || "").toLowerCase();
  if (/2160p|4k|uhd/.test(s)) return "4K";
  if (/1080p|1080i/.test(s)) return "1080p";
  if (/720p|720i/.test(s)) return "720p";
  if (/480p|576p|dvd/.test(s)) return "480p";
  if (/cam|ts\b|telesync/.test(s)) return "CAM";
  var q = parseInt(apiQuality, 10);
  if (q >= 2000) return "4K";
  if (q >= 1000) return "1080p";
  if (q >= 700) return "720p";
  if (q > 0) return "480p";
  return "Auto";
}

function qualityRank(q) {
  switch (q) {
    case "4K": return 5;
    case "1080p": return 4;
    case "720p": return 3;
    case "480p": return 2;
    case "CAM": return 0;
    default: return 1;
  }
}

function humanSize(bytes) {
  var n = Number(bytes);
  if (!isFinite(n) || n <= 0) return "";
  var gb = n / 1073741824;
  if (gb >= 1) return gb.toFixed(gb >= 10 ? 1 : 2) + " GB";
  return (n / 1048576).toFixed(0) + " MB";
}

function infoHashOf(magnet) {
  var m = /btih:([0-9a-fA-F]{32,40})/i.exec(String(magnet || ""));
  return m ? m[1].toLowerCase() : null;
}

function jackettSearch(query) {
  return __async(this, null, function* () {
    var url = jackettUrl() + "/api/v2.0/indexers/all/results?apikey=" +
      encodeURIComponent(jackettKey()) + "&Query=" + encodeURIComponent(query);
    try {
      var res = yield fetchWithTimeout(url, { headers: { "User-Agent": UA, Accept: "application/json" } }, 30000);
      if (!res.ok) throw new Error("JacRed HTTP " + res.status);
      var data = yield res.json();
      return (data && data.Results) || [];
    } catch (e) {
      console.log("[jacred][search] " + e.message);
      return [];
    }
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return __async(this, null, function* () {
    var meta = yield fetchTmdbMeta(String(tmdbId), mediaType);
    var isTv = mediaType === "tv";
    var names = [];
    [meta.originalTitle, meta.title].forEach(function (n) {
      if (n && names.indexOf(n) === -1) names.push(n);
    });
    if (!names.length) return [];

    var query = names[0];
    if (meta.year && !isTv) query += " " + meta.year;

    var results = yield jackettSearch(query);
    if (!results.length && names.length > 1) {
      query = names[1] + (meta.year && !isTv ? " " + meta.year : "");
      results = yield jackettSearch(query);
    }

    var seen = {};
    var out = [];
    results.forEach(function (r) {
      if (!r || !r.MagnetUri) return;
      var magnet = String(r.MagnetUri);
      var infoHash = infoHashOf(magnet);
      if (infoHash && seen[infoHash]) return;
      if (infoHash) seen[infoHash] = 1;

      var info = r.info || {};
      var quality = parseQuality(r.Title, info.quality);
      var seeders = Number(r.Seeders) || 0;
      var sizeBytes = Number(r.Size) || 0;
      var sizeStr = humanSize(sizeBytes) || info.sizeName || "";
      var tracker = String(r.Tracker || "");

      var line1 = String(r.Title || "").slice(0, 200);
      var line2 = [
        tracker,
        seeders ? "👤 " + seeders : "",
        sizeStr,
        info.videotype ? String(info.videotype).toUpperCase() : ""
      ].filter(Boolean).join(" • ");

      out.push({
        name: "JacRed " + quality,
        title: line1 + "\n" + line2,
        url: magnet,
        quality: quality,
        size: sizeStr || undefined,
        seeders: seeders || undefined,
        infoHash: infoHash || undefined,
        headers: {},
        subtitles: [],
        _rank: qualityRank(quality),
        _seeders: seeders
      });
    });

    out.sort(function (a, b) {
      if (b._rank !== a._rank) return b._rank - a._rank;
      return (b._seeders || 0) - (a._seeders || 0);
    });
    return out.slice(0, 30).map(function (s) {
      delete s._rank;
      delete s._seeders;
      return s;
    });
  });
}

function onSettings() {
  return [
    { type: "header", label: "JacRed / Jackett" },
    {
      type: "text",
      key: "jackettUrl",
      label: "Server URL",
      placeholder: "jac.red",
      description: "JacRed or Jackett server address"
    },
    {
      type: "text",
      key: "jackettApiKey",
      label: "API Key",
      placeholder: "api key",
      isPassword: true,
      description: "API key from the server"
    }
  ];
}

module.exports = { getStreams, onSettings };
