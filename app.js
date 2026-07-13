/* My Closet — personal closet tracker + weather-based outfit recommendations */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

const CATEGORIES = [
  { key: 'top',       label: 'Top',       emoji: '👕' },
  { key: 'pants',     label: 'Pants',     emoji: '👖' },
  { key: 'shorts',    label: 'Shorts',    emoji: '🩳' },
  { key: 'skirt',     label: 'Skirt',     emoji: '🥻' },
  { key: 'dress',     label: 'Dress',     emoji: '👗' },
  { key: 'jacket',    label: 'Jacket',    emoji: '🧥' },
  { key: 'shoes',     label: 'Shoes',     emoji: '👟' },
  { key: 'accessory', label: 'Accessory', emoji: '🧣' },
];
const BOTTOM_KEYS = ['pants', 'shorts', 'skirt'];
const LEGACY_CATEGORY = { bottom: 'pants', outerwear: 'jacket' };
const WARMTH_LABELS = ['Very light', 'Light', 'Medium', 'Warm', 'Very warm'];
const catOf = key => CATEGORIES.find(c => c.key === key) || { key, label: key, emoji: '🧺' };

/* ================= storage ================= */

const DB_NAME = 'my-closet';
let _db = null;
function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('outfits')) db.createObjectStore('outfits', { keyPath: 'id' });
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
async function dbPut(store, obj) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(obj);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function dbDelete(store, id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function dbAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const rq = db.transaction(store).objectStore(store).getAll();
    rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error);
  });
}

const settings = Object.assign(
  { unit: 'F', location: null },           // location: {lat, lon, name}
  JSON.parse(localStorage.getItem('closet-settings') || '{}')
);
const saveSettings = () => localStorage.setItem('closet-settings', JSON.stringify(settings));

/* ================= state ================= */

let items = [];
let outfits = [];             // {id, dateKey, at, itemIds[], weather:{tempF,code}|null}
let closetFilter = 'all';
let currentOutfit = null;
let editingId = null;
let pendingPhoto = undefined;  // Blob | null (remove) | undefined (unchanged)
let pendingCut = undefined;    // boolean | undefined (unchanged)
let originalPhotoCanvas = null;
let weather = null;

const photoURLs = new Map();  // id -> objectURL
function photoURL(item) {
  if (!item.photo) return null;
  if (!photoURLs.has(item.id)) photoURLs.set(item.id, URL.createObjectURL(item.photo));
  return photoURLs.get(item.id);
}
function dropPhotoURL(id) {
  if (photoURLs.has(id)) { URL.revokeObjectURL(photoURLs.get(id)); photoURLs.delete(id); }
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 2200);
}

function localDateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateLabel(key) {
  if (key === localDateKey()) return 'Today';
  if (key === localDateKey(new Date(Date.now() - 864e5))) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/* ================= tabs ================= */

function showView(name) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $(`#view-${name}`).classList.remove('hidden');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  window.scrollTo(0, 0);
  if (name === 'closet') renderCloset();
  if (name === 'today') renderToday();
  if (name === 'history') renderHistory();
  if (name === 'add' && editingId === null) resetForm();
}
$$('.tab').forEach(t => t.addEventListener('click', () => { editingId = null; showView(t.dataset.tab); }));
document.body.addEventListener('click', e => {
  const goto = e.target.closest('[data-goto]');
  if (goto) { editingId = null; showView(goto.dataset.goto); }
});

/* ================= weather ================= */

const WMO = [
  [[0], '☀️', 'Clear sky'], [[1], '🌤️', 'Mostly clear'], [[2], '⛅️', 'Partly cloudy'],
  [[3], '☁️', 'Overcast'], [[45, 48], '🌫️', 'Foggy'],
  [[51, 53, 55, 56, 57], '🌦️', 'Drizzle'], [[61, 63, 65, 66, 67], '🌧️', 'Rain'],
  [[71, 73, 75, 77], '❄️', 'Snow'], [[80, 81, 82], '🌦️', 'Rain showers'],
  [[85, 86], '🌨️', 'Snow showers'], [[95, 96, 99], '⛈️', 'Thunderstorm'],
];
function wmoInfo(code) {
  for (const [codes, emoji, desc] of WMO) if (codes.includes(code)) return { emoji, desc };
  return { emoji: '🌡️', desc: '—' };
}

