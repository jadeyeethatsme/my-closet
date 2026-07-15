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
  sigCache.delete(id);
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
  if (name === 'history') renderCalendar();
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
  $('#log-btn').classList.toggle('hidden', !hasItems);
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

/* ================= outfit calendar ================= */

let calMonth = (() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); })();
const outfitFor = key => outfits.find(o => o.dateKey === key);

function renderCalendar() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const now = new Date();
  $('#cal-title').textContent = calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('#cal-next').disabled = y === now.getFullYear() && m === now.getMonth();

  const grid = $('#cal-grid');
  grid.innerHTML = '';
  const firstDow = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const todayKey = localDateKey();

  for (let i = 0; i < firstDow; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-cell blank';
    grid.appendChild(blank);
  }
  for (let d = 1; d <= days; d++) {
    const key = localDateKey(new Date(y, m, d));
    const o = outfitFor(key);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-cell'
      + (key === todayKey ? ' today' : '')
      + (key > todayKey ? ' future' : '')
      + (o ? '' : ' empty-day');
    let thumb = '';
    if (o) {
      const first = o.itemIds.map(id => items.find(i => i.id === id)).filter(Boolean)[0];
      thumb = first ? itemCardHTML(first) : '🧺';
    }
    cell.innerHTML = `<span class="cal-num">${d}</span><span class="cal-thumb">${thumb}</span>`;
    cell.addEventListener('click', () => openLogDialog(key));
    grid.appendChild(cell);
  }

  $('#history-count').textContent = outfits.length
    ? `${outfits.length} outfit${outfits.length === 1 ? '' : 's'} logged`
    : 'Tap a day to log what you wore';
}
$('#cal-prev').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderCalendar(); });
$('#cal-next').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderCalendar(); });

/* ---------- log-outfit dialog ---------- */

let logDateKey = null;
let logSelection = new Set();

function openLogDialog(dateKey, preset = null) {
  logDateKey = dateKey;
  const existing = outfitFor(dateKey);
  logSelection = new Set(preset || (existing?.itemIds || []).filter(id => items.some(i => i.id === id)));
  $('#log-title').textContent = `${existing ? 'Outfit' : 'Log outfit'} · ${dateLabel(dateKey)}`;
  const w = existing?.weather ? `${wmoInfo(existing.weather.code).emoji} ${showT(existing.weather.tempF)} that day · ` : '';
  $('#log-sub').textContent = items.length
    ? w + 'Tap the pieces you wore.'
    : 'Your closet is empty — add some items first.';
  $('#log-delete').classList.toggle('hidden', !existing);

  const grid = $('#log-grid');
  grid.innerHTML = '';
  const order = k => CATEGORIES.findIndex(c => c.key === k);
  const sorted = [...items].sort((a, b) => order(a.category) - order(b.category) || b.favorite - a.favorite);
  for (const item of sorted) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'log-cell' + (logSelection.has(item.id) ? ' sel' : '');
    cell.title = item.name;
    cell.innerHTML = item.photo ? itemCardHTML(item) : catOf(item.category).emoji;
    cell.addEventListener('click', () => {
      if (logSelection.has(item.id)) logSelection.delete(item.id); else logSelection.add(item.id);
      cell.classList.toggle('sel', logSelection.has(item.id));
    });
    grid.appendChild(cell);
  }
  $('#log-dialog').showModal();
}

const calendarVisible = () => !$('#view-history').classList.contains('hidden');

$('#log-btn').addEventListener('click', () => openLogDialog(localDateKey()));
$('#log-cancel').addEventListener('click', () => $('#log-dialog').close());

$('#log-save').addEventListener('click', async () => {
  if (!logSelection.size) { toast('Tap at least one piece'); return; }
  const existing = outfitFor(logDateKey);
  const record = {
    id: existing ? existing.id : uid(),
    dateKey: logDateKey,
    at: Date.now(),
    itemIds: [...logSelection],
    weather: existing?.weather
      || (logDateKey === localDateKey() && weather ? { tempF: weather.tempF, code: weather.code } : null),
  };
  await dbPut('outfits', record);
  if (existing) outfits[outfits.indexOf(existing)] = record; else outfits.push(record);

  const [y, m, d] = logDateKey.split('-').map(Number);
  const wornAt = new Date(y, m - 1, d, 12).getTime();
  for (const id of logSelection) {
    const item = items.find(i => i.id === id);
    if (item && (!item.lastWorn || wornAt > item.lastWorn)) {
      item.lastWorn = wornAt;
      await dbPut('items', item);
    }
  }
  $('#log-dialog').close();
  if (calendarVisible()) renderCalendar();
  updateWearBtn();
  toast(existing ? 'Outfit updated ✓' : 'Added to your calendar ✓');
});

