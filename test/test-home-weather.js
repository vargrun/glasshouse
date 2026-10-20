/**
 * test/test-home-weather.js - Glasshouse Home's weather from Open-Meteo:
 * nothing is asked while it is off or has no place; the answer is now and the
 * next two days; one request serves 30 minutes and every caller waiting on
 * it; a failure keeps the last answer, marked stale, until it is six hours
 * old; places are searched for by name.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var weather = require('../server/lib/home-weather');

console.log('Running test-home-weather.js ...');

var SARAJEVO = { name: 'Sarajevo', region: 'Federacija Bosne i Hercegovine', country: 'Bosna i Hercegovina', lat: 43.84864, lon: 18.35644 };
var ON = { on: true, place: SARAJEVO, units: 'c' };

// Open-Meteo's forecast for three days, as a C1 (webOS 6.5.3) received it.
function forecast() {
  return {
    current: { time: '2026-10-20T21:15', temperature_2m: 12.3, weather_code: 0, is_day: 0 },
    daily: { time: ['2026-10-20', '2026-10-21', '2026-10-22'], weather_code: [3, 63, 71],
             temperature_2m_max: [16.1, 14.6, 9.4], temperature_2m_min: [5.2, 6.5, 1.4] }
  };
}

var clock = 1000000;
var asked = [], answers = [];
// Each request waits for an answer handed to it, so callers can pile up.
function getJson(url, cb) {
  asked.push(url);
  answers.push(cb);
}
function answer(err, doc) { answers.shift()(err, doc); }

function fresh() {
  asked = [];
  answers = [];
  weather.init({ getJson: getJson, now: function () { return clock; } });
}

var results = [];
function got(r) { results.push(r); }

// Off, or on without a place: nothing asked.
fresh();
weather.weather({ on: false, place: SARAJEVO }, got);
weather.weather({ on: true, place: null }, got);
assert.strictEqual(asked.length, 0, 'nothing is sent while it is off or has no place');
assert.strictEqual(results[0].weather, null);
assert.strictEqual(results[1].weather, null);
console.log('  ✓ nothing is asked while the weather is off or has no place');

// One request for every caller waiting, shaped as the view shows it.
results = [];
weather.weather(ON, got);
weather.weather(ON, got);
assert.strictEqual(asked.length, 1, 'callers asking together share one request');
assert.ok(/latitude=43\.8486&longitude=18\.3564/.test(asked[0]), asked[0]);
assert.ok(/current=temperature_2m,weather_code,is_day/.test(asked[0]));
assert.ok(/forecast_days=3/.test(asked[0]) && !/fahrenheit/.test(asked[0]));
answer(null, forecast());
assert.strictEqual(results.length, 2);
var w = results[0].weather;
assert.deepEqual(w.now, { temp: 12, code: 0, day: false });
assert.deepEqual(w.days, [{ date: '2026-10-21', code: 63, max: 15, min: 7 }, { date: '2026-10-22', code: 71, max: 9, min: 1 }],
                 'tomorrow and the day after, rounded; today is left out');
assert.strictEqual(w.place, 'Sarajevo');
assert.ok(!w.stale);
console.log('  ✓ callers asking together share one request, answered with now and the next two days');

// Within 30 minutes the answer is kept; after, it is asked for again.
results = [];
clock += weather.FRESH_MS - 1000;
weather.weather(ON, got);
assert.strictEqual(asked.length, 1, 'kept for 30 minutes');
assert.strictEqual(results[0].weather.now.temp, 12);
clock += 2000;
weather.weather(ON, got);
assert.strictEqual(asked.length, 2, 'asked again after 30 minutes');
console.log('  ✓ one answer serves 30 minutes');

// A failure keeps the last answer, marked stale, and waits before trying again.
answer(new Error('Could not resolve host'));
var stale = results[1].weather;
assert.strictEqual(stale.now.temp, 12, 'the last answer is kept');
assert.strictEqual(stale.stale, true);
results = [];
clock += 60 * 1000;
weather.weather(ON, got);
assert.strictEqual(asked.length, 2, 'not tried again within five minutes of a failure');
assert.strictEqual(results[0].weather.stale, true);
clock += 5 * 60 * 1000;
weather.weather(ON, got);
assert.strictEqual(asked.length, 3, 'tried again after five minutes');
answer(null, { error: true, reason: 'Parameter out of range' });
clock += 6 * 60 * 60 * 1000;
results = [];
weather.weather(ON, got);
answer(new Error('timed out'));
assert.strictEqual(results[0].weather, null, 'an answer six hours old is not shown');
console.log('  ✓ a failure keeps the last answer, stale, until it is six hours old');

// Another place or Fahrenheit is its own request.
fresh();
results = [];
weather.weather({ on: true, place: SARAJEVO, units: 'f' }, got);
assert.ok(/temperature_unit=fahrenheit/.test(asked[0]));
answer(null, forecast());
assert.strictEqual(results[0].weather.units, 'f');
weather.weather({ on: true, place: SARAJEVO, units: 'c' }, got);
assert.strictEqual(asked.length, 2, 'a change of units is asked for at once');
console.log('  ✓ Fahrenheit is asked for as such');

// Settings as the layout keeps them.
assert.deepEqual(weather.validSettings({ on: 'yes', units: 'k', place: { name: 'X', lat: 91, lon: 0 } }),
                 { on: false, place: null, units: 'c', showPlace: false }, 'anything it cannot use is dropped');
assert.deepEqual(weather.validSettings({ on: true, place: { name: ' Mostar ', lat: 43.3438, lon: 17.8078 }, units: 'f' }),
                 { on: true, place: { name: 'Mostar', lat: 43.3438, lon: 17.8078 }, units: 'f', showPlace: false });
console.log('  ✓ settings it cannot use are dropped');

// The search: names checked, places shaped, the language passed on.
fresh();
var found = [];
weather.search('S', 'bs', function (r) { found.push(r); });
assert.strictEqual(found[0].ok, false, 'one letter is too few');
assert.strictEqual(asked.length, 0);
weather.search('Sarajevo & co', 'bs', function (r) { found.push(r); });
assert.ok(/name=Sarajevo%20%26%20co&count=8&language=bs/.test(asked[0]), asked[0]);
answer(null, { results: [
  { name: 'Sarajevo', admin1: 'Federacija Bosne i Hercegovine', country: 'Bosna i Hercegovina', latitude: 43.84864, longitude: 18.35644 },
  { name: 'Broken', latitude: 'north', longitude: 1 }
] });
assert.deepEqual(found[1], { ok: true, places: [{ name: 'Sarajevo', lat: 43.8486, lon: 18.3564,
  region: 'Federacija Bosne i Hercegovine', country: 'Bosna i Hercegovina' }] }, 'a result without coordinates is left out');
weather.search('Mostar', 'not a language', function (r) { found.push(r); });
assert.ok(/language=en/.test(asked[1]));
answer(null, {});
assert.deepEqual(found[2], { ok: true, places: [] }, 'no results is an empty list');
weather.search('Tuzla', 'bs', function (r) { found.push(r); });
answer(new Error('timed out'));
assert.strictEqual(found[3].ok, false);
console.log('  ✓ places are searched for by name, in the language asked for');

console.log('ALL test-home-weather.js assertions passed!\n');