async function fetchWeather(force = false) {
  if (!settings.location) return null;
  const { lat, lon } = settings.location;
  const cacheKey = 'closet-weather';
  const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
  if (!force && cached && cached.lat === lat && cached.lon === lon && Date.now() - cached.at < 30 * 60 * 1000) {
    return cached.data;
  }
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m'
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=1';
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('weather http ' + resp.status);
  const j = await resp.json();
  const data = {
    tempF: j.current.temperature_2m,
    feelsF: j.current.apparent_temperature,
    code: j.current.weather_code,
    windMph: j.current.wind_speed_10m,
    precipNow: j.current.precipitation,
    hiF: j.daily.temperature_2m_max[0],
    loF: j.daily.temperature_2m_min[0],
    rainProb: j.daily.precipitation_probability_max[0] ?? 0,
  };
  localStorage.setItem(cacheKey, JSON.stringify({ lat, lon, at: Date.now(), data }));
  return data;
}

const showT = f => settings.unit === 'F' ? `${Math.round(f)}°` : `${Math.round((f - 32) * 5 / 9)}°`;
const showWind = mph => settings.unit === 'F' ? `${Math.round(mph)} mph` : `${Math.round(mph * 1.609)} km/h`;

function isWet(w) {
  const rainy = [51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,99].includes(w.code);
  const snowy = [71,73,75,77,85,86].includes(w.code);
  return rainy || snowy || w.rainProb >= 40 || w.precipNow > 0;
}

async function renderWeather() {
  const card = $('#weather-card');
  if (!settings.location) {
    card.innerHTML = `<div class="weather-error">Set your location to get weather and outfit suggestions.<br>
      <button class="pill-btn" id="w-setloc" type="button">📍 Set location</button></div>`;
    $('#w-setloc').addEventListener('click', openLocationDialog);
    return;
  }
  $('#location-name').textContent = settings.location.name;
  try {
    weather = await fetchWeather();
    const info = wmoInfo(weather.code);
    card.innerHTML = `
      <div class="weather-main">
        <div class="weather-emoji">${info.emoji}</div>
        <div>
          <div class="weather-temp">${showT(weather.tempF)}</div>
          <div class="weather-desc">${info.desc} · feels like ${showT(weather.feelsF)}</div>
        </div>
      </div>
      <div class="weather-sub">
        <div>H <b>${showT(weather.hiF)}</b> · L <b>${showT(weather.loF)}</b></div>
        <div>Rain <b>${Math.round(weather.rainProb)}%</b></div>
        <div>Wind <b>${showWind(weather.windMph)}</b></div>
      </div>`;
  } catch (e) {
    weather = null;
    card.innerHTML = `<div class="weather-error">Couldn't fetch the weather (are you offline?).<br>
      <button class="pill-btn" id="w-retry" type="button">Try again</button></div>`;
    $('#w-retry').addEventListener('click', () => renderWeather().then(renderOutfit));
  }
}

/* ================= recommendation engine ================= */

function targetWarmth(w) {
  // planning temp: blend "feels like now" with the day's high (°F)
  const t = (w.feelsF + w.hiF) / 2;
  if (t >= 78) return 1;
  if (t >= 64) return 2;
  if (t >= 52) return 3;
  if (t >= 38) return 4;
  return 5;
}

function scoreItem(item, target, wet) {
  let s = 4 - Math.abs(item.warmth - target);
  if (item.favorite) s += 0.7;
  if (wet && (item.category === 'shoes' || item.category === 'jacket')) {
    s += item.waterproof ? 1.3 : -1.2;
  }
  if (item.lastWorn && Date.now() - item.lastWorn < 2 * 864e5) s -= 1.5;
  s += Math.random() * 1.4;   // variety between shuffles
  return s;
}