$('#log-delete').addEventListener('click', async () => {
  const existing = outfitFor(logDateKey);
  if (!existing) return;
  if (!confirm(`Delete the outfit logged ${dateLabel(logDateKey).toLowerCase()}?`)) return;
  await dbDelete('outfits', existing.id);
  outfits = outfits.filter(o => o.id !== existing.id);
  $('#log-dialog').close();
  if (calendarVisible()) renderCalendar();
  updateWearBtn();
  toast('Entry deleted');
});

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

function fileToCanvas(file, MAX = 900) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
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

/* ================= outfit photo import (on-device AI segmentation) ================= */

const SEG_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
const SEG_MODEL = 'Xenova/segformer_b2_clothes';
const SEG_GROUPS = [
  { labels: ['Upper-clothes'],           category: 'top',       name: 'Top' },
  { labels: ['Pants'],                   category: 'pants',     name: 'Pants' },
  { labels: ['Skirt'],                   category: 'skirt',     name: 'Skirt' },
  { labels: ['Dress'],                   category: 'dress',     name: 'Dress' },
  { labels: ['Left-shoe', 'Right-shoe'], category: 'shoes',     name: 'Shoes' },
  { labels: ['Hat'],                     category: 'accessory', name: 'Hat' },
  { labels: ['Scarf'],                   category: 'accessory', name: 'Scarf' },
  { labels: ['Belt'],                    category: 'accessory', name: 'Belt' },
  { labels: ['Bag'],                     category: 'accessory', name: 'Bag' },
];

let segLoader = null;
function loadSegmenter(onStatus) {
  if (!segLoader) {
    segLoader = (async () => {
      onStatus('Loading the AI model…');
      const t = await import(SEG_CDN);
      const opts = {
        dtype: 'q8',
        progress_callback: p => {
          if (p.status === 'progress' && p.file && p.file.endsWith('.onnx')) {
            onStatus(`Downloading the AI model… ${Math.round(p.progress || 0)}% (one time only)`);
          }
        },
      };
      // wasm on purpose: the q8 weights produce garbage output on webgpu
      return await t.pipeline('image-segmentation', SEG_MODEL, { ...opts, device: 'wasm' });
    })();
    segLoader.catch(() => { segLoader = null; });  // allow retry after a failed load
  }
  return segLoader;
}

function cropCanvas(canvas, minX, minY, maxX, maxY) {
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.05) + 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(canvas.width - 1, maxX + pad); maxY = Math.min(canvas.height - 1, maxY + pad);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
  return out;
}

/* apply one or more segmentation masks to the photo and crop to the garment */
function maskCutout(src, masks) {
  const w = src.width, h = src.height;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const imgd = ctx.getImageData(0, 0, w, h);
  const d = imgd.data;
  let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = false;
      for (const m of masks) {
        const mx = (x * m.width / w) | 0, my = (y * m.height / h) | 0;
        if (m.data[my * m.width + mx] > 127) { on = true; break; }
      }
      const p = (y * w + x) * 4;
      if (!on) { d[p + 3] = 0; continue; }
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (count < w * h * 0.002) return null;  // sliver — not a real garment
  ctx.putImageData(imgd, 0, 0);
  return cropCanvas(c, minX, minY, maxX, maxY);
}

async function segmentOutfit(file, onStatus) {
  const canvas = await fileToCanvas(file, 1000);
  const seg = await loadSegmenter(onStatus);
  onStatus('Analyzing your outfit…');
  await new Promise(r => setTimeout(r, 30));  // let the status paint before inference blocks
  const segments = await seg(canvas.toDataURL('image/jpeg', 0.9));
  const found = [];
  for (const g of SEG_GROUPS) {
    const masks = segments.filter(s => g.labels.includes(s.label)).map(s => s.mask);
    if (!masks.length) continue;
    const cut = maskCutout(canvas, masks);
    if (cut) found.push({ ...g, canvas: cut });
  }
  return found;
}

/* ---------- visual matching: compare a detected piece to closet items ---------- */

