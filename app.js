/* My Closet — personal closet tracker + weather-based outfit recommendations */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

const CATEGORIES = [
  { key: 'top',       label: 'Top',       emoji: '👕' },
  { key: 'bottom',    label: 'Bottom',    emoji: '👖' },
  { key: 'dress',     label: 'Dress',     emoji: '👗' },
  { key: 'outerwear', label: 'Outerwear', emoji: '🧥' },
  { key: 'shoes',     label: 'Shoes',     emoji: '👟' },
  { key: 'accessory', label: 'Accessory', emoji: '🧣' },
];
const WARMTH_LABELS = ['Very light', 'Light', 'Medium', 'Warm', 'Very warm'];
const catOf = key => CATEGORIES.find(c => c.key === key);

/* ================= storage ================= */

const DB_NAME = 'my-closet', STORE = 'items';
let _db = null;
function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
async function dbPut(item) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function dbDelete(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function dbAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const rq = db.transaction(STORE).objectStore(STORE).getAll();
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
let closetFilter = 'all';
let currentOutfit = null;     // array of items
let editingId = null;
let pendingPhoto = undefined;  // Blob | null (remove) | undefined (unchanged)
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

/* ================= tabs ================= */

function showView(name) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $(`#view-${name}`).classList.remove('hidden');
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  window.scrollTo(0, 0);
  if (name === 'closet') renderCloset();
  if (name === 'today') renderToday();
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
  if (wet && (item.category === 'shoes' || item.category === 'outerwear')) {
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

  const tops = by('top'), bottoms = by('bottom');
  // dresses are optional, so only consider ones that actually suit today's temperature
  const dresses = by('dress').filter(d => Math.abs(d.warmth - target) <= 1);
  const useDress = dresses.length && (!(tops.length && bottoms.length) || Math.random() < 0.33);
  if (useDress) {
    outfit.push(pickBest(dresses, target, wet));
  } else if (tops.length || bottoms.length) {
    const top = pickBest(tops, target, wet);
    const bottom = pickBest(bottoms, target, wet);
    if (top) outfit.push(top); else missing.push('top');
    if (bottom) outfit.push(bottom); else missing.push('bottom');
  } else {
    missing.push('top', 'bottom');
  }

  const needsOuter = planT < 62 || (wet && planT < 75);
  if (needsOuter) {
    const outer = pickBest(by('outerwear'), Math.max(target, 3), wet);
    if (outer) outfit.push(outer); else missing.push('outerwear');
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
    const names = currentOutfit.missing.map(m => catOf(m).label.toLowerCase()).join(', ');
    bits.push(`👀 Your closet has no good match for: ${names}`);
  }
  return bits.join(' · ');
}

function renderOutfit() {
  const grid = $('#outfit-grid');
  const note = $('#outfit-note');
  const wearBtn = $('#wearing-btn');
  const empty = $('#today-empty');
  const hasItems = items.length > 0;

  $('#shuffle-btn').classList.toggle('hidden', !hasItems || !weather);
  empty.classList.toggle('hidden', hasItems);
  grid.innerHTML = '';
  note.classList.add('hidden');
  wearBtn.classList.add('hidden');
  if (!hasItems || !weather) return;

  buildOutfit();
  if (!currentOutfit) return;

  for (const item of currentOutfit.pieces) {
    const url = photoURL(item);
    const card = document.createElement('button');
    card.className = 'outfit-card';
    card.type = 'button';
    card.innerHTML = `
      ${url ? `<img src="${url}" alt="">` : `<div class="ph">${catOf(item.category).emoji}</div>`}
      <div class="cap"><b>${esc(item.name)}</b><span>${catOf(item.category).label}</span></div>`;
    card.addEventListener('click', () => openDetail(item.id));
    grid.appendChild(card);
  }
  const n = outfitNote();
  if (n) { note.textContent = n; note.classList.remove('hidden'); }
  if (currentOutfit.pieces.length) wearBtn.classList.remove('hidden');
}

$('#shuffle-btn').addEventListener('click', renderOutfit);
$('#wearing-btn').addEventListener('click', async () => {
  if (!currentOutfit) return;
  for (const p of currentOutfit.pieces) { p.lastWorn = Date.now(); await dbPut(p); }
  toast('Looking good! Logged as worn 👌');
});

async function renderToday() {
  const h = new Date().getHours();
  $('#today-greeting').textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  await renderWeather();
  renderOutfit();
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
    const url = photoURL(item);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'closet-cell';
    cell.innerHTML = `
      ${url ? `<img src="${url}" alt="">` : `<div class="ph">${catOf(item.category).emoji}</div>`}
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
  await dbPut(item);
  $('#d-fav').classList.toggle('fav-on', item.favorite);
  renderCloset();
});
$('#d-edit').addEventListener('click', () => {
  $('#item-dialog').close();
  openEdit(detailId);
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
  $('#add-title').textContent = 'Add item';
  $('#item-form').reset();
  $('#f-warmth').value = 3;
  $('#warmth-label').textContent = WARMTH_LABELS[2];
  renderCategoryChips(null);
  $('#photo-preview').classList.add('hidden');
  $('#photo-preview').removeAttribute('src');
  $('#photo-hint').classList.remove('hidden');
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

function resizePhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 900;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('encode failed')), 'image/jpeg', 0.82);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('bad image'));
    img.src = URL.createObjectURL(file);
  });
}

$('#photo-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    pendingPhoto = await resizePhoto(file);
    const url = URL.createObjectURL(pendingPhoto);
    $('#photo-preview').src = url;
    $('#photo-preview').classList.remove('hidden');
    $('#photo-hint').classList.add('hidden');
  } catch {
    toast("Couldn't read that photo");
  }
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
    createdAt: existing ? existing.createdAt : Date.now(),
    lastWorn: existing ? existing.lastWorn : null,
  };
  await dbPut(item);
  dropPhotoURL(item.id);
  if (existing) items[items.indexOf(existing)] = item; else items.push(item);
  toast(existing ? 'Saved ✓' : `Added to closet ✓`);
  editingId = null;
  resetForm();
  showView('closet');
});

$('#delete-btn').addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('Delete this item from your closet?')) return;
  await dbDelete(editingId);
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

$('#use-gps').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('Location not available'); return; }
  $('#use-gps').textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lon } = pos.coords;
    let name = 'My location';
    try {
      const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
      const j = await r.json();
      name = j.city || j.locality || name;
    } catch { /* keep generic name */ }
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
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items: out })], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `my-closet-backup-${new Date().toISOString().slice(0, 10)}.json`;
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
      await dbPut(item);
      dropPhotoURL(item.id);
      const idx = items.findIndex(i => i.id === item.id);
      if (idx >= 0) items[idx] = item; else items.push(item);
      n++;
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
  items = await dbAll();
  renderCategoryChips(null);
  showView('today');
  if (navigator.storage?.persist) navigator.storage.persist();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  // first run: offer GPS silently if no location yet
  if (!settings.location && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      let name = 'My location';
      try {
        const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
        const j = await r.json();
        name = j.city || j.locality || name;
      } catch { /* keep generic name */ }
      settings.location = { lat: +lat.toFixed(3), lon: +lon.toFixed(3), name };
      saveSettings();
      renderToday();
    }, () => { /* user will set manually */ }, { timeout: 10000 });
  }
}
init();