function pickBest(pool, target, wet) {
  if (!pool.length) return null;
  return pool.map(i => [scoreItem(i, target, wet), i]).sort((a, b) => b[0] - a[0])[0][1];
}

function buildOutfit() {
  if (!weather || !items.length) { currentOutfit = null; return; }
  const target = targetWarmth(weather);
  const wet = isWet(weather);
  const planT = (weather.feelsF + weather.hiF) / 2;
  const by = k => items.filter(i => i.category === k);

  const outfit = [];
  const missing = [];

  const tops = by('top');
  const bottoms = items.filter(i => BOTTOM_KEYS.includes(i.category));
  // dresses are optional, so only consider ones that actually suit today's temperature
  const dresses = by('dress').filter(d => Math.abs(d.warmth - target) <= 1);
  const useDress = dresses.length && (!(tops.length && bottoms.length) || Math.random() < 0.33);
  if (useDress) {
    outfit.push(pickBest(dresses, target, wet));
  } else if (tops.length || bottoms.length) {
    const top = pickBest(tops, target, wet);
    const bottom = pickBest(bottoms, target, wet);
    if (top) outfit.push(top); else missing.push('a top');
    if (bottom) outfit.push(bottom); else missing.push('bottoms');
  } else {
    missing.push('a top', 'bottoms');
  }

  const needsOuter = planT < 62 || (wet && planT < 75);
  if (needsOuter) {
    const outer = pickBest(by('jacket'), Math.max(target, 3), wet);
    if (outer) outfit.push(outer); else missing.push('a jacket');
  }

  const shoes = pickBest(by('shoes'), target, wet);
  if (shoes) outfit.push(shoes); else missing.push('shoes');

  if (planT < 45) {
    const acc = pickBest(by('accessory').filter(a => a.warmth >= 3), target, wet);
    if (acc) outfit.push(acc);
  }

  currentOutfit = { pieces: outfit.filter(Boolean), missing, wet, target };
}

function outfitNote() {
  if (!weather || !currentOutfit) return '';
  const bits = [];
  if (currentOutfit.wet) bits.push('☔️ Rain likely today — take an umbrella' + (currentOutfit.pieces.some(p => p.waterproof) ? '' : ' (nothing waterproof in this pick)'));
  if (weather.windMph >= 20) bits.push('💨 Quite windy out there');
  if (weather.hiF - weather.loF >= 25) bits.push('🌗 Big temperature swing today — layers are your friend');
  if (currentOutfit.missing.length) {
    bits.push(`👀 Your closet has no good match for: ${currentOutfit.missing.join(', ')}`);
  }
  return bits.join(' · ');
}

function itemCardHTML(item) {
  const url = photoURL(item);
  const cut = item.cutout ? ' class="cut"' : '';
  return url ? `<img src="${url}"${cut} alt="">` : `<div class="ph">${catOf(item.category).emoji}</div>`;
}

function renderOutfit() {
  const grid = $('#outfit-grid');
  const note = $('#outfit-note');
  const empty = $('#today-empty');
  const hasItems = items.length > 0;

  $('#shuffle-btn').classList.toggle('hidden', !hasItems || !weather);
  empty.classList.toggle('hidden', hasItems);
  grid.innerHTML = '';
  note.classList.add('hidden');
  $('#wearing-btn').classList.add('hidden');
  if (!hasItems || !weather) return;

  buildOutfit();
  if (!currentOutfit) return;

  for (const item of currentOutfit.pieces) {
    const card = document.createElement('button');
    card.className = 'outfit-card';
    card.type = 'button';
    card.innerHTML = `${itemCardHTML(item)}
      <div class="cap"><b>${esc(item.name)}</b><span>${catOf(item.category).label}</span></div>`;
    card.addEventListener('click', () => openDetail(item.id));
    grid.appendChild(card);
  }
  const n = outfitNote();
  if (n) { note.textContent = n; note.classList.remove('hidden'); }
  updateWearBtn();
}