const sigCache = new Map();  // itemId -> signature | null
const MATCH_THRESHOLD = 0.2; // below this distance a match is preselected
const MATCH_GROUPS = {       // which closet categories a detected piece may match
  top: ['top', 'jacket'],
  pants: ['pants', 'shorts'],
  skirt: ['skirt'],
  dress: ['dress'],
  shoes: ['shoes'],
  accessory: ['accessory'],
};

/* coarse color signature: 4x4 grid of mean RGB + 27-bin histogram over visible pixels */
function canvasSignature(source, hasAlpha) {
  const S = 32, G = 4;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  ctx.drawImage(source, 0, 0, S, S);
  const d = ctx.getImageData(0, 0, S, S).data;
  const grid = new Float32Array(G * G * 3);
  const gcount = new Float32Array(G * G);
  const hist = new Float32Array(27);
  let total = 0;
  // full photos (no alpha): sample the center region to dodge the background
  const lo = hasAlpha ? 0 : 5, hi = hasAlpha ? S : S - 5;
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      const i = (y * S + x) * 4;
      if (d[i + 3] < 128) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const gi = ((y * G / S) | 0) * G + ((x * G / S) | 0);
      grid[gi * 3] += r; grid[gi * 3 + 1] += g; grid[gi * 3 + 2] += b;
      gcount[gi]++;
      hist[((r / 86) | 0) * 9 + ((g / 86) | 0) * 3 + ((b / 86) | 0)]++;
      total++;
    }
  }
  if (total < 20) return null;
  for (let i = 0; i < G * G; i++) {
    const n = gcount[i] || 1;
    grid[i * 3] /= n * 255; grid[i * 3 + 1] /= n * 255; grid[i * 3 + 2] /= n * 255;
  }
  for (let i = 0; i < 27; i++) hist[i] /= total;
  return { grid, hist };
}

async function itemSignature(item) {
  if (sigCache.has(item.id)) return sigCache.get(item.id);
  let sig = null;
  if (item.photo) {
    try {
      const bmp = await createImageBitmap(item.photo);
      sig = canvasSignature(bmp, !!item.cutout);
      bmp.close?.();
    } catch { /* unreadable photo — treat as unmatchable */ }
  }
  sigCache.set(item.id, sig);
  return sig;
}

function sigDist(a, b) {
  if (!a || !b) return Infinity;
  let g = 0;
  for (let i = 0; i < a.grid.length; i++) { const t = a.grid[i] - b.grid[i]; g += t * t; }
  let h = 0;
  for (let i = 0; i < a.hist.length; i++) { const t = a.hist[i] - b.hist[i]; h += t * t; }
  return 0.6 * Math.sqrt(g / a.grid.length) + 0.4 * Math.sqrt(h);
}

/* closet candidates for a detected piece, best match first (photoless items last) */
async function matchCandidates(piece) {
  const groups = MATCH_GROUPS[piece.category] || [piece.category];
  const pieceSig = canvasSignature(piece.canvas, true);
  const cands = [];
  for (const item of items.filter(i => groups.includes(i.category))) {
    cands.push({ item, dist: sigDist(pieceSig, await itemSignature(item)) });
  }
  return cands.sort((a, b) => a.dist - b.dist).slice(0, 8);
}

/* ---------- import / log-from-photo dialog ---------- */

let oiRows = [];          // [{piece, row}]
let oiMode = 'closet';    // 'closet' = add items to closet, 'log' = log the day's outfit
$('#outfit-import-btn').addEventListener('click', () => { oiMode = 'closet'; $('#outfit-photo-input').click(); });
$('#log-photo-btn').addEventListener('click', () => {
  oiMode = 'log';
  $('#log-dialog').close();
  $('#outfit-photo-input').click();
});
$('#oi-cancel').addEventListener('click', () => $('#outfit-import-dialog').close());

