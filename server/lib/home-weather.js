/*
 * lib/home-weather.js - the weather on Glasshouse Home, from Open-Meteo
 *
 * Open-Meteo is free without a key. The TV asks for the chosen place's
 * conditions now and the next two days, through curl or wget (lib/fetch: node
 * 0.12 cannot speak its TLS), and keeps the answer for 30 minutes, so the
 * view and both dashboards share one request. Places are found by name with
 * its geocoding search. Nothing is asked while the weather is off.
 *
 * Strict ES5: runs on node 0.12.
 */
var msg = require('./say').msg;

var FORECAST = 'https://api.open-meteo.com/v1/forecast';
var GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';
var FRESH_MS = 30 * 60 * 1000;
// An answer older than this is not shown: a day's forecast has moved on.
var STALE_MS = 6 * 60 * 60 * 1000;
// After a failure, the next try waits this long rather than following every view refresh.
var RETRY_MS = 5 * 60 * 1000;
var SEARCH_MAX = 8;

var getJsonFn = null;
var nowMs = Date.now;
var cache = null;      // { key, at, weather }
var failedAt = 0, failedKey = '';
var waiting = [], fetching = false;

function init(opts) {
  opts = opts || {};
  getJsonFn = opts.getJson || null;
  nowMs = opts.now || Date.now;
  cache = null;
  failedAt = 0;
  failedKey = '';
  waiting = [];
  fetching = false;
}

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

// A place as the layout keeps it: a name to show and its coordinates.
function validPlace(p) {
  if (!p || typeof p !== 'object') return null;
  var lat = num(p.lat), lon = num(p.lon);
  if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  var name = typeof p.name === 'string' ? p.name.trim().slice(0, 80) : '';
  if (!name) return null;
  var place = { name: name, lat: Math.round(lat * 10000) / 10000, lon: Math.round(lon * 10000) / 10000 };
  if (typeof p.region === 'string' && p.region.trim()) place.region = p.region.trim().slice(0, 80);
  if (typeof p.country === 'string' && p.country.trim()) place.country = p.country.trim().slice(0, 80);
  return place;
}

// { on, place, units, showPlace } as the layout keeps it.
function validSettings(w) {
  w = w && typeof w === 'object' ? w : {};
  return { on: w.on === true, place: validPlace(w.place), units: w.units === 'f' ? 'f' : 'c', showPlace: w.showPlace === true };
}

function forecastUrl(s) {
  return FORECAST + '?latitude=' + s.place.lat + '&longitude=' + s.place.lon +
    '&current=temperature_2m,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min' +
    '&timezone=auto&forecast_days=3' + (s.units === 'f' ? '&temperature_unit=fahrenheit' : '');
}

function round(v) { return v === null ? null : Math.round(v); }

/*
 * Open-Meteo's answer as the view shows it: now, and tomorrow and the day
 * after (daily[0] is today). Codes are WMO weather codes. null where the
 * answer lacks any of it.
 */
function shape(doc, s) {
  var cur = doc && doc.current, daily = doc && doc.daily;
  if (!cur || !daily || !daily.time || daily.time.length < 3) return null;
  var temp = num(cur.temperature_2m), code = num(cur.weather_code);
  if (temp === null || code === null) return null;
  var days = [];
  for (var i = 1; i < 3; i++) {
    var dc = num(daily.weather_code && daily.weather_code[i]);
    var max = num(daily.temperature_2m_max && daily.temperature_2m_max[i]);
    var min = num(daily.temperature_2m_min && daily.temperature_2m_min[i]);
    if (dc === null || max === null || min === null || typeof daily.time[i] !== 'string') return null;
    days.push({ date: daily.time[i], code: dc, max: round(max), min: round(min) });
  }
  return {
    place: s.place.name, units: s.units,
    now: { temp: round(temp), code: code, day: cur.is_day !== 0 },
    days: days
  };
}

/*
 * The weather for these settings: cb({ ok, weather }), weather null while it
 * is off, has no place, or nothing recent could be had. A failure keeps the
 * last answer until it is STALE_MS old, with stale: true.
 */
function weather(settings, cb) {
  var s = validSettings(settings);
  if (!s.on || !s.place || !getJsonFn) return cb({ ok: true, weather: null });
  var key = s.place.lat + ',' + s.place.lon + ',' + s.units;
  var now = nowMs();
  var have = cache && cache.key === key ? cache : null;
  function answer() {
    var c = cache && cache.key === key ? cache : null;
    if (!c || nowMs() - c.at > STALE_MS) return cb({ ok: true, weather: null });
    var w = JSON.parse(JSON.stringify(c.weather));
    w.updatedAt = c.at;
    if (nowMs() - c.at > FRESH_MS) w.stale = true;
    cb({ ok: true, weather: w });
  }
  if (have && now - have.at < FRESH_MS) return answer();
  if (failedKey === key && now - failedAt < RETRY_MS) return answer();
  waiting.push({ key: key, done: answer });
  if (fetching) return;
  fetching = true;
  getJsonFn(forecastUrl(s), function (err, doc) {
    var shaped = err ? null : shape(doc, s);
    if (shaped) {
      cache = { key: key, at: nowMs(), weather: shaped };
      failedKey = '';
    } else {
      failedAt = nowMs();
      failedKey = key;
      console.error('home: the weather could not be read: ' + (err ? err.message : 'an answer without the forecast'));
    }
    fetching = false;
    var batch = waiting.splice(0, waiting.length);
    batch.forEach(function (w) { w.done(); });
  });
}

/*
 * Places named like `name`, in `lang` where Open-Meteo has the names in it:
 * cb({ ok, places }) with each place's name, region, country and coordinates.
 */
function search(name, lang, cb) {
  var q = typeof name === 'string' ? name.trim() : '';
  if (q.length < 2 || q.length > 60) {
    return cb({ ok: false, error: msg('srv.home.weather.searchLength', 'Type 2 to 60 letters of the place\'s name.') });
  }
  if (!getJsonFn) return cb({ ok: false, error: 'weather unavailable' });
  var language = /^[a-z]{2}$/.test(String(lang || '')) ? lang : 'en';
  var url = GEOCODING + '?name=' + encodeURIComponent(q) + '&count=' + SEARCH_MAX + '&language=' + language + '&format=json';
  getJsonFn(url, function (err, doc) {
    if (err) return cb({ ok: false, error: msg('srv.home.weather.searchFailed', 'The place search did not answer: {error}', { error: err.message }) });
    var places = [];
    (doc && doc.results || []).forEach(function (r) {
      var p = validPlace({ name: r.name, region: r.admin1, country: r.country, lat: r.latitude, lon: r.longitude });
      if (p && places.length < SEARCH_MAX) places.push(p);
    });
    cb({ ok: true, places: places });
  });
}

module.exports = {
  init: init,
  weather: weather,
  search: search,
  validSettings: validSettings,
  FRESH_MS: FRESH_MS
};