function updateWearBtn() {
  const btn = $('#wearing-btn');
  if (!currentOutfit || !currentOutfit.pieces.length) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  const logged = outfits.some(o => o.dateKey === localDateKey());
  btn.textContent = logged ? "✓ I'm wearing this (update today's log)" : "✓ I'm wearing this";
}

$('#shuffle-btn').addEventListener('click', renderOutfit);
$('#wearing-btn').addEventListener('click', async () => {
  if (!currentOutfit || !currentOutfit.pieces.length) return;
  const dateKey = localDateKey();
  const existing = outfits.find(o => o.dateKey === dateKey);
  const record = {
    id: existing ? existing.id : uid(),
    dateKey,
    at: Date.now(),
    itemIds: currentOutfit.pieces.map(p => p.id),
    weather: weather ? { tempF: weather.tempF, code: weather.code } : null,
  };
  await dbPut('outfits', record);
  if (existing) outfits[outfits.indexOf(existing)] = record; else outfits.push(record);
  for (const p of currentOutfit.pieces) { p.lastWorn = Date.now(); await dbPut('items', p); }
  updateWearBtn();
  toast('Logged to your outfit history 👌');
});

async function renderToday() {
  const h = new Date().getHours();
  $('#today-greeting').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  await renderWeather();
  renderOutfit();
}

/* ================= outfit history ================= */

function renderHistory() {
  const list = $('#history-list');
  list.innerHTML = '';
  const sorted = [...outfits].sort((a, b) => b.dateKey.localeCompare(a.dateKey) || b.at - a.at);
  $('#history-empty').classList.toggle('hidden', sorted.length > 0);
  $('#history-count').textContent = sorted.length
    ? `${sorted.length} outfit${sorted.length === 1 ? '' : 's'} logged` : '';

  for (const o of sorted) {
    const entry = document.createElement('div');
    entry.className = 'history-entry';

    const pieces = o.itemIds.map(id => items.find(i => i.id === id)).filter(Boolean);
    const w = o.weather ? `${wmoInfo(o.weather.code).emoji} ${showT(o.weather.tempF)}` : '';
    entry.innerHTML = `
      <div class="history-head">
        <div>
          <span class="history-date">${dateLabel(o.dateKey)}</span>
          <span class="history-meta">${w}</span>
        </div>
        <button class="x-btn" type="button" aria-label="Delete entry">✕</button>
      </div>
      <div class="history-thumbs"></div>
      ${pieces.length ? '' : '<p class="subtitle">These items are no longer in your closet.</p>'}`;

    const thumbs = entry.querySelector('.history-thumbs');
    for (const p of pieces) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'history-thumb';
      b.title = p.name;
      b.innerHTML = itemCardHTML(p);
      b.addEventListener('click', () => openDetail(p.id));
      thumbs.appendChild(b);
    }
    entry.querySelector('.x-btn').addEventListener('click', async () => {
      if (!confirm(`Delete the outfit logged ${dateLabel(o.dateKey).toLowerCase()}?`)) return;
      await dbDelete('outfits', o.id);
      outfits = outfits.filter(x => x.id !== o.id);
      renderHistory();
      toast('Entry deleted');
    });
    list.appendChild(entry);
  }
}

/* ================= closet ================= */