$('#outfit-photo-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  const status = $('#oi-status'), results = $('#oi-results');
  results.innerHTML = '';
  oiRows = [];
  $('#oi-title').textContent = oiMode === 'log' ? `Outfit · ${dateLabel(logDateKey || localDateKey())}` : 'Outfit import';
  $('#oi-add').textContent = oiMode === 'log' ? 'Continue' : 'Add to closet';
  $('#oi-add').classList.add('hidden');
  status.textContent = 'Reading photo…';
  $('#outfit-import-dialog').showModal();
  try {
    const found = await segmentOutfit(file, t => { status.textContent = t; });
    if (!found.length) {
      status.textContent = "I couldn't find any clothing in that photo. Try a full-body photo in good light.";
      return;
    }
    status.textContent = oiMode === 'log'
      ? `Found ${found.length} piece${found.length === 1 ? '' : 's'} — matched to your closet where I could.`
      : `Found ${found.length} piece${found.length === 1 ? '' : 's'} — tweak and uncheck as needed.`;
    for (const piece of found) {
      const matches = oiMode === 'log' ? await matchCandidates(piece) : [];
      const matchHTML = oiMode === 'log' ? `
        <select class="oi-select oi-match">
          ${matches.map(m => `<option value="${m.item.id}">✓ ${esc(m.item.name)}</option>`).join('')}
          <option value="__new__">➕ Add as new item</option>
        </select>` : '';
      const row = document.createElement('div');
      row.className = 'oi-row';
      row.innerHTML = `
        <div class="oi-thumb"></div>
        <div class="oi-main">
          ${matchHTML}
          <div class="oi-newfields">
            <input type="text" class="oi-name" value="${esc(piece.name)}" autocomplete="off">
            <div class="oi-selects">
              <select class="oi-select oi-cat">${CATEGORIES.map(c =>
                `<option value="${c.key}"${c.key === piece.category ? ' selected' : ''}>${c.emoji} ${c.label}</option>`).join('')}</select>
              <select class="oi-select oi-warmth">${WARMTH_LABELS.map((l, i) =>
                `<option value="${i + 1}"${i === 2 ? ' selected' : ''}>${l}</option>`).join('')}</select>
            </div>
          </div>
        </div>
        <input type="checkbox" class="oi-check" checked>`;
      row.querySelector('.oi-thumb').appendChild(piece.canvas);
      if (oiMode === 'log') {
        const sel = row.querySelector('.oi-match');
        sel.value = matches.length && matches[0].dist < MATCH_THRESHOLD ? matches[0].item.id : '__new__';
        const sync = () => row.querySelector('.oi-newfields').classList.toggle('hidden', sel.value !== '__new__');
        sel.addEventListener('change', sync);
        sync();
      }
      results.appendChild(row);
      oiRows.push({ piece, row });
    }
    $('#oi-add').classList.remove('hidden');
  } catch (err) {
    status.textContent = "Couldn't load the AI model — check your connection and try again.";
  }
});

$('#oi-add').addEventListener('click', async () => {
  const btn = $('#oi-add');
  if (btn.disabled) return;
  btn.disabled = true;
  const btnLabel = btn.textContent;
  btn.textContent = 'Working…';

  async function createItemFromRow(piece, row) {
    const blob = await new Promise(r => piece.canvas.toBlob(r, 'image/png'));
    const item = {
      id: uid(),
      name: row.querySelector('.oi-name').value.trim() || piece.name,
      category: row.querySelector('.oi-cat').value,
      warmth: +row.querySelector('.oi-warmth').value,
      waterproof: false,
      favorite: false,
      notes: '',
      photo: blob,
      cutout: true,
      createdAt: Date.now(),
      lastWorn: null,
    };
    await dbPut('items', item);
    items.push(item);
    return item;
  }

  if (oiMode === 'log') {
    const ids = new Set(logSelection);
    let added = 0;
    for (const { piece, row } of oiRows) {
      if (!row.querySelector('.oi-check').checked) continue;
      const choice = row.querySelector('.oi-match').value;
      if (choice === '__new__') { ids.add((await createItemFromRow(piece, row)).id); added++; }
      else ids.add(choice);
    }
    btn.disabled = false;
    btn.textContent = btnLabel;
    $('#outfit-import-dialog').close();
    if (added) toast(`Added ${added} new item${added === 1 ? '' : 's'} to your closet`);
    openLogDialog(logDateKey || localDateKey(), [...ids]);
    return;
  }

  let n = 0;
  for (const { piece, row } of oiRows) {
    if (!row.querySelector('.oi-check').checked) continue;
    await createItemFromRow(piece, row);
    n++;
  }
  btn.disabled = false;
  btn.textContent = btnLabel;
  $('#outfit-import-dialog').close();
  if (n) { toast(`Added ${n} item${n === 1 ? '' : 's'} to your closet ✓`); showView('closet'); }
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