function esc(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderFilterChips() {
  const row = $('#filter-chips');
  row.innerHTML = '';
  const mk = (key, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (closetFilter === key ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => { closetFilter = key; renderCloset(); });
    row.appendChild(b);
  };
  mk('all', 'All');
  CATEGORIES.forEach(c => mk(c.key, `${c.emoji} ${c.label}`));
}

function renderCloset() {
  renderFilterChips();
  const grid = $('#closet-grid');
  grid.innerHTML = '';
  const list = items
    .filter(i => closetFilter === 'all' || i.category === closetFilter)
    .sort((a, b) => (b.favorite - a.favorite) || (b.createdAt - a.createdAt));
  $('#closet-count').textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
  $('#closet-empty').classList.toggle('hidden', list.length > 0);
  for (const item of list) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'closet-cell';
    cell.innerHTML = `${itemCardHTML(item)}
      ${item.favorite ? '<span class="fav-badge">♥</span>' : ''}
      <span class="nm">${esc(item.name)}</span>`;
    cell.addEventListener('click', () => openDetail(item.id));
    grid.appendChild(cell);
  }
}

/* ---------- detail dialog ---------- */
let detailId = null;
function openDetail(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  detailId = id;
  const url = photoURL(item);
  const img = $('#d-photo');
  img.classList.toggle('hidden', !url);
  img.classList.toggle('cut', !!item.cutout);
  if (url) img.src = url;
  $('#d-name').textContent = item.name;
  const meta = [catOf(item.category).label, WARMTH_LABELS[item.warmth - 1]];
  if (item.waterproof) meta.push('rain-friendly');
  $('#d-meta').textContent = meta.join(' · ');
  $('#d-notes').textContent = item.notes || '';
  $('#d-fav').classList.toggle('fav-on', !!item.favorite);
  $('#item-dialog').showModal();
}
$('#d-close').addEventListener('click', () => $('#item-dialog').close());
$('#d-fav').addEventListener('click', async () => {
  const item = items.find(i => i.id === detailId);
  item.favorite = !item.favorite;
  await dbPut('items', item);
  $('#d-fav').classList.toggle('fav-on', item.favorite);
  renderCloset();
});
$('#d-edit').addEventListener('click', () => {
  $('#item-dialog').close();
  openEdit(detailId);
});

/* ================= photo processing ================= */

function fileToCanvas(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 900;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas);
    };
    img.onerror = () => reject(new Error('bad image'));
    img.src = URL.createObjectURL(file);
  });
}

/* Background cutout: flood-fill from the photo borders, adaptive to gradients,
   then crop to the garment. Runs entirely on-device. */
function cutOutBackground(src, tol) {
  const w = src.width, h = src.height;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const imgd = ctx.getImageData(0, 0, w, h);
  const d = imgd.data;

  // mean border color as the global background reference
  let rm = 0, gm = 0, bm = 0, n = 0;
  const addMean = (x, y) => { const i = (y * w + x) * 4; rm += d[i]; gm += d[i + 1]; bm += d[i + 2]; n++; };
  for (let x = 0; x < w; x++) { addMean(x, 0); addMean(x, h - 1); }
  for (let y = 0; y < h; y++) { addMean(0, y); addMean(w - 1, y); }
  rm /= n; gm /= n; bm /= n;

  const dist2 = (i, r, g, b) => {
    const dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b;
    return dr * dr + dg * dg + db * db;
  };
  const t2 = tol * tol * 3;

  const bg = new Uint8Array(w * h);
  const qx = new Int32Array(w * h), qy = new Int32Array(w * h);
  let qs = 0, qe = 0;
  const seed = (x, y) => {
    const p = y * w + x;
    if (!bg[p] && dist2(p * 4, rm, gm, bm) < t2 * 2.2) { bg[p] = 1; qx[qe] = x; qy[qe] = y; qe++; }
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

  while (qs < qe) {
    const x = qx[qs], y = qy[qs]; qs++;
    const ci = (y * w + x) * 4;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const p = ny * w + nx;
      if (bg[p]) continue;
      const i4 = p * 4;
      // background if close to the overall border color, or reachable via a very
      // small step from a neighboring bg pixel (shadows/gradients) — the step must
      // be tiny and stay loosely near the border color, or the fill leaks through
      // compression-softened garment edges
      const nearGlobal = dist2(i4, rm, gm, bm);
      if (nearGlobal < t2 * 1.8 ||
          (nearGlobal < t2 * 8 && dist2(i4, d[ci], d[ci + 1], d[ci + 2]) < t2 * 0.35)) {
        bg[p] = 1; qx[qe] = nx; qy[qe] = ny; qe++;
      }
    }
  }

  // sanity check: a real cutout removes some background but not the whole photo
  const removed = qe / (w * h);
  if (removed < 0.08 || removed > 0.95) return null;

  // despeckle: drop small disconnected foreground islands (shadow specks, lint)
  // but keep anything comparable to the main garment (e.g. a pair of shoes)
  const comp = new Int32Array(w * h);
  const sizes = [0];
  let nc = 0;
  for (let p0 = 0; p0 < w * h; p0++) {
    if (bg[p0] || comp[p0]) continue;
    nc++;
    let size = 0;
    qs = 0; qe = 0;
    comp[p0] = nc; qx[qe] = p0 % w; qy[qe] = (p0 / w) | 0; qe++;
    while (qs < qe) {
      const x = qx[qs], y = qy[qs]; qs++;
      size++;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const p = ny * w + nx;
        if (bg[p] || comp[p]) continue;
        comp[p] = nc; qx[qe] = nx; qy[qe] = ny; qe++;
      }
    }
    sizes.push(size);
  }
  const maxSize = Math.max(...sizes);
  for (let p = 0; p < w * h; p++) {
    if (!bg[p] && sizes[comp[p]] < maxSize * 0.05) bg[p] = 1;
  }

  // apply transparency, soften edges, find garment bounding box
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (bg[p]) { d[p * 4 + 3] = 0; continue; }
      const edge = (x > 0 && bg[p - 1]) || (x < w - 1 && bg[p + 1]) || (y > 0 && bg[p - w]) || (y < h - 1 && bg[p + w]);
      if (edge) d[p * 4 + 3] = 150;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  ctx.putImageData(imgd, 0, 0);

  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.05) + 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
  return out;
}

async function processPhoto() {
  if (!originalPhotoCanvas) return;
  const wantCut = $('#f-cutout').checked;
  let canvas = originalPhotoCanvas;
  let isCut = false;
  if (wantCut) {
    const res = cutOutBackground(originalPhotoCanvas, +$('#f-cutout-strength').value);
    if (res) { canvas = res; isCut = true; }
    else toast("Couldn't isolate the item — keeping the full photo");
  }
  pendingPhoto = await new Promise(r => canvas.toBlob(r, isCut ? 'image/png' : 'image/jpeg', 0.82));
  pendingCut = isCut;
  const prev = $('#photo-preview');
  if (prev.src) URL.revokeObjectURL(prev.src);
  prev.src = URL.createObjectURL(pendingPhoto);
  prev.classList.toggle('cut', isCut);
  prev.classList.remove('hidden');
  $('#photo-hint').classList.add('hidden');
  $('#cutout-strength-wrap').classList.toggle('hidden', !wantCut);
}

$('#photo-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    originalPhotoCanvas = await fileToCanvas(file);
    $('#cutout-field').classList.remove('hidden');
    await processPhoto();
  } catch {
    toast("Couldn't read that photo");
  }
});
$('#f-cutout').addEventListener('change', processPhoto);
let strengthTimer = null;
$('#f-cutout-strength').addEventListener('input', () => {
  clearTimeout(strengthTimer);
  strengthTimer = setTimeout(processPhoto, 250);
});

/* ================= add / edit form ================= */

function renderCategoryChips(selected) {
  const row = $('#f-category');
  row.innerHTML = '';
  CATEGORIES.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (selected === c.key ? ' active' : '');
    b.dataset.key = c.key;
    b.textContent = `${c.emoji} ${c.label}`;
    b.addEventListener('click', () => renderCategoryChips(c.key));
    row.appendChild(b);
  });
}
const selectedCategory = () => $('#f-category .chip.active')?.dataset.key || null;

function resetForm() {
  editingId = null;
  pendingPhoto = undefined;
  pendingCut = undefined;
  originalPhotoCanvas = null;
  $('#add-title').textContent = 'Add item';
  $('#item-form').reset();
  $('#f-warmth').value = 3;
  $('#f-cutout').checked = true;
  $('#f-cutout-strength').value = 30;
  $('#warmth-label').textContent = WARMTH_LABELS[2];
  renderCategoryChips(null);
  $('#photo-preview').classList.add('hidden');
  $('#photo-preview').removeAttribute('src');
  $('#photo-hint').classList.remove('hidden');
  $('#cutout-field').classList.add('hidden');
  $('#delete-btn').classList.add('hidden');
  $('#save-btn').textContent = 'Save to closet';
}

function openEdit(id) {
  const item = items.find(i => i.id === id);
  if (!item) return;
  resetForm();
  editingId = id;
  $('#add-title').textContent = 'Edit item';
  $('#f-name').value = item.name;
  $('#f-warmth').value = item.warmth;
  $('#warmth-label').textContent = WARMTH_LABELS[item.warmth - 1];
  $('#f-waterproof').checked = !!item.waterproof;
  $('#f-favorite').checked = !!item.favorite;
  $('#f-notes').value = item.notes || '';
  renderCategoryChips(item.category);
  const url = photoURL(item);
  if (url) {
    $('#photo-preview').src = url;
    $('#photo-preview').classList.toggle('cut', !!item.cutout);
    $('#photo-preview').classList.remove('hidden');
    $('#photo-hint').classList.add('hidden');
  }
  $('#delete-btn').classList.remove('hidden');
  $('#save-btn').textContent = 'Save changes';
  showView('add');
}

$('#f-warmth').addEventListener('input', e => {
  $('#warmth-label').textContent = WARMTH_LABELS[e.target.value - 1];
});

$('#item-form').addEventListener('submit', async e => {
  e.preventDefault();
  const category = selectedCategory();
  if (!category) { toast('Pick a category'); return; }
  const existing = editingId ? items.find(i => i.id === editingId) : null;
  const item = {
    id: editingId || uid(),
    name: $('#f-name').value.trim(),
    category,
    warmth: +$('#f-warmth').value,
    waterproof: $('#f-waterproof').checked,
    favorite: $('#f-favorite').checked,
    notes: $('#f-notes').value.trim(),
    photo: pendingPhoto !== undefined ? pendingPhoto : (existing ? existing.photo : null),
    cutout: pendingCut !== undefined ? pendingCut : (existing ? !!existing.cutout : false),
    createdAt: existing ? existing.createdAt : Date.now(),
    lastWorn: existing ? existing.lastWorn : null,
  };
  await dbPut('items', item);
  dropPhotoURL(item.id);
  if (existing) items[items.indexOf(existing)] = item; else items.push(item);
  toast(existing ? 'Saved ✓' : 'Added to closet ✓');
  editingId = null;
  resetForm();
  showView('closet');
});

$('#delete-btn').addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('Delete this item from your closet?')) return;
  await dbDelete('items', editingId);
  dropPhotoURL(editingId);
  items = items.filter(i => i.id !== editingId);
  editingId = null;
  toast('Deleted');
  showView('closet');
});

/* ================= location ================= */

function openLocationDialog() {
  $('#city-results').innerHTML = '';
  $('#city-search').value = '';
  $('#location-dialog').showModal();
}
$('#location-btn').addEventListener('click', openLocationDialog);
$('#loc-close').addEventListener('click', () => $('#location-dialog').close());

async function setLocation(loc) {
  settings.location = loc;
  saveSettings();
  localStorage.removeItem('closet-weather');
  $('#location-dialog').close();
  await renderToday();
}

async function reverseGeocodeName(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    const j = await r.json();
    return j.city || j.locality || 'My location';
  } catch { return 'My location'; }
}

$('#use-gps').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('Location not available'); return; }
  $('#use-gps').textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lon } = pos.coords;
    const name = await reverseGeocodeName(lat, lon);
    $('#use-gps').textContent = '📍 Use my current location';
    setLocation({ lat: +lat.toFixed(3), lon: +lon.toFixed(3), name });
  }, () => {
    $('#use-gps').textContent = '📍 Use my current location';
    toast('Location denied — search for your city instead');
  }, { timeout: 12000 });
});

let searchTimer = null;
$('#city-search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $('#city-results').innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en`);
      const j = await r.json();
      const box = $('#city-results');
      box.innerHTML = '';
      (j.results || []).forEach(c => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'city-option';
        b.textContent = [c.name, c.admin1, c.country_code].filter(Boolean).join(', ');
        b.addEventListener('click', () => setLocation({ lat: c.latitude, lon: c.longitude, name: c.name }));
        box.appendChild(b);
      });
      if (!(j.results || []).length) box.innerHTML = '<p class="subtitle center">No matches</p>';
    } catch { /* network hiccup; ignore */ }
  }, 350);
});

/* ================= settings ================= */

function renderUnitChips() {
  $$('.unit-chip').forEach(c => c.classList.toggle('active', c.dataset.unit === settings.unit));
}
$('#settings-btn').addEventListener('click', () => { renderUnitChips(); $('#settings-dialog').showModal(); });
$('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
$$('.unit-chip').forEach(c => c.addEventListener('click', async () => {
  settings.unit = c.dataset.unit;
  saveSettings();
  renderUnitChips();
  await renderToday();
}));

/* ---------- backup ---------- */

const blobToDataURL = blob => new Promise(res => {
  const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob);
});
async function dataURLToBlob(durl) { return (await fetch(durl)).blob(); }

$('#export-btn').addEventListener('click', async () => {
  const out = [];
  for (const i of items) {
    out.push({ ...i, photo: i.photo ? await blobToDataURL(i.photo) : null });
  }
  const payload = { version: 2, exportedAt: new Date().toISOString(), items: out, outfits };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `my-closet-backup-${localDateKey()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Backup downloaded');
});

$('#import-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    let n = 0;
    for (const raw of j.items || []) {
      const item = { ...raw, photo: raw.photo ? await dataURLToBlob(raw.photo) : null };
      if (LEGACY_CATEGORY[item.category]) item.category = LEGACY_CATEGORY[item.category];
      await dbPut('items', item);
      dropPhotoURL(item.id);
      const idx = items.findIndex(i => i.id === item.id);
      if (idx >= 0) items[idx] = item; else items.push(item);
      n++;
    }
    for (const o of j.outfits || []) {
      await dbPut('outfits', o);
      const idx = outfits.findIndex(x => x.id === o.id);
      if (idx >= 0) outfits[idx] = o; else outfits.push(o);
    }
    toast(`Imported ${n} item${n === 1 ? '' : 's'}`);
    renderCloset();
  } catch {
    toast("Couldn't read that backup file");
  }
  e.target.value = '';
});

/* ================= init ================= */

async function init() {
  items = await dbAll('items');
  outfits = await dbAll('outfits');
  // migrate categories from the v1 scheme (bottom/outerwear)
  for (const i of items) {
    if (LEGACY_CATEGORY[i.category]) {
      i.category = LEGACY_CATEGORY[i.category];
      await dbPut('items', i);
    }
  }
  renderCategoryChips(null);
  showView('today');
  if (navigator.storage?.persist) navigator.storage.persist();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // first run: offer GPS silently if no location yet
  if (!settings.location && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      const name = await reverseGeocodeName(lat, lon);
      settings.location = { lat: +lat.toFixed(3), lon: +lon.toFixed(3), name };
      saveSettings();
      renderToday();
    }, () => { /* user will set manually */ }, { timeout: 10000 });
  }
}
init();
