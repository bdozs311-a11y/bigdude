const $ = (selector) => document.querySelector(selector);
const DB_NAME = 'my-sounds-db';
const DB_VERSION = 5;
const EMOJIS = ['🧟', '🧟‍♀️', '🦇', '🕸️', '🖤', '🪦', '🌙', '⚡', '👻', '🕯️', '💀', '🦴'];
const SUPPORTED_FILES = /\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|webm)$/i;
const audio = $('#audio');
let db;
let tracks = [], playlists = [], playlistFolders = [];
let currentId = null, currentUrl = null, loadToken = 0, playbackSerial = 0, countedSerial = -1;
let endedTransitionInFlight = false, pendingAudio = null, preparedNext = null, preloadToken = 0;
let pausedResumeSnapshot = null, mediaResumeAttempt = 0;
let playbackEpoch = 0, lastHandledEndedEpoch = -1, foregroundRecoveryToken = 0;
const retiredAudioUrls = new Set();
let currentView = 'songs', collectionFilter = null, activePlaylistId = null;
let queue = [], queueIndex = -1, shuffleOn = false, shuffleBag = [], shuffleHistory = [];
let repeatMode = 'off';
let artTarget = null, lyricsTarget = null, visualTarget = null, activeLyricsId = null, lastLyricsIndex = -1, visualLoadToken = 0;
let lyricsSyncDraft = null, lyricsManualScrollUntil = 0, lyricsAutoScrollUntil = 0;
const artworkUrls = new Map();
const visualUrls = new Map();
let panelTimer = null, lastVisualTrackId = null, visualTransitionToken = 0, activePaletteSignature = '';
let sleepTimerHandle = null, sleepTimerEndsAt = 0, playlistDragTrackId = null;
let restoredPosition = 0, lastStateSaveAt = 0;
let pendingBackup = null;
const BACKUP_FORMAT = 'zombie-backup';
const FULL_BACKUP_LIMIT = 40 * 1024 * 1024;
const preferences = { layout: 'comfortable', appearance: 'soft', visualMode: 'artwork', playbackRate: 1, sort: 'recent' };

const randomEmoji = () => EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
const neutralArtist = (value) => {
  const artist = String(value || '').trim();
  return artist && !/^unknown artist$/i.test(artist) ? artist : 'Local audio';
};
const formatTime = (seconds) => !Number.isFinite(seconds) ? '0:00' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const formatRemainingTime = (seconds) => `−${formatTime(Math.max(0, seconds || 0))}`;
const formatLrcTimestamp = (seconds) => { const total = Math.max(0, Math.round((Number(seconds) || 0) * 100)); const minutes = Math.floor(total / 6000); const remainder = total % 6000; return `[${String(minutes).padStart(2, '0')}:${String(Math.floor(remainder / 100)).padStart(2, '0')}.${String(remainder % 100).padStart(2, '0')}]`; };
const formatBytes = (bytes = 0) => bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
const formatTotalDuration = (seconds = 0) => { const minutes = Math.round(seconds / 60); const days = Math.floor(minutes / 1440); const hours = Math.floor((minutes % 1440) / 60); const mins = minutes % 60; return `${days ? `${days} day${days === 1 ? '' : 's'} ` : ''}${hours ? `${hours} hr ` : ''}${mins ? `${mins} min` : '0 min'}`.trim(); };
const escapeHTML = (value = '') => { const element = document.createElement('span'); element.textContent = value; return element.innerHTML; };
const libraryStats = (list = tracks) => `${list.length} ${list.length === 1 ? 'song' : 'songs'} · ${formatTotalDuration(list.reduce((total, track) => total + (Number(track.duration) || 0), 0))}`;
const FALLBACK_PALETTES = [
  { accent: [139, 91, 255], glow: [44, 181, 203] }, { accent: [242, 91, 146], glow: [255, 170, 75] },
  { accent: [90, 153, 255], glow: [60, 214, 184] }, { accent: [188, 100, 255], glow: [255, 104, 157] },
  { accent: [253, 151, 77], glow: [255, 211, 104] }, { accent: [77, 203, 183], glow: [95, 126, 255] },
];
const paletteJobs = new Set();
const clampByte = (value) => Math.max(0, Math.min(255, Math.round(value)));
const isPalette = (value) => Array.isArray(value?.accent) && value.accent.length === 3 && Array.isArray(value?.glow) && value.glow.length === 3;
const fallbackPaletteFor = (track) => FALLBACK_PALETTES[artVariant(track || { title: 'Zombie' }) % FALLBACK_PALETTES.length];
const rgbValue = (color) => color.map(clampByte).join(',');
function applyAmbientPalette(track = tracks.find((entry) => entry.id === currentId)) {
  const palette = isPalette(track?.palette) ? track.palette : fallbackPaletteFor(track);
  const root = document.documentElement;
  const accent = rgbValue(palette.accent), glow = rgbValue(palette.glow), signature = `${accent}|${glow}`;
  const transition = $('#ambientTransition');
  if (activePaletteSignature && activePaletteSignature !== signature && transition) {
    const [previousAccent, previousGlow] = activePaletteSignature.split('|');
    transition.style.setProperty('--zombie-previous-accent-rgb', previousAccent); transition.style.setProperty('--zombie-previous-glow-rgb', previousGlow);
    transition.classList.remove('morphing'); void transition.offsetWidth; transition.classList.add('morphing');
  }
  root.style.setProperty('--zombie-accent-rgb', accent); root.style.setProperty('--zombie-glow-rgb', glow); activePaletteSignature = signature;
  root.dataset.zombiePalette = track?.id || 'default';
  if (track?.artworkId && !isPalette(track.palette)) void deriveArtworkPalette(track);
}
function liftPaletteColor(color, floor = 58) { return color.map((value) => clampByte(Math.max(floor, (Number(value) * .84) + 31))); }
async function deriveArtworkPalette(track) {
  if (!track?.id || !track.artworkId || paletteJobs.has(track.id) || isPalette(track.palette)) return;
  paletteJobs.add(track.id);
  let imageUrl = '';
  try {
    const record = await getRecord('artworkBlobs', track.artworkId); if (!record?.blob?.type?.startsWith('image/')) return;
    imageUrl = URL.createObjectURL(record.blob);
    const image = new Image(); image.decoding = 'async';
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = imageUrl; });
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 28;
    const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) return;
    context.drawImage(image, 0, 0, 28, 28);
    const pixels = context.getImageData(0, 0, 28, 28).data;
    let count = 0, red = 0, green = 0, blue = 0, best = null, bestScore = -1;
    for (let index = 0; index < pixels.length; index += 16) {
      const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2], alpha = pixels[index + 3];
      const light = (r + g + b) / 765; if (alpha < 120 || light < .075 || light > .94) continue;
      red += r; green += g; blue += b; count += 1;
      const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      const score = saturation * (1 - Math.abs(light - .52)); if (score > bestScore) { bestScore = score; best = [r, g, b]; }
    }
    if (!count) return;
    const average = [red / count, green / count, blue / count];
    const palette = { accent: liftPaletteColor(best || average, 70), glow: liftPaletteColor(average, 48) };
    const stored = tracks.find((entry) => entry.id === track.id); if (!stored) return;
    stored.palette = palette; await saveRecord('tracks', stored);
    if (stored.id === currentId || stored.id === activeLyricsId) applyAmbientPalette(stored);
  } catch { /* Artwork colours are optional; the stable local fallback palette remains in use. */ }
  finally { if (imageUrl) URL.revokeObjectURL(imageUrl); paletteJobs.delete(track.id); }
}
function setMarqueeText(selector, value) {
  const element = $(selector); if (!element) return;
  const copy = document.createElement('span'); copy.textContent = String(value || ''); element.replaceChildren(copy); element.classList.remove('marquee-active'); element.style.removeProperty('--marquee-distance');
  requestAnimationFrame(() => {
    const distance = Math.max(0, copy.scrollWidth - element.clientWidth);
    if (distance > 4) { element.style.setProperty('--marquee-distance', `-${distance}px`); element.classList.add('marquee-active'); }
  });
}
function buildDecorativeWaveform() {
  const muted = $('#waveformMuted'), played = $('#waveformPlayed'); if (!muted || !played || muted.childElementCount) return;
  const bars = Array.from({ length: 58 }, (_, index) => {
    const height = 28 + ((index * 37 + index * index * 9 + 17) % 66);
    return `<i style="--wave-height:${height}%"></i>`;
  }).join('');
  muted.innerHTML = bars; played.innerHTML = bars;
}
function setWaveformProgress(percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  $('#waveformShell')?.style.setProperty('--seek-progress', `${value}%`);
}
function syncAmbientMotionState() {
  const playing = !audio.paused;
  document.documentElement.dataset.zombiePlayback = playing ? 'playing' : 'paused'; document.documentElement.dataset.zombieVisibility = document.visibilityState || 'visible';
  ['#nowPlayingScreen', '#miniPlayer'].forEach((selector) => { const panel = $(selector); panel?.classList.toggle('is-playing', playing); panel?.classList.toggle('is-paused', !playing); });
}
function installMobileScaleGuard() {
  const root = document.documentElement;
  const updateViewportMetrics = () => {
    const visual = window.visualViewport;
    const height = Math.max(1, Number(visual?.height) || window.innerHeight || 1);
    root.style.setProperty('--zombie-vh', `${height / 100}px`);
    const scale = Number(visual?.scale);
    root.dataset.zombieViewportScale = Number.isFinite(scale) && Math.abs(scale - 1) > .015 ? 'scaled' : 'normal';
  };
  updateViewportMetrics();
  window.visualViewport?.addEventListener('resize', updateViewportMetrics, { passive: true });
  window.visualViewport?.addEventListener('scroll', updateViewportMetrics, { passive: true });
  window.addEventListener('orientationchange', updateViewportMetrics, { passive: true });
  window.addEventListener('pageshow', updateViewportMetrics, { passive: true });
  // Page-level pinch/double-tap zoom makes a Home Screen PWA look like a tiny desktop site.
  // Single-finger scrolling, range inputs, queues, and lyric scrolling are deliberately left alone.
  document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', (event) => event.preventDefault(), { passive: false });
  document.addEventListener('dblclick', (event) => {
    if (!event.target.closest('input,textarea,select,[contenteditable="true"]')) event.preventDefault();
  }, { capture: true, passive: false });
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message; element.classList.add('visible');
  clearTimeout(window.zombieToastTimer);
  window.zombieToastTimer = setTimeout(() => element.classList.remove('visible'), 3000);
}
function showProgress(title, detail = 'Please keep Zombie open') {
  $('#progressTitle').textContent = title; $('#progressDetail').textContent = detail;
  $('#importProgress').classList.remove('hidden');
}
function hideProgress() { $('#importProgress').classList.add('hidden'); }

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const transaction = request.transaction;
      const trackStore = database.objectStoreNames.contains('tracks') ? transaction.objectStore('tracks') : database.createObjectStore('tracks', { keyPath: 'id' });
      const blobStore = database.objectStoreNames.contains('audioBlobs') ? transaction.objectStore('audioBlobs') : database.createObjectStore('audioBlobs', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('artworkBlobs')) database.createObjectStore('artworkBlobs', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('playlists')) database.createObjectStore('playlists', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('settings')) database.createObjectStore('settings', { keyPath: 'key' });
      // Earlier Zombie releases stored Blobs inside the track record. Move them once so opening a large library only reads metadata.
      trackStore.openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        const track = cursor.value;
        if (track.blob) {
          blobStore.put({ id: track.id, blob: track.blob });
          delete track.blob; track.blobStored = true;
          cursor.update(track);
        }
        cursor.continue();
      };
    };
    request.onsuccess = () => { db = request.result; db.onversionchange = () => db.close(); resolve(); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Zombie storage is open in another tab. Close other Zombie tabs and try again.'));
  });
}
function store(name, mode = 'readonly') { return db.transaction(name, mode).objectStore(name); }
function readAll(name) {
  return new Promise((resolve, reject) => { const request = store(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function getRecord(name, key) {
  return new Promise((resolve, reject) => { const request = store(name).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function saveRecord(name, record) {
  return new Promise((resolve, reject) => { const request = store(name, 'readwrite').put(record); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
}
function savePlayerState(force = false) {
  if (!db) return;
  const now = Date.now(); if (!force && now - lastStateSaveAt < 3500) return; lastStateSaveAt = now;
  const state = { key: 'playerState', currentId, queue, queueIndex, shuffleOn, shuffleBag, shuffleHistory, repeatMode, volume: audio.volume, position: Number.isFinite(audio.currentTime) ? audio.currentTime : restoredPosition };
  saveRecord('settings', state).catch(() => {});
}
async function restorePlayerState() {
  const state = await getRecord('settings', 'playerState').catch(() => null);
  if (!state) return;
  queue = Array.isArray(state.queue) ? state.queue.filter((id) => tracks.some((track) => track.id === id)) : [];
  currentId = tracks.some((track) => track.id === state.currentId) ? state.currentId : null;
  const savedIndex = Number.isInteger(state.queueIndex) ? state.queueIndex : -1;
  queueIndex = queue[savedIndex] === currentId ? savedIndex : Math.max(0, queue.indexOf(currentId));
  shuffleOn = Boolean(state.shuffleOn); repeatMode = ['off', 'all', 'one'].includes(state.repeatMode) ? state.repeatMode : 'off';
  shuffleBag = Array.isArray(state.shuffleBag) ? state.shuffleBag.filter((id) => queue.includes(id)) : [];
  shuffleHistory = Array.isArray(state.shuffleHistory) ? state.shuffleHistory.filter((id) => queue.includes(id)) : [];
  reconcileShuffleState('restore');
  restoredPosition = Number.isFinite(state.position) && state.position > 0 ? state.position : 0;
  audio.volume = Number.isFinite(state.volume) ? Math.min(1, Math.max(0, state.volume)) : 1;
}
function applyPreferences() {
  document.documentElement.dataset.zombieAppearance = preferences.appearance;
  audio.playbackRate = preferences.playbackRate;
  if ($('#sortSelect')) $('#sortSelect').value = preferences.sort;
  $('#layoutStatus') && ($('#layoutStatus').textContent = preferences.layout === 'compact' ? 'Compact list' : preferences.layout === 'grid' ? 'Artwork grid' : 'Comfortable list');
  $('#appearanceStatus') && ($('#appearanceStatus').textContent = preferences.appearance === 'pure' ? 'Pure Black' : preferences.appearance === 'ambient' ? 'Artwork Ambient' : 'Soft Black');
  $('#visualStatus') && ($('#visualStatus').textContent = preferences.visualMode === 'animation' ? 'Animation when a song has one' : 'Artwork by default');
  $('#visualButton') && ($('#visualButton').textContent = preferences.visualMode === 'animation' ? '◇ Animation' : '◇ Artwork');
  $('#visualButton')?.classList.toggle('active', preferences.visualMode === 'animation');
}
async function restorePreferences() {
  const record = await getRecord('settings', 'appPreferences').catch(() => null);
  if (record) {
    if (['compact', 'comfortable', 'grid'].includes(record.layout)) preferences.layout = record.layout;
    if (['pure', 'soft', 'ambient'].includes(record.appearance)) preferences.appearance = record.appearance;
    if (['artwork', 'animation'].includes(record.visualMode)) preferences.visualMode = record.visualMode;
    if ([0.8, 1, 1.2, 1.5].includes(record.playbackRate)) preferences.playbackRate = record.playbackRate;
    if (['recent', 'oldest', 'title', 'artist', 'album', 'plays', 'least', 'duration', 'played'].includes(record.sort)) preferences.sort = record.sort;
  }
  applyPreferences();
}
function savePreferences() { saveRecord('settings', { key: 'appPreferences', ...preferences }).catch(() => {}); applyPreferences(); }
function cyclePreference(key, values) { const next = values[(values.indexOf(preferences[key]) + 1) % values.length]; preferences[key] = next; savePreferences(); render(); }
function cleanTrack(track) { const { blob, ...metadata } = track; return metadata; }
function bytesToBase64(bytes) { const chunks = []; for (let offset = 0; offset < bytes.length; offset += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))); return btoa(chunks.join('')); }
function base64ToBlob(value, type = 'application/octet-stream') { const text = atob(value); const bytes = new Uint8Array(text.length); for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index); return new Blob([bytes], { type }); }
async function packBlob(record) { const blob = record.blob; return { id: record.id, type: blob.type || 'application/octet-stream', data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) }; }
function downloadBackup(backup) { const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `zombie-${backup.kind}-backup-${new Date().toISOString().slice(0, 10)}.zombie`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function exportBackup(includeAudio) {
  try {
    showProgress(includeAudio ? 'Building full backup' : 'Building backup', includeAudio ? 'This can take a moment for music files' : 'Saving your music details and artwork');
    const [storedTracks, artwork, settings, blobs] = await Promise.all([readAll('tracks'), readAll('artworkBlobs'), readAll('settings'), includeAudio ? readAll('audioBlobs') : Promise.resolve([])]);
    const rawSize = [...artwork, ...blobs].reduce((total, record) => total + (record.blob?.size || 0), 0);
    if (includeAudio && rawSize > FULL_BACKUP_LIMIT) { toast('Full backups are limited to 40 MB. Export a metadata backup instead.'); return; }
    const backup = { format: BACKUP_FORMAT, version: 1, kind: includeAudio ? 'full' : 'metadata', createdAt: new Date().toISOString(), tracks: storedTracks.map(cleanTrack), playlists, settings, artwork: await Promise.all(artwork.map(packBlob)), audio: includeAudio ? await Promise.all(blobs.map(packBlob)) : [] };
    downloadBackup(backup); toast(includeAudio ? 'Full Zombie backup exported' : 'Zombie backup exported');
  } catch { toast('Zombie could not export that backup'); } finally { hideProgress(); }
}
function validateBackup(value) {
  return Boolean(value && value.format === BACKUP_FORMAT && value.version === 1 && ['metadata', 'full'].includes(value.kind) && Array.isArray(value.tracks) && Array.isArray(value.playlists) && Array.isArray(value.settings) && Array.isArray(value.artwork) && Array.isArray(value.audio));
}
function remapArtworkId(id, idMap) {
  const match = /^(track|visual):(.+)$/.exec(id || '');
  return match ? `${match[1]}:${idMap.get(match[2]) || match[2]}` : id;
}
async function chooseBackupFile(file) {
  if (!file) return;
  try {
    showProgress('Checking backup', file.name);
    if (file.size > 120 * 1024 * 1024) throw new Error('This backup is too large for a safe browser restore.');
    const backup = JSON.parse(await file.text());
    if (!validateBackup(backup)) throw new Error('This is not a valid Zombie backup.');
    pendingBackup = backup; $('#sheetTitle').textContent = 'Restore Zombie backup';
    $('#sheetContent').innerHTML = `<p class="sheet-note">${backup.kind === 'full' ? 'Full backup with audio files.' : 'Metadata backup — restores details to songs already on this iPhone.'} Choose how to restore it.</p><button class="sheet-option" id="mergeBackup">Merge safely</button><button class="sheet-option danger-text" id="replaceBackup">Replace current library</button>`;
    $('#mergeBackup').onclick = () => restoreBackup('merge'); $('#replaceBackup').onclick = () => restoreBackup('replace'); showSheet();
  } catch (error) { toast(error.message || 'That backup could not be read.'); } finally { hideProgress(); }
}
async function clearBackupStores() {
  const transaction = db.transaction(['tracks', 'audioBlobs', 'playlists', 'artworkBlobs', 'settings'], 'readwrite');
  ['tracks', 'audioBlobs', 'playlists', 'artworkBlobs', 'settings'].forEach((name) => transaction.objectStore(name).clear());
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
}
async function restoreBackup(mode) {
  const backup = pendingBackup; if (!backup) return;
  if (mode === 'replace' && !confirm('Replace all Zombie music, playlists, artwork, and settings with this backup? This cannot be undone.')) return;
  try {
    closeSheet(); showProgress('Restoring Zombie', 'Keeping your backup local on this iPhone');
    if (mode === 'replace') { audio.pause(); audio.removeAttribute('src'); audio.load(); if (currentUrl) URL.revokeObjectURL(currentUrl); currentUrl = null; currentId = null; await clearBackupStores(); }
    const localTracks = await readAll('tracks'); const idMap = new Map();
    for (const source of backup.tracks) {
      const existing = mode === 'merge' && localTracks.find((track) => track.fingerprint && track.fingerprint === source.fingerprint);
      if (existing) { const merged = { ...existing, ...cleanTrack(source), id: existing.id, artworkId: remapArtworkId(source.artworkId, new Map([[source.id, existing.id]])), visualId: remapArtworkId(source.visualId, new Map([[source.id, existing.id]])), blobStored: existing.blobStored }; await saveRecord('tracks', merged); idMap.set(source.id, existing.id); }
      else if (backup.kind === 'full' && backup.audio.some((entry) => entry.id === source.id)) { await saveRecord('tracks', cleanTrack(source)); idMap.set(source.id, source.id); }
    }
    for (const source of backup.audio) { if (backup.kind === 'full' && idMap.get(source.id) === source.id) await saveRecord('audioBlobs', { id: source.id, blob: base64ToBlob(source.data, source.type) }); }
    for (const source of backup.artwork) { const targetId = remapArtworkId(source.id, idMap); if (mode === 'replace' || source.id.startsWith('playlist:') || [...idMap.keys()].some((id) => source.id === `track:${id}` || source.id === `visual:${id}`)) await saveRecord('artworkBlobs', { id: targetId, blob: base64ToBlob(source.data, source.type) }); }
    for (const source of backup.playlists) {
      const mappedIds = (source.trackIds || []).map((id) => idMap.get(id)).filter(Boolean);
      const existing = mode === 'merge' && playlists.find((playlist) => playlist.name === source.name);
      if (existing) { existing.trackIds = [...new Set([...existing.trackIds, ...mappedIds])]; await saveRecord('playlists', existing); }
      else if (mode === 'replace' || mappedIds.length) await saveRecord('playlists', { ...source, id: existing?.id || source.id, trackIds: mappedIds });
    }
    if (mode === 'replace') for (const setting of backup.settings) await saveRecord('settings', setting);
    if (mode === 'merge') for (const setting of backup.settings.filter((setting) => setting.key !== 'playerState')) await saveRecord('settings', setting);
    await loadLibrary(); await restorePlayerState(); await restorePreferences(); $('#volumeControl').value = audio.volume; if (currentId) showMiniPlayer(tracks.find((track) => track.id === currentId)); else $('#miniPlayer').classList.add('hidden'); render(); refreshStorageStatus(); pendingBackup = null;
    toast(mode === 'replace' ? 'Zombie backup restored' : 'Zombie backup merged safely');
  } catch { toast('Zombie could not restore that backup. Nothing else was deleted.'); } finally { hideProgress(); }
}
function deleteRecord(name, key) {
  return new Promise((resolve, reject) => { const request = store(name, 'readwrite').delete(key); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
}
function saveTrack(track, blob) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['tracks', 'audioBlobs'], 'readwrite');
    transaction.objectStore('tracks').put(track);
    transaction.objectStore('audioBlobs').put({ id: track.id, blob });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
function getAudioBlob(id) { return getRecord('audioBlobs', id).then((record) => record?.blob); }
async function saveArtwork(id, blob) { const oldUrl = artworkUrls.get(id); if (oldUrl) URL.revokeObjectURL(oldUrl); await saveRecord('artworkBlobs', { id, blob }); artworkUrls.delete(id); }
async function applyArtwork(element, track) {
  const artworkKey = track?.artworkId || '';
  const previousArtworkKey = element.dataset.artworkKey || '';
  element.dataset.artworkKey = artworkKey;
  element.className = `${element.className.split(' ').filter((name) => !name.startsWith('art-')).join(' ')} art-${artVariant(track)}`;
  element.style.backgroundImage = '';
  element.classList.remove('has-art');
  element.textContent = '';
  if (!track?.artworkId) return;
  try { const record = await getRecord('artworkBlobs', track.artworkId); if (!record?.blob || element.dataset.artworkKey !== artworkKey) return; let url = artworkUrls.get(track.artworkId); if (!url) { url = URL.createObjectURL(record.blob); artworkUrls.set(track.artworkId, url); } if (element.dataset.artworkKey !== artworkKey) return; element.style.backgroundImage = `url("${url}")`; element.classList.add('has-art'); element.textContent = ''; if (previousArtworkKey !== artworkKey) replayVisualClass(element, 'artwork-loaded'); } catch { /* fall back to local Zombie art */ }
}
function canUseAnimatedVisual(track = tracks.find((entry) => entry.id === currentId)) {
  return Boolean(track?.visualId && preferences.visualMode === 'animation' && !document.hidden && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches && !$('#nowPlayingScreen').classList.contains('hidden'));
}
function stopNowPlayingVisual() {
  const visual = $('#npVisual'); if (!visual) return;
  visual.pause(); visual.classList.remove('active'); visual.classList.add('hidden'); visual.removeAttribute('src'); $('#npArtStage')?.classList.remove('visual-active');
}
async function syncNowPlayingVisual(track = tracks.find((entry) => entry.id === currentId)) {
  const visual = $('#npVisual'), stage = $('#npArtStage'); if (!visual) return;
  const token = ++visualLoadToken;
  if (!canUseAnimatedVisual(track)) { stopNowPlayingVisual(); return; }
  try {
    const record = await getRecord('artworkBlobs', track.visualId);
    if (token !== visualLoadToken || !canUseAnimatedVisual(track) || !record?.blob) return;
    let url = visualUrls.get(track.visualId);
    if (!url) { url = URL.createObjectURL(record.blob); visualUrls.set(track.visualId, url); }
    visual.src = url; stage?.classList.remove('visual-active'); visual.classList.remove('hidden'); requestAnimationFrame(() => { visual.classList.add('active'); stage?.classList.add('visual-active'); });
    await visual.play();
  } catch (error) {
    if (token === visualLoadToken) { stopNowPlayingVisual(); console.info('[Zombie visual] local visual could not play', { name: error?.name || 'Error', message: error?.message || String(error) }); }
  }
}
async function saveSelectedVisual(file) {
  const id = visualTarget; visualTarget = null;
  if (!file || !id) return;
  if (file.size > 25 * 1024 * 1024) { toast('Choose a visual under 25 MB to protect iPhone storage'); return; }
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  try {
    showProgress('Saving animated visual', file.name);
    const visualId = `visual:${id}`; const oldUrl = visualUrls.get(visualId); if (oldUrl) URL.revokeObjectURL(oldUrl);
    visualUrls.delete(visualId); await saveRecord('artworkBlobs', { id: visualId, blob: file }); track.visualId = visualId; await saveRecord('tracks', track);
    syncNowPlaying(track); render(); toast('Animated visual saved offline');
  } catch { toast('Zombie could not save that visual'); } finally { hideProgress(); }
}
async function removeTrackVisual(track) {
  if (!track?.visualId) return;
  const url = visualUrls.get(track.visualId); if (url) URL.revokeObjectURL(url);
  visualUrls.delete(track.visualId); await deleteRecord('artworkBlobs', track.visualId); delete track.visualId; await saveRecord('tracks', track);
  if (track.id === currentId) stopNowPlayingVisual();
}
function parseLrc(text = '') {
  const syncedLyrics = [];
  String(text).replace(/^\uFEFF/, '').split(/\r?\n/).forEach((rawLine) => {
    const timestamp = /\[(\d{1,3}):(\d{1,2}(?:[.,]\d{1,3})?)\]/g;
    const tags = [...rawLine.matchAll(timestamp)];
    const lyric = rawLine.replace(timestamp, '').trim();
    tags.forEach((tag) => {
      const time = (Number(tag[1]) * 60) + Number(String(tag[2]).replace(',', '.'));
      if (Number.isFinite(time) && lyric) syncedLyrics.push({ time, text: lyric });
    });
  });
  return syncedLyrics.sort((a, b) => a.time - b.time);
}
function lyricsTextForEditor(track) {
  if (track?.syncedLyrics?.length) return track.syncedLyrics.map((line) => `${formatLrcTimestamp(line.time)} ${line.text}`).join('\n');
  return track?.lyrics || '';
}
function lyricOffsetFor(track) { const value = Number(track?.lyricOffset); return Number.isFinite(value) ? Math.max(-60, Math.min(60, value)) : 0; }
function lyricPlaybackTime(track) { return Math.max(0, (audio.currentTime || 0) - lyricOffsetFor(track)); }
function formatLyricOffset(offset) { const value = Math.round((Number(offset) || 0) * 10) / 10; return `${value > 0 ? '+' : ''}${value.toFixed(1)}s`; }
function setLyricsScreenMode(syncing = false) {
  $('#lyricsMode').textContent = syncing ? 'FIX SYNC' : 'LYRICS';
  $('#lyricsMenuButton').classList.toggle('hidden', syncing);
  $('#lyricsSyncActions').classList.toggle('hidden', !syncing);
}
function renderLyrics(track = tracks.find((entry) => entry.id === activeLyricsId)) {
  const content = $('#lyricsContent'); if (!content) return;
  if (lyricsSyncDraft) { renderLyricsSync(); return; }
  setLyricsScreenMode(false);
  if (!track) { content.innerHTML = '<div class="lyrics-empty"><strong>No song selected</strong>Start a song, then open Lyrics.</div>'; return; }
  $('#lyricsTrackTitle').textContent = `${track.emoji} ${track.title}`; $('#lyricsTrackArtist').textContent = `${track.artist} · ${track.album || 'Single'}`;
  if (track.syncedLyrics?.length) {
    content.innerHTML = track.syncedLyrics.map((line, index) => `<button class="lyric-line lyric-future" data-lyric-index="${index}" data-lyric-time="${line.time}">${escapeHTML(line.text)}</button>`).join('');
    lastLyricsIndex = -1; updateSyncedLyrics(true);
  } else if (track.lyrics?.trim()) {
    content.innerHTML = `<p class="plain-lyrics">${escapeHTML(track.lyrics)}</p>`; lastLyricsIndex = -1;
  } else {
    content.innerHTML = '<div class="lyrics-empty"><strong>No lyrics saved</strong>Paste lyrics or import a local .lrc or .txt file. They stay on this device and work offline.<br><button id="addLyricsEmpty">Add lyrics</button></div>';
    $('#addLyricsEmpty').onclick = () => openLyricsEditor(track.id);
  }
}
function updateSyncedLyrics(force = false) {
  if (!activeLyricsId || lyricsSyncDraft || $('#lyricsScreen').classList.contains('hidden')) return;
  const track = tracks.find((entry) => entry.id === activeLyricsId); if (!track?.syncedLyrics?.length) return;
  let activeIndex = -1;
  const timelineTime = lyricPlaybackTime(track);
  for (let index = 0; index < track.syncedLyrics.length; index += 1) { if (track.syncedLyrics[index].time <= timelineTime + 0.08) activeIndex = index; else break; }
  if (!force && activeIndex === lastLyricsIndex) return;
  lastLyricsIndex = activeIndex;
  const lines = [...$('#lyricsContent').querySelectorAll('[data-lyric-index]')];
  lines.forEach((line, index) => { line.classList.toggle('lyric-active', index === activeIndex); line.classList.toggle('lyric-past', index < activeIndex); line.classList.toggle('lyric-future', index > activeIndex); });
  const activeLine = lines[activeIndex]; const content = $('#lyricsContent');
  if (activeLine && content) {
    const lineBox = activeLine.getBoundingClientRect(), contentBox = content.getBoundingClientRect();
    const target = Math.max(0, content.scrollTop + lineBox.top - contentBox.top - (content.clientHeight * .5));
    const needsScroll = force || Math.abs(content.scrollTop - target) > Math.max(42, content.clientHeight * .18);
    if (needsScroll && (force || Date.now() >= lyricsManualScrollUntil)) {
      lyricsAutoScrollUntil = Date.now() + 650;
      content.scrollTo({ top: target, behavior: force || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
}
function openLyrics(id = currentId) {
  const track = tracks.find((entry) => entry.id === id); if (!track) { toast('Choose a song first'); return; }
  lyricsSyncDraft = null; lyricsManualScrollUntil = 0; $('#lyricsContent').classList.remove('manual-scroll'); setLyricsScreenMode(false); activeLyricsId = id; applyAmbientPalette(track); lastLyricsIndex = -1; const screen = $('#lyricsScreen'); screen.classList.remove('hidden'); $('#lyricsButton').classList.add('active'); syncModalScrollLock(); requestAnimationFrame(() => screen.classList.add('presented')); renderLyrics(track);
}
function closeLyrics() { lyricsSyncDraft = null; setLyricsScreenMode(false); const screen = $('#lyricsScreen'); screen.classList.remove('presented'); $('#lyricsButton').classList.remove('active'); setTimeout(() => { screen.classList.add('hidden'); syncModalScrollLock(); }, 180); activeLyricsId = null; lastLyricsIndex = -1; }
function openLyricsMenu() {
  const track = tracks.find((entry) => entry.id === activeLyricsId); if (!track) return;
  $('#sheetTitle').textContent = 'Lyrics';
  $('#sheetContent').innerHTML = `<button id="fixLyricsSync" class="lyrics-main-action">Fix Sync</button><button class="sheet-option" id="quickLyricsEditor">Edit Lyrics</button><details class="lyrics-advanced"><summary>Advanced Sync Settings</summary><p>Fine-tune timing, edit individual lines, or import lyrics. These tools are hidden during normal playback.</p><button class="sheet-option" id="advancedLyricsOffset">Adjust all lyric timing</button>${track.syncedLyrics?.length ? '<button class="sheet-option" id="advancedLineEditor">Edit timestamps and lyric text</button>' : ''}<button class="sheet-option" id="advancedLyricsEditor">Import or edit lyrics</button></details>`;
  $('#fixLyricsSync').onclick = () => { closeSheet(); startLyricsSync(); };
  $('#quickLyricsEditor').onclick = () => openLyricsEditor(track.id);
  $('#advancedLyricsOffset').onclick = openLyricsOffset;
  $('#advancedLineEditor')?.addEventListener('click', () => openSyncedLineEditor(track.id));
  $('#advancedLyricsEditor').onclick = () => openLyricsEditor(track.id);
  showSheet();
}
function openLyricsOffset() {
  const track = tracks.find((entry) => entry.id === activeLyricsId); if (!track) return;
  const offset = lyricOffsetFor(track); $('#sheetTitle').textContent = 'Lyrics sync';
  $('#sheetContent').innerHTML = `<p class="sheet-note">Shift every timestamp for this song. Positive makes lyrics appear later; negative makes them appear earlier. Saved offline for this song.</p><div class="lyrics-offset-readout" id="lyricsOffsetValue">${formatLyricOffset(offset)}</div><div class="lyrics-offset-buttons"><button class="sheet-option" data-lyrics-offset="-1">−1.0s</button><button class="sheet-option" data-lyrics-offset="-.5">−0.5s</button><button class="sheet-option" data-lyrics-offset=".5">+0.5s</button><button class="sheet-option" data-lyrics-offset="1">+1.0s</button></div><label class="edit-field">Manual offset (seconds)<input id="lyricsOffsetInput" type="number" inputmode="decimal" min="-60" max="60" step="0.1" value="${offset}"></label><button class="sheet-option" id="saveLyricsOffset">Set offset</button>`;
  const applyOffset = async (value) => { if (!Number.isFinite(value)) return; track.lyricOffset = Math.max(-60, Math.min(60, Math.round(value * 100) / 100)); await saveRecord('tracks', track); lastLyricsIndex = -1; updateSyncedLyrics(true); openLyricsOffset(); };
  $('#sheetContent').querySelectorAll('[data-lyrics-offset]').forEach((button) => { button.onclick = () => { void applyOffset(offset + Number(button.dataset.lyricsOffset)); }; });
  $('#saveLyricsOffset').onclick = () => { void applyOffset(Number($('#lyricsOffsetInput').value)); };
  showSheet();
}
function syncLinesFor(track) {
  if (track?.syncedLyrics?.length) return track.syncedLyrics.map((line) => ({ time: Math.max(0, Number(line.time) || 0), text: String(line.text || '') }));
  return String(track?.lyrics || '').split(/\r?\n/).map((text) => text.trim()).filter(Boolean).map((text) => ({ time: 0, text }));
}
function startLyricsSync() {
  const track = tracks.find((entry) => entry.id === activeLyricsId); const lines = syncLinesFor(track);
  if (!track) return; if (!lines.length) { toast('Add or import lyrics before syncing'); return; }
  lyricsSyncDraft = { trackId: track.id, lines, index: 0 }; setLyricsScreenMode(true); renderLyricsSync();
}
function renderLyricsSync() {
  const draft = lyricsSyncDraft; const content = $('#lyricsContent'); if (!draft || !content) return;
  const track = tracks.find((entry) => entry.id === draft.trackId); if (!track) return;
  $('#lyricsTrackTitle').textContent = `${track.emoji} ${track.title}`; $('#lyricsTrackArtist').textContent = 'Tap each line as you hear it begin';
  content.innerHTML = `<div class="lyrics-sync-note">Keep the song playing.<strong>Tap the bright line right when you hear it start.</strong>The next line is ready automatically.</div><div class="lyrics-sync-list">${draft.lines.map((line, index) => `<button class="lyrics-sync-line ${index === draft.index ? 'selected' : ''}" data-sync-line="${index}" aria-label="${index === draft.index ? 'Set time for: ' : 'Choose lyric line: '}${escapeHTML(line.text)}">${escapeHTML(line.text)}</button>`).join('')}</div>`;
  content.querySelectorAll('[data-sync-line]').forEach((button) => { button.onclick = () => { const index = Number(button.dataset.syncLine); if (index === draft.index) setNextLyricTime(); else { draft.index = index; renderLyricsSync(); } }; });
  const selected = content.querySelector('.lyrics-sync-line.selected'); selected?.scrollIntoView({ block: 'center', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
function setNextLyricTime() {
  const draft = lyricsSyncDraft; const track = tracks.find((entry) => entry.id === draft?.trackId); if (!draft || !track) return;
  draft.lines[draft.index].time = lyricPlaybackTime(track);
  if (draft.index < draft.lines.length - 1) draft.index += 1; else toast('Last lyric line timed');
  renderLyricsSync();
}
function backLyricsSyncLine() { if (!lyricsSyncDraft) return; lyricsSyncDraft.index = Math.max(0, lyricsSyncDraft.index - 1); renderLyricsSync(); }
function redoLyricsSyncLine() {
  const draft = lyricsSyncDraft; if (!draft) return;
  const previous = Math.max(0, draft.index - 1); draft.lines[previous].time = 0; draft.index = previous; renderLyricsSync();
}
async function saveLyricsSync() {
  const draft = lyricsSyncDraft; const track = tracks.find((entry) => entry.id === draft?.trackId); if (!draft || !track) return;
  const lines = draft.lines.map((line) => ({ time: Math.max(0, Number(line.time) || 0), text: String(line.text || '').trim() })).filter((line) => line.text).sort((a, b) => a.time - b.time);
  if (!lines.length) { toast('Keep at least one lyric line'); return; }
  track.syncedLyrics = lines; track.lyrics = ''; await saveRecord('tracks', track); lyricsSyncDraft = null; lastLyricsIndex = -1; renderLyrics(track); toast('Lyrics timing saved offline');
}
function cancelLyricsSync() { if (!lyricsSyncDraft) return; lyricsSyncDraft = null; lastLyricsIndex = -1; renderLyrics(); toast('Lyrics sync changes discarded'); }
function openSyncedLineEditor(id = activeLyricsId) {
  const track = tracks.find((entry) => entry.id === id); if (!track?.syncedLyrics?.length) return;
  $('#sheetTitle').textContent = 'Edit lyric lines';
  $('#sheetContent').innerHTML = `<p class="sheet-note">Edit each timestamp in seconds or change the lyric text. Zombie saves standard timestamps such as ${formatLrcTimestamp(6.1)}.</p><div class="lyric-line-editor">${track.syncedLyrics.map((line, index) => `<label class="lyric-edit-row" data-lyric-edit="${index}"><span>${formatLrcTimestamp(line.time)}</span><input class="lyric-edit-time" aria-label="Timestamp for lyric ${index + 1}" type="number" inputmode="decimal" min="0" step="0.01" value="${Number(line.time).toFixed(2)}"><input class="lyric-edit-text" aria-label="Text for lyric ${index + 1}" value="${escapeHTML(line.text)}"></label>`).join('')}</div><button class="sheet-option" id="saveSyncedLines">Save lyric line changes</button>`;
  $('#saveSyncedLines').onclick = async () => { const lines = [...$('#sheetContent').querySelectorAll('[data-lyric-edit]')].map((row) => ({ time: Number(row.querySelector('.lyric-edit-time').value), text: row.querySelector('.lyric-edit-text').value.trim() })).filter((line) => Number.isFinite(line.time) && line.time >= 0 && line.text).sort((a, b) => a.time - b.time); if (!lines.length) { toast('Keep at least one lyric line'); return; } track.syncedLyrics = lines; track.lyrics = ''; await saveRecord('tracks', track); closeSheet(); if (activeLyricsId === id) { lastLyricsIndex = -1; renderLyrics(track); } toast('Lyric lines saved offline'); };
  showSheet();
}
function openLyricsEditor(id = currentId) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  $('#sheetTitle').textContent = 'Offline lyrics';
  $('#sheetContent').innerHTML = `<p class="sheet-note">Paste plain lyrics, or use timestamps such as ${formatLrcTimestamp(6.1)}. Nothing is sent online.</p><label class="edit-field">Lyrics<textarea id="lyricsEditor" rows="11" placeholder="Paste lyrics or LRC timestamps here"></textarea></label><button class="sheet-option" id="importLyrics">Import .lrc or .txt</button>${track.syncedLyrics?.length ? '<button class="sheet-option" id="editSyncedLines">Edit lyric lines</button>' : ''}<button class="sheet-option" id="saveLyrics">Save lyrics offline</button>${(track.lyrics || track.syncedLyrics?.length) ? '<button class="sheet-option danger-text" id="clearLyrics">Remove lyrics</button>' : ''}`;
  $('#lyricsEditor').value = lyricsTextForEditor(track);
  $('#importLyrics').onclick = () => { lyricsTarget = id; $('#lyricsInput').click(); };
  $('#editSyncedLines')?.addEventListener('click', () => openSyncedLineEditor(id));
  $('#saveLyrics').onclick = async () => { const value = $('#lyricsEditor').value.trim(); const syncedLyrics = parseLrc(value); track.syncedLyrics = syncedLyrics; track.lyrics = syncedLyrics.length ? '' : value; await saveRecord('tracks', track); closeSheet(); if (activeLyricsId === id) renderLyrics(track); toast(syncedLyrics.length ? 'Synced lyrics saved offline' : 'Lyrics saved offline'); };
  $('#clearLyrics')?.addEventListener('click', async () => { track.lyrics = ''; track.syncedLyrics = []; await saveRecord('tracks', track); closeSheet(); if (activeLyricsId === id) renderLyrics(track); toast('Lyrics removed'); });
  showSheet();
}
async function importLyricsFile(file) {
  const id = lyricsTarget; lyricsTarget = null;
  if (!file || !id) return;
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  try {
    const fileName = String(file.name || '').toLowerCase();
    if (!/\.(lrc|txt)$/.test(fileName) && !/^text\//i.test(file.type || '')) throw new Error('Choose an .lrc or .txt lyrics file');
    if (file.size > 750 * 1024) throw new Error('Lyrics file is too large');
    const value = await file.text(); const syncedLyrics = parseLrc(value); track.syncedLyrics = syncedLyrics; track.lyrics = syncedLyrics.length ? '' : value.trim(); await saveRecord('tracks', track);
    closeSheet(); if (activeLyricsId === id) renderLyrics(track); toast(syncedLyrics.length ? 'Synced LRC lyrics imported' : 'Lyrics imported offline');
  } catch (error) { toast(error.message || 'Zombie could not read those lyrics'); }
}
function openAudioMods() {
  $('#audioModsButton').classList.add('active');
  $('#sheetTitle').textContent = 'Audio';
  $('#sheetContent').innerHTML = `<p class="sheet-note">Speed changes playback only — your files are never changed. Live EQ, reverb, and pitch processing stay off because Web Audio can make iPhone background playback less reliable.</p><p class="sheet-section">PLAYBACK SPEED</p>${[0.8, 1, 1.2, 1.5].map((rate) => `<button class="sheet-option ${preferences.playbackRate === rate ? 'selected-option' : ''}" data-rate="${rate}">${rate === 1 ? 'Normal · 1×' : `${rate}×`}</button>`).join('')}`;
  $('#sheetContent').querySelectorAll('[data-rate]').forEach((button) => { button.onclick = () => { preferences.playbackRate = Number(button.dataset.rate); audio.playbackRate = preferences.playbackRate; savePreferences(); updateMediaPosition(); closeSheet(); toast(preferences.playbackRate === 1 ? 'Original sound restored' : `Playback speed: ${preferences.playbackRate}×`); }; });
  showSheet();
}
async function mediaArtworkFor(track) {
  const fallback = new URL('zombie-icon-512.png?v=15', location.href).href;
  if (!track?.artworkId) return fallback;
  try {
    const record = await getRecord('artworkBlobs', track.artworkId);
    if (!record?.blob) return fallback;
    let url = artworkUrls.get(track.artworkId);
    if (!url) { url = URL.createObjectURL(record.blob); artworkUrls.set(track.artworkId, url); }
    return url;
  } catch { return fallback; }
}
function updateMediaPosition() {
  if (!navigator.mediaSession?.setPositionState || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(Math.max(audio.currentTime || 0, 0), audio.duration), playbackRate: audio.playbackRate || 1 }); } catch { /* unsupported browser detail */ }
}
function trackDebug(track) { return track ? { id: track.id, title: track.title } : null; }
function audioErrorDebug() { const error = audio.error; return error ? { code: error.code, message: error.message || 'MediaError' } : null; }
function currentAudioSource() { return audio.currentSrc || audio.src || ''; }
function capturePausedResumeSnapshot(reason = 'pause') {
  const track = tracks.find((entry) => entry.id === (pendingAudio?.id || currentId));
  if (!track || audio.ended) return;
  pausedResumeSnapshot = {
    id: track.id,
    src: currentAudioSource(),
    position: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    token: loadToken,
    capturedAt: Date.now(),
  };
  playbackDebug('pause-source-snapshotted', { reason, next: trackDebug(track), pausedSourceAlive: Boolean(pausedResumeSnapshot.src) });
}
function hasLivePausedSource(track) {
  const source = currentAudioSource();
  const snapshotMatches = !pausedResumeSnapshot || pausedResumeSnapshot.id !== track?.id || !pausedResumeSnapshot.src || pausedResumeSnapshot.src === source;
  return Boolean(source && snapshotMatches && !audio.error);
}
function replayVisualClass(element, className) {
  if (!element) return;
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}
function animatePlaybackControls(state) {
  ['#playButton', '#miniPlay'].forEach((selector) => replayVisualClass($(selector), state === 'playing' ? 'playback-started' : 'playback-paused'));
}
function playbackDebug(stage, details = {}) {
  console.info(`[Zombie playback] ${stage}`, {
    previous: details.previous || null, next: details.next || null, queueIndex, queueLength: queue.length, shuffleOn, repeatMode,
    readyState: audio.readyState, networkState: audio.networkState, paused: audio.paused, ended: audio.ended,
    currentTime: audio.currentTime, duration: audio.duration, src: audio.currentSrc || audio.src || '', blobLoaded: details.blobLoaded,
    error: audioErrorDebug(), mediaPlaybackState: navigator.mediaSession?.playbackState || null, visibility: document.visibilityState, ...details,
  });
}
function setMediaPlaybackState(state) { try { if (navigator.mediaSession) navigator.mediaSession.playbackState = state; } catch { /* optional iOS API */ } }
function retireAudioUrl(url, reason) {
  if (!url || url === currentUrl) return;
  retiredAudioUrls.add(url); playbackDebug('object-url-retired', { reason });
}
function releaseRetiredAudioUrls(reason) {
  for (const url of [...retiredAudioUrls]) {
    if (url === currentUrl || audio.src === url || audio.currentSrc === url) continue;
    URL.revokeObjectURL(url); retiredAudioUrls.delete(url); playbackDebug('object-url-revoked', { reason });
  }
}
function commitPendingPlayback(reason) {
  const pending = pendingAudio;
  if (!pending || pending.token !== loadToken || (audio.src !== pending.url && audio.currentSrc !== pending.url)) return false;
  currentId = pending.id; currentUrl = pending.url; pendingAudio = null; playbackSerial += 1;
  retireAudioUrl(pending.oldUrl, `replacement ${reason}`);
  const track = tracks.find((entry) => entry.id === currentId);
  playbackDebug('transition-committed', { reason, previous: pending.previous, next: trackDebug(track), objectUrlCreated: true });
  savePlayerState(true); showMiniPlayer(track); render();
  return true;
}
function schedulePlaybackDiagnostic(track, token, reason, startTime) {
  window.setTimeout(() => {
    if (token !== loadToken || currentId !== track.id) return;
    // iPhone can delay timers while audio continues correctly in the background.
    // A background timer is therefore diagnostic-only: it must never stop live audio.
    if (document.visibilityState !== 'visible') {
      playbackDebug('playback-health-check-deferred-background', { reason, next: trackDebug(track), startTime });
      return;
    }
    const timeAdvanced = audio.currentTime > startTime + 0.05;
    const sourceValid = Boolean(audio.currentSrc || audio.src);
    const healthy = sourceValid && audio.readyState >= 2 && (timeAdvanced || audio.ended);
    playbackDebug('playback-health-check', { reason, next: trackDebug(track), startTime, timeAdvanced, sourceValid, healthy });
    if (!healthy && !audio.ended) {
      audio.pause(); setMediaPlaybackState('paused'); $('#playButton').textContent = '▶'; $('#miniPlay').textContent = '▶'; render();
      toast('Zombie could not keep this song playing');
    }
  }, 900);
}
function confirmActualPlayback(track, token, reason) {
  if (token !== loadToken || audio.paused || !(audio.currentSrc || audio.src) || audio.readyState < 2) {
    playbackDebug('play-confirmation-failed', { reason, next: trackDebug(track) }); setMediaPlaybackState('paused'); return false;
  }
  if (!commitPendingPlayback('play-confirmed')) {
    playbackDebug('play-confirmation-commit-failed', { reason, next: trackDebug(track) }); setMediaPlaybackState('paused'); return false;
  }
  const activeTrack = tracks.find((entry) => entry.id === currentId) || track;
  pausedResumeSnapshot = null;
  $('#miniPlayer').classList.remove('loading'); $('#playButton').textContent = 'Ⅱ'; $('#miniPlay').textContent = 'Ⅱ'; animatePlaybackControls('playing'); setMediaPlaybackState('playing');
  if (activeTrack && countedSerial !== playbackSerial) { countedSerial = playbackSerial; activeTrack.playCount = (activeTrack.playCount || 0) + 1; activeTrack.lastPlayed = Date.now(); saveRecord('tracks', activeTrack).catch(() => {}); }
  releaseRetiredAudioUrls('replacement confirmed');
  playbackDebug('play-confirmed', { reason, next: trackDebug(activeTrack) }); void updateMediaSession(activeTrack); render(); void prepareNextTrack();
  return true;
}
async function requestAudioPlay(track, token = loadToken, reason = 'play') {
  const startTime = audio.currentTime || 0;
  playbackDebug('play-attempt', { reason, next: trackDebug(track) });
  try {
    await audio.play();
    if (token !== loadToken) { playbackDebug('play-resolved-stale', { reason, next: trackDebug(track) }); return false; }
    if (audio.paused || !(audio.currentSrc || audio.src)) { const error = new Error('audio.play() resolved without an active playing source'); error.name = 'AudioStartVerificationError'; throw error; }
    playbackDebug('play-resolved', { reason, next: trackDebug(track), startTime }); schedulePlaybackDiagnostic(track, token, reason, startTime);
    return true;
  } catch (error) {
    playbackDebug('play-rejected', { reason, next: trackDebug(track), playError: { name: error?.name || 'Error', message: error?.message || String(error) } });
    setMediaPlaybackState('paused');
    throw error;
  }
}
async function rebuildPausedSource(track, reason = 'resume-source-recovery') {
  const savedPosition = Number.isFinite(audio.currentTime) && audio.currentTime > 0 ? audio.currentTime : (pausedResumeSnapshot?.id === track.id ? pausedResumeSnapshot.position : restoredPosition);
  const token = ++loadToken;
  const oldUrl = pendingAudio?.url || currentUrl || pausedResumeSnapshot?.src || '';
  playbackDebug('resume-source-recovery-start', { reason, next: trackDebug(track), previous: trackDebug(tracks.find((entry) => entry.id === currentId)), savedPosition });
  try {
    const blob = await getAudioBlob(track.id);
    if (token !== loadToken) return false;
    if (!blob) { playbackDebug('resume-source-recovery-blob-missing', { reason, next: trackDebug(track), blobLoaded: false }); return false; }
    const url = URL.createObjectURL(blob);
    pendingAudio = { id: track.id, url, token, oldUrl, previous: trackDebug(tracks.find((entry) => entry.id === currentId)) };
    audio.src = url;
    if (savedPosition > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.min(savedPosition, Math.max(0, (audio.duration || savedPosition) - 0.05)); }, { once: true });
    playbackDebug('resume-source-recovery-attached', { reason, next: trackDebug(track), blobLoaded: true, objectUrlCreated: true, savedPosition });
    const started = await requestAudioPlay(track, token, reason);
    return started && confirmActualPlayback(track, token, reason);
  } catch (error) {
    playbackDebug('resume-source-recovery-failed', { reason, next: trackDebug(track), recoveryError: { name: error?.name || 'Error', message: error?.message || String(error) } });
    setMediaPlaybackState('paused');
    return false;
  }
}
async function resumeCurrentAudio(reason = 'resume') {
  const track = tracks.find((entry) => entry.id === (pendingAudio?.id || currentId));
  const attempt = ++mediaResumeAttempt;
  playbackDebug('resume-requested', { reason, next: trackDebug(track), sourceAlive: hasLivePausedSource(track), pausedSnapshot: pausedResumeSnapshot?.id === track?.id ? { position: pausedResumeSnapshot.position, sameSource: pausedResumeSnapshot.src === currentAudioSource() } : null, mediaResumeAttempt: attempt });
  if (!track) { playbackDebug('resume-skipped-no-track', { reason, mediaResumeAttempt: attempt }); return false; }
  if (!hasLivePausedSource(track)) {
    const recovered = await rebuildPausedSource(track, `${reason}-missing-source`);
    if (!recovered) toast('Zombie could not restore this paused song');
    return recovered;
  }
  try {
    // This is deliberately the direct fast path for the iPhone Lock Screen action: no UI/render work occurs before play().
    const started = await requestAudioPlay(track, loadToken, reason);
    const confirmed = started && confirmActualPlayback(track, loadToken, reason);
    if (confirmed) pausedResumeSnapshot = null;
    return confirmed;
  } catch (error) {
    const recoverableSourceFailure = Boolean(audio.error) || !currentAudioSource();
    playbackDebug('resume-failed', { reason, next: trackDebug(track), mediaResumeAttempt: attempt, recoverableSourceFailure, resumeError: { name: error?.name || 'Error', message: error?.message || String(error) } });
    if (recoverableSourceFailure) return rebuildPausedSource(track, `${reason}-failed-source`);
    toast('Zombie could not resume this song');
    return false;
  }
}
async function updateMediaSession(track = tracks.find((entry) => entry.id === currentId)) {
  if (!track || !('mediaSession' in navigator) || !window.MediaMetadata) return;
  const art = await mediaArtworkFor(track);
  if (track.id !== currentId) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist, album: track.album, artwork: [{ src: art, sizes: '512x512' }] });
    navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
    updateMediaPosition();
  } catch { /* Media Session is optional on older iPhones */ }
}
function configureMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const actions = {
    play: () => {
      const track = tracks.find((entry) => entry.id === (pendingAudio?.id || currentId));
      playbackDebug('media-session-play-handler-fired', { next: trackDebug(track), sourceAlive: hasLivePausedSource(track), pausedSnapshot: pausedResumeSnapshot?.id === track?.id ? { position: pausedResumeSnapshot.position, sameSource: pausedResumeSnapshot.src === currentAudioSource() } : null });
      void resumeCurrentAudio('media-session-play');
    }, pause: () => { playbackDebug('media-session-pause-handler-fired'); audio.pause(); },
    previoustrack: () => { void previousTrack().catch((error) => playbackDebug('media-previous-failed', { actionError: error?.message || String(error) })); },
    nexttrack: () => { void nextTrack().catch((error) => playbackDebug('media-next-failed', { actionError: error?.message || String(error) })); },
  };
  Object.entries(actions).forEach(([action, handler]) => { try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* action not exposed by this iOS version */ } });
  playbackDebug('media-session-handlers-configured', { handlers: Object.keys(actions) });
}
function artVariant(track) { let hash = 0; for (const character of `${track?.title || ''}${track?.artist || ''}${track?.genre || ''}`) hash = ((hash << 5) - hash) + character.charCodeAt(0); return Math.abs(hash) % 6; }
function randomize(values) {
  const output = [...values];
  for (let i = output.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [output[i], output[j]] = [output[j], output[i]]; }
  return output;
}

async function loadLibrary() {
  const loaded = await Promise.all([readAll('tracks'), readAll('playlists'), getRecord('settings', 'playlistFolders').catch(() => null)]);
  [tracks, playlists] = loaded;
  playlistFolders = Array.isArray(loaded[2]?.folders) ? loaded[2].folders.filter((folder) => folder?.id && folder?.name).map((folder) => ({ id: String(folder.id), name: String(folder.name).slice(0, 80), createdAt: Number(folder.createdAt) || Date.now() })) : [];
  tracks = tracks.map((track) => ({
    ...track,
    title: track.title || track.name || 'Untitled song',
    artist: neutralArtist(track.artist),
    album: track.album || 'Single',
    genre: track.genre || '',
    emoji: track.emoji || randomEmoji(),
    isFavorite: Boolean(track.isFavorite),
    playCount: Number(track.playCount || 0),
    type: track.type || 'audio/mpeg',
    lyrics: typeof track.lyrics === 'string' ? track.lyrics : '',
    syncedLyrics: Array.isArray(track.syncedLyrics) ? track.syncedLyrics.filter((line) => Number.isFinite(line?.time) && typeof line?.text === 'string') : [],
    visualId: typeof track.visualId === 'string' ? track.visualId : '',
  }));
  playlists = playlists.map((playlist) => ({ ...playlist, trackIds: Array.isArray(playlist.trackIds) ? playlist.trackIds : [] }));
}

function visibleTracks() {
  const search = $('#searchInput').value.trim().toLowerCase();
  let list = [...tracks];
  if (currentView === 'recent') list.sort((a, b) => b.addedAt - a.addedAt);
  if (currentView === 'played') list = list.filter((track) => track.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 50);
  if (currentView === 'most') list = list.filter((track) => track.playCount).sort((a, b) => b.playCount - a.playCount);
  if (currentView === 'favorites') list = list.filter((track) => track.isFavorite);
  if (collectionFilter?.type === 'album') list = list.filter((track) => track.album === collectionFilter.value);
  if (collectionFilter?.type === 'artist') list = list.filter((track) => track.artist === collectionFilter.value);
  if (collectionFilter?.type === 'genre') list = list.filter((track) => track.genre === collectionFilter.value);
  if (search) list = list.filter((track) => `${track.title} ${track.artist} ${track.album} ${track.genre}`.toLowerCase().includes(search));
  const sort = $('#sortSelect').value;
  if (currentView !== 'recent' || sort !== 'recent') {
    if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === 'artist') list.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
    if (sort === 'album') list.sort((a, b) => a.album.localeCompare(b.album) || a.title.localeCompare(b.title));
    if (sort === 'recent') list.sort((a, b) => b.addedAt - a.addedAt);
    if (sort === 'oldest') list.sort((a, b) => a.addedAt - b.addedAt);
    if (sort === 'plays') list.sort((a, b) => b.playCount - a.playCount);
    if (sort === 'least') list.sort((a, b) => a.playCount - b.playCount);
    if (sort === 'played') list.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
    if (sort === 'duration') list.sort((a, b) => (b.duration || 0) - (a.duration || 0));
  }
  return list;
}
function showEmptyState({ icon = '☠', title = 'Your library is waiting', message = 'Import music once, then keep listening offline.', action = null } = {}) {
  const state = $('#emptyState');
  state.style.display = 'block';
  state.innerHTML = `<div>${icon}</div><h2>${escapeHTML(title)}</h2><p>${escapeHTML(message)}</p>${action ? `<button class="empty-action">${escapeHTML(action.label)}</button>` : ''}`;
  const emptyAction = state.querySelector('.empty-action');
  if (emptyAction && action?.onClick) emptyAction.addEventListener('click', action.onClick);
}
function hideEmptyState() { $('#emptyState').style.display = 'none'; }
function render() {
  $('#screenTitle').textContent = activePlaylistId ? (playlists.find((playlist) => playlist.id === activePlaylistId)?.name || 'Playlist') : (collectionFilter?.value || 'Zombie');
  $('#libraryScreen').classList.toggle('hidden', currentView === 'settings');
  $('#settingsScreen').classList.toggle('hidden', currentView !== 'settings');
  document.querySelectorAll('.bottom-nav button').forEach((button) => button.classList.toggle('active', button.dataset.nav === (currentView === 'settings' ? 'settings' : 'library')));
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.view === currentView && !activePlaylistId));
  if (currentView === 'settings') { refreshStorageStatus(); return; }
  const area = $('#contentArea'); area.className = `content-area layout-${preferences.layout}`; area.innerHTML = ''; replayVisualClass(area, 'library-refresh');
  $('#importArea').classList.toggle('hidden', currentView !== 'songs' || Boolean(collectionFilter) || Boolean(activePlaylistId));
  $('#importArea').classList.toggle('library-populated', tracks.length > 0);
  $('#sortSelect').parentElement.classList.toggle('hidden', ['albums', 'artists', 'playlists'].includes(currentView) || Boolean(activePlaylistId));
  if (activePlaylistId) renderPlaylistDetail(area);
  else if (currentView === 'albums') renderCollections(area, 'album');
  else if (currentView === 'artists') renderCollections(area, 'artist');
  else if (currentView === 'genres') renderCollections(area, 'genre');
  else if (currentView === 'playlists') renderPlaylists(area);
  else {
    const list = visibleTracks();
    if (currentView === 'songs' && !collectionFilter && !$('#searchInput').value.trim() && tracks.length) renderHomeShelves(area);
    renderTrackList(area, list);
  }
}
function appendHomeShelf(area, title, subtitle, list) {
  if (!list.length) return;
  const shelf = document.createElement('section'); shelf.className = 'home-shelf';
  shelf.innerHTML = `<div class="home-shelf-heading"><h2>${escapeHTML(title)}</h2><span>${escapeHTML(subtitle)}</span></div><div class="home-card-row">${list.map((track) => `<button class="home-song-card ${track.id === currentId ? 'current' : ''}" data-home-track="${track.id}" aria-label="Play ${escapeHTML(track.title)}"><span class="cover art-${artVariant(track)}" data-home-art="${track.id}">Z</span><span><strong>${escapeHTML(track.title)}</strong><small>${escapeHTML(track.artist)}</small></span></button>`).join('')}</div>`;
  shelf.querySelectorAll('[data-home-track]').forEach((button) => {
    const track = tracks.find((entry) => entry.id === button.dataset.homeTrack); if (!track) return;
    button.onclick = () => { const source = list.map((entry) => entry.id); void playTrack(track.id, source); };
    applyArtwork(button.querySelector('[data-home-art]'), track);
  });
  area.append(shelf);
}
function renderHomeShelves(area) {
  const current = tracks.find((track) => track.id === currentId);
  const hero = document.createElement(current ? 'button' : 'article'); hero.className = 'home-hero';
  hero.innerHTML = current
    ? `<p>NOW PLAYING</p><strong>${escapeHTML(current.title)}</strong><small>${escapeHTML(current.artist)} · ${audio.paused ? 'Ready when you are' : 'Playing from your local library'}</small><span class="hero-now">${current.emoji} <span>Open Now Playing</span></span>`
    : '<p>YOUR MUSIC. YOUR RULES.</p><strong>Built for your local library.</strong><small>Offline-ready playback, your playlists, your lyrics.</small>';
  if (current) hero.onclick = openNowPlaying;
  area.append(hero);
  const recentlyPlayed = tracks.filter((track) => track.lastPlayed).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0)).slice(0, 8);
  const favorites = tracks.filter((track) => track.isFavorite).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0)).slice(0, 8);
  const recentlyAdded = [...tracks].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 8);
  if (recentlyPlayed.length) appendHomeShelf(area, 'Recently played', 'Pick up where you left off', recentlyPlayed);
  if (favorites.length) appendHomeShelf(area, 'Favorites', 'Saved on this device', favorites);
  appendHomeShelf(area, 'Recently added', 'Your latest imports', recentlyAdded);
}
function renderTrackList(area, list, playlist = null) {
  $('#librarySummary').textContent = libraryStats(list);
  if (list.length) hideEmptyState();
  if (collectionFilter && !playlist) {
    const context = document.createElement('article'); context.className = 'collection-context';
    const albums = new Set(list.map((track) => track.album || 'Single')).size;
    context.innerHTML = `<strong>${escapeHTML(collectionFilter.value || 'Other')}</strong><p>${collectionFilter.type === 'artist' ? `${list.length} ${list.length === 1 ? 'song' : 'songs'} · ${albums} ${albums === 1 ? 'album' : 'albums'}` : collectionFilter.type === 'album' ? `${escapeHTML(list[0]?.artist || 'Unknown artist')} · ${list.length} ${list.length === 1 ? 'song' : 'songs'}` : `${list.length} ${list.length === 1 ? 'song' : 'songs'}`}</p><span class="collection-pill">${formatTotalDuration(list.reduce((total, track) => total + (track.duration || 0), 0))}</span>`;
    area.append(context);
  }
  if (!list.length) {
    if (playlist) {
      hideEmptyState();
      area.insertAdjacentHTML('beforeend', '<div class="inline-empty">This playlist is empty. Add songs from your library.</div>');
    } else if (currentView === 'favorites') showEmptyState({ icon: '♡', title: 'No favorites yet', message: 'Tap the heart on any song to keep it close.' });
    else if (currentView === 'played') showEmptyState({ icon: '◷', title: 'Nothing played yet', message: 'Your recently played songs will appear here.' });
    else if (currentView === 'most') showEmptyState({ icon: '↗', title: 'Your top songs will grow here', message: 'Play your local music and Zombie will keep the count on this device.' });
    else if (currentView === 'recent') showEmptyState({ icon: '♫', title: 'No recent imports', message: 'Add music to build your local library.', action: { label: 'Import music', onClick: () => $('#fileInput').click() } });
    else showEmptyState({ icon: '🧟', title: 'Your library is waiting', message: 'Import music once, then listen offline whenever you want.', action: { label: 'Import music', onClick: () => $('#fileInput').click() } });
    return;
  }
  list.forEach((track, position) => {
    const item = document.createElement('article'); item.className = `track ${track.id === currentId ? 'active' : ''}`;
    item.innerHTML = `<button class="track-main" aria-label="Play ${escapeHTML(track.title)}"><span class="cover art-${artVariant(track)}" data-art="${track.id}">Z</span><span class="track-copy"><strong><i class="title-emoji">${track.emoji}</i>${escapeHTML(track.title)}${track.id === currentId && !audio.paused ? '<span class="playing-bars" aria-label="Playing"><i></i><i></i><i></i></span>' : ''}</strong><small>${escapeHTML(track.artist)} · ${escapeHTML(track.album)}${track.genre ? ` · <em>${escapeHTML(track.genre)}</em>` : ''}</small></span></button><button class="favorite ${track.isFavorite ? 'selected' : ''}" aria-label="${track.isFavorite ? 'Remove from' : 'Add to'} favorites">${track.isFavorite ? '♥' : '♡'}</button><button class="more" aria-label="Song options">⋯</button>${playlist ? `<span class="reorder"><button aria-label="Move song up">↑</button><button aria-label="Move song down">↓</button><button aria-label="Remove from playlist">×</button></span>` : '<button class="delete" aria-label="Delete from device">×</button>'}`;
    item.querySelector('.track-main').onclick = () => playTrack(track.id, list.map((entry) => entry.id));
    item.querySelector('.favorite').onclick = () => toggleFavorite(track.id);
    item.querySelector('.more').onclick = () => openSongOptions(track.id);
    if (playlist) {
      const [up, down, removeButton] = item.querySelectorAll('.reorder button');
      up.onclick = () => reorderPlaylist(playlist.id, position, position - 1);
      down.onclick = () => reorderPlaylist(playlist.id, position, position + 1);
      removeButton.onclick = () => removeFromPlaylist(playlist.id, track.id);
      up.disabled = position === 0; down.disabled = position === list.length - 1;
      item.draggable = true;
      item.addEventListener('dragstart', () => { playlistDragTrackId = track.id; item.classList.add('dragging-track'); });
      item.addEventListener('dragend', () => { playlistDragTrackId = null; item.classList.remove('dragging-track'); });
      item.addEventListener('dragover', (event) => { if (playlistDragTrackId && playlistDragTrackId !== track.id) event.preventDefault(); });
      item.addEventListener('drop', (event) => {
        event.preventDefault();
        const from = playlist.trackIds.indexOf(playlistDragTrackId), to = playlist.trackIds.indexOf(track.id);
        if (from >= 0 && to >= 0 && from !== to) void reorderPlaylist(playlist.id, from, to);
      });
    } else item.querySelector('.delete').onclick = () => deleteTrack(track.id);
    area.append(item); applyArtwork(item.querySelector('[data-art]'), track);
  });
}
function renderCollections(area, type) {
  const key = type === 'album' ? 'album' : type === 'artist' ? 'artist' : 'genre';
  const groups = new Map();
  tracks.forEach((track) => { const group = groups.get(track[key]) || []; group.push(track); groups.set(track[key], group); });
  const entries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  $('#librarySummary').textContent = `${entries.length} ${type}${entries.length === 1 ? '' : 's'}`;
  if (entries.length) hideEmptyState();
  else showEmptyState({ icon: type === 'album' ? '▣' : type === 'artist' ? '♙' : '⌁', title: `No ${type}s yet`, message: 'Add music with metadata and Zombie will organize it here.' });
  entries.forEach(([name, group]) => {
    const card = document.createElement('button'); card.className = 'collection-card';
    card.innerHTML = `<span class="collection-art art-${artVariant(group[0])}" data-art="${group[0].id}">Z</span><span><strong>${escapeHTML(name || 'Other')}</strong><small>${group.length} ${group.length === 1 ? 'song' : 'songs'}${type === 'album' ? ` · ${escapeHTML(group[0].artist)}` : ''}</small></span><b>›</b>`;
    card.onclick = () => { collectionFilter = { type, value: name }; currentView = 'songs'; render(); };
    area.append(card); applyArtwork(card.querySelector('[data-art]'), group[0]);
  });
}
function renderPlaylists(area) {
  const search = $('#searchInput').value.trim().toLowerCase(); const shownPlaylists = search ? playlists.filter((playlist) => `${playlist.name} ${playlist.note || ''}`.toLowerCase().includes(search)) : playlists;
  $('#librarySummary').textContent = `${shownPlaylists.length} ${shownPlaylists.length === 1 ? 'playlist' : 'playlists'}`;
  if (shownPlaylists.length) hideEmptyState();
  else showEmptyState({ icon: '☷', title: 'Create your first playlist', message: 'Build a local queue you can keep listening to offline.' });
  const actions = document.createElement('div'); actions.className = 'playlist-library-actions';
  const create = document.createElement('button'); create.className = 'create-playlist'; create.textContent = '+ Create playlist'; create.onclick = createPlaylist;
  const folder = document.createElement('button'); folder.className = 'secondary-button'; folder.textContent = '▣ New folder'; folder.onclick = createPlaylistFolder;
  actions.append(create, folder); area.append(actions);
  const appendPlaylistCard = (playlist) => {
    const card = document.createElement('article'); card.className = 'playlist-card';
    const playlistTracks = playlist.trackIds.map((id) => tracks.find((track) => track.id === id)).filter(Boolean);
    const cover = playlist.artworkId
      ? `<span class="collection-art art-${artVariant({title:playlist.name})}" data-playlist-art="${playlist.id}">Z</span>`
      : `<span class="collection-art playlist-collage">${playlistTracks.slice(0, 4).map((track) => `<i class="art-${artVariant(track)}" data-art="${track.id}">Z</i>`).join('') || '<i class="art-0">Z</i>'}</span>`;
    card.innerHTML = `<button class="playlist-open">${cover}<span><strong>${escapeHTML(playlist.name)}</strong><small>${playlistTracks.length} ${playlistTracks.length === 1 ? 'song' : 'songs'} · ${formatTotalDuration(playlistTracks.reduce((sum, track) => sum + (track.duration || 0), 0))}</small></span></button><button class="playlist-menu" aria-label="Playlist options">⋯</button>`;
    card.querySelector('.playlist-open').onclick = () => { activePlaylistId = playlist.id; render(); };
    card.querySelector('.playlist-menu').onclick = () => openPlaylistOptions(playlist.id);
    const host = area._playlistHost || area; host.append(card);
    if (playlist.artworkId) applyArtwork(card.querySelector('[data-playlist-art]'), { ...playlist, title: playlist.name });
    else playlistTracks.slice(0, 4).forEach((track) => applyArtwork(card.querySelector(`[data-art="${track.id}"]`), track));
  };
  const appendGroup = (label, group, folderId = '') => {
    if (!group.length) return;
    const section = document.createElement('section'); section.className = 'playlist-folder';
    section.innerHTML = `<header><span><strong>${escapeHTML(label)}</strong><small>${group.length} ${group.length === 1 ? 'playlist' : 'playlists'}</small></span>${folderId ? '<button class="playlist-folder-menu" aria-label="Folder options">⋯</button>' : ''}</header>`;
    if (folderId) section.querySelector('.playlist-folder-menu').onclick = () => openPlaylistFolderOptions(folderId);
    area.append(section); area._playlistHost = section;
    group.forEach(appendPlaylistCard);
    delete area._playlistHost;
  };
  playlistFolders.forEach((entry) => appendGroup(entry.name, shownPlaylists.filter((playlist) => playlist.folderId === entry.id), entry.id));
  const loose = shownPlaylists.filter((playlist) => !playlist.folderId || !playlistFolders.some((folder) => folder.id === playlist.folderId));
  appendGroup(playlistFolders.length ? 'Other playlists' : 'Your playlists', loose);
}
function renderPlaylistDetail(area) {
  const playlist = playlists.find((entry) => entry.id === activePlaylistId);
  if (!playlist) { activePlaylistId = null; render(); return; }
  const ids = playlist.trackIds.filter((id) => tracks.some((track) => track.id === id));
  const list = ids.map((id) => tracks.find((track) => track.id === id));
  $('#librarySummary').textContent = `${list.length} ${list.length === 1 ? 'song' : 'songs'}`;
  $('#emptyState').style.display = 'none';
  const hero = document.createElement('article'); hero.className = 'collection-context';
  const folder = playlistFolders.find((entry) => entry.id === playlist.folderId);
  hero.innerHTML = `<strong>${escapeHTML(playlist.name)}</strong><p>${list.length} ${list.length === 1 ? 'song' : 'songs'} · ${formatTotalDuration(list.reduce((total, track) => total + (track.duration || 0), 0))}</p><span class="collection-pill">${folder ? escapeHTML(folder.name) : 'LOCAL PLAYLIST'}</span><div class="playlist-note-slot">${playlist.note ? `<p>${escapeHTML(playlist.note)}</p><button data-playlist-note>✎ Edit note</button>` : '<button data-playlist-note>＋ Add a note</button>'}</div>`;
  hero.querySelector('[data-playlist-note]').onclick = () => openPlaylistNoteEditor(playlist.id);
  area.append(hero);
  const controls = document.createElement('div'); controls.className = 'playlist-controls';
  controls.innerHTML = '<button class="back-link">‹ Playlists</button><button class="primary-button">Play</button><button class="secondary-button">Shuffle</button><button class="secondary-button" data-playlist-sort>Sort</button><button class="secondary-button" data-smart-order>Smart order</button>';
  controls.querySelector('.back-link').onclick = () => { activePlaylistId = null; currentView = 'playlists'; render(); };
  controls.querySelector('.primary-button').onclick = () => { if (list.length) { shuffleOn = false; updatePlayerMode(); playTrack(list[0].id, ids); } else toast('This playlist is empty'); };
  controls.querySelector('.secondary-button').onclick = () => { if (list.length) { const first = list[Math.floor(Math.random() * list.length)]; shuffleOn = true; playTrack(first.id, ids, { reason: 'playlist-shuffle' }); updatePlayerMode(); } else toast('This playlist is empty'); };
  controls.querySelector('[data-playlist-sort]').onclick = () => openPlaylistSort(playlist.id);
  controls.querySelector('[data-smart-order]').onclick = () => { void smartOrderPlaylist(playlist.id); };
  area.append(controls); renderTrackList(area, list, playlist);
}

async function playTrack(id, sourceIds = null, options = {}) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return false;
  const previousTrack = tracks.find((entry) => entry.id === currentId);
  const resumePosition = id === currentId && !audio.src ? restoredPosition : 0;
  const token = ++loadToken;
  const oldUrl = pendingAudio?.url || currentUrl;
  if (pendingAudio) { playbackDebug('pending-transition-superseded', { previous: pendingAudio.previous, next: trackDebug(track) }); pendingAudio = null; }
  if (sourceIds?.length) {
    queue = uniquePlayableIds(sourceIds); queueIndex = queue.indexOf(id);
    if (shuffleOn) { shuffleBag = randomize(queue.filter((entry) => entry !== id)); shuffleHistory = []; }
  } else if (!queue.includes(id)) {
    queue = uniquePlayableIds(visibleTracks().map((entry) => entry.id)); queueIndex = queue.indexOf(id);
    if (shuffleOn) refillShuffleBag(id);
  } else queueIndex = queue.indexOf(id);
  if (currentId === id && audio.src) {
    if (audio.paused) {
      if (audio.ended) audio.currentTime = 0;
      try { const started = await requestAudioPlay(track, token, options.reason || 'toggle-current'); return started && confirmActualPlayback(track, token, options.reason || 'toggle-current'); } catch { toast("This audio file couldn't be played."); return false; }
    } else audio.pause();
    return true;
  }
  $('#miniPlayer').classList.remove('hidden'); $('#miniPlayer').classList.add('loading'); audio.pause();
  playbackDebug('transition-start', { reason: options.reason || 'manual', previous: trackDebug(previousTrack), next: trackDebug(track) });
  try {
    const preloaded = preparedNext?.id === id ? preparedNext : null;
    let nextUrl;
    if (preloaded) {
      preparedNext = null; nextUrl = preloaded.url;
      playbackDebug('next-preload-consumed', { previous: trackDebug(previousTrack), next: trackDebug(track), blobLoaded: true, objectUrlCreated: true, blobBytes: preloaded.blobBytes });
    } else {
      if (preparedNext) discardPreparedNext('different-track-selected');
      const blob = await getAudioBlob(id);
      if (token !== loadToken) { playbackDebug('transition-superseded', { next: trackDebug(track) }); return false; }
      if (!blob) { playbackDebug('blob-missing', { previous: trackDebug(previousTrack), next: trackDebug(track), blobLoaded: false }); toast('This song is missing from device storage'); return false; }
      playbackDebug('blob-loaded', { previous: trackDebug(previousTrack), next: trackDebug(track), blobLoaded: true, blobBytes: blob.size });
      nextUrl = URL.createObjectURL(blob);
      playbackDebug('object-url-created', { previous: trackDebug(previousTrack), next: trackDebug(track), blobLoaded: true, objectUrlCreated: true });
    }
    pendingAudio = { id, url: nextUrl, token, oldUrl, previous: trackDebug(previousTrack) };
    audio.src = nextUrl;
    if (resumePosition > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.min(resumePosition, Math.max(0, (audio.duration || resumePosition) - 0.05)); restoredPosition = 0; }, { once: true });
    else restoredPosition = 0;
    // Setting src starts loading. Calling load() here can reset a background iPhone audio pipeline, so play() is the readiness gate.
    playbackDebug('source-attached', { previous: trackDebug(previousTrack), next: trackDebug(track), blobLoaded: true, objectUrlCreated: true, readyGate: 'audio.play promise' });
    const started = await requestAudioPlay(track, token, options.reason || 'manual');
    if (token !== loadToken) return false;
    return started && confirmActualPlayback(track, token, options.reason || 'manual');
  } catch (error) {
    if (token === loadToken) {
      playbackDebug('transition-failed', { previous: trackDebug(previousTrack), next: trackDebug(track), transitionError: { name: error?.name || 'Error', message: error?.message || String(error) } });
      // Keep the prepared Blob source available for a later manual retry, but never report a rejected start as playback success.
      const prepared = commitPendingPlayback('play-rejected-prepared-source');
      if (prepared) {
        $('#playButton').textContent = '▶'; $('#miniPlay').textContent = '▶'; syncAmbientMotionState(); render();
      }
      setMediaPlaybackState('paused'); toast("This audio file couldn't be played.");
      return false;
    }
    return false;
  } finally {
    if (token === loadToken) $('#miniPlayer').classList.remove('loading');
  }
}
function showMiniPlayer(track) { $('#miniPlayer').classList.remove('hidden'); syncNowPlaying(track); }
function paintNowPlayingTrack(track, changed = false) {
  applyAmbientPalette(track); setMarqueeText('#nowTitle', track.title); $('#nowArtist').textContent = track.artist;
  applyArtwork($('#miniArt'), track); applyArtwork($('#npArt'), track); applyArtwork($('#npBackdrop'), track);
  $('#npEmoji').textContent = track.emoji; setMarqueeText('#npTitle', track.title); setMarqueeText('#npArtist', track.artist); $('#npAlbum').textContent = track.album || 'Single';
  $('#npFavorite').textContent = track.isFavorite ? '♥' : '♡'; $('#npFavorite').setAttribute('aria-pressed', String(track.isFavorite)); syncAmbientMotionState(); void syncNowPlayingVisual(track);
  if (changed) {
    ['#miniPlayer', '#nowPlayingScreen'].forEach((selector) => {
      const panel = $(selector); panel.classList.remove('track-leaving', 'song-changing', 'artwork-changing');
      requestAnimationFrame(() => panel.classList.add('song-changing', 'artwork-changing'));
    });
  }
}
function syncNowPlaying(track = tracks.find((entry) => entry.id === currentId)) {
  if (!track) return;
  const changed = Boolean(lastVisualTrackId && lastVisualTrackId !== track.id); lastVisualTrackId = track.id;
  const token = ++visualTransitionToken;
  if (changed) {
    $('#npSeek').value = 0; $('#npSeek').style.setProperty('--seek-progress', '0%'); $('#miniPlayer').style.setProperty('--mini-progress', '0%'); setWaveformProgress(0);
    ['#miniPlayer', '#nowPlayingScreen'].forEach((selector) => { const panel = $(selector); panel.classList.remove('song-changing', 'artwork-changing'); panel.classList.add('track-leaving'); });
    window.setTimeout(() => { if (token === visualTransitionToken) paintNowPlayingTrack(track, true); }, 92);
  } else paintNowPlayingTrack(track);
}
function togglePlayback() {
  if (!audio.src && currentId) { playTrack(currentId); return; }
  if (audio.paused) void resumeCurrentAudio('toggle-playback'); else audio.pause();
}
function openSleepTimer() {
  $('#sheetTitle').textContent = 'Sleep timer';
  const remaining = sleepTimerEndsAt ? Math.max(0, Math.ceil((sleepTimerEndsAt - Date.now()) / 60000)) : 0;
  $('#sheetContent').innerHTML = `<p class="sheet-note">Zombie will pause the current player when the timer finishes. Keep in mind iPhone may delay browser timers while an app is suspended.</p>${remaining ? `<p class="sheet-section">ACTIVE · ${remaining} MIN LEFT</p>` : ''}<button class="sheet-option" data-sleep="0">Turn off timer</button>${[15, 30, 45, 60].map((minutes) => `<button class="sheet-option" data-sleep="${minutes}">${minutes} minutes</button>`).join('')}`;
  $('#sheetContent').querySelectorAll('[data-sleep]').forEach((button) => { button.onclick = () => setSleepTimer(Number(button.dataset.sleep)); });
  showSheet();
}
function setSleepTimer(minutes) {
  clearTimeout(sleepTimerHandle); sleepTimerHandle = null; sleepTimerEndsAt = 0;
  if (!minutes) { closeSheet(); toast('Sleep timer off'); return; }
  sleepTimerEndsAt = Date.now() + (minutes * 60 * 1000);
  sleepTimerHandle = window.setTimeout(() => { sleepTimerHandle = null; sleepTimerEndsAt = 0; audio.pause(); toast('Sleep timer paused Zombie'); }, minutes * 60 * 1000);
  closeSheet(); toast(`Sleep timer: ${minutes} minutes`);
}
function uniquePlayableIds(ids) {
  const seen = new Set();
  return (Array.isArray(ids) ? ids : []).filter((id) => !seen.has(id) && tracks.some((track) => track.id === id) && (seen.add(id), true));
}
function reconcileShuffleState(reason = 'reconcile') {
  queue = uniquePlayableIds(queue);
  if (currentId && !queue.includes(currentId)) queue.unshift(currentId);
  queueIndex = currentId ? queue.indexOf(currentId) : -1;
  const history = uniquePlayableIds(shuffleHistory).filter((id) => id !== currentId);
  const historySet = new Set(history);
  const bag = uniquePlayableIds(shuffleBag).filter((id) => id !== currentId && !historySet.has(id));
  const known = new Set([currentId, ...history, ...bag]);
  // If an old session lost only part of its bag, restore just those missing upcoming songs.
  // A completed cycle has every item in history, so it remains completed until Repeat All is used.
  const missing = shuffleOn ? queue.filter((id) => !known.has(id)) : [];
  shuffleHistory = history;
  shuffleBag = [...bag, ...randomize(missing)];
  playbackDebug('shuffle-state-reconciled', { reason, queueLength: queue.length, bagLength: shuffleBag.length, historyLength: shuffleHistory.length, currentId });
}
function refillShuffleBag(excludeId = currentId) {
  queue = uniquePlayableIds(queue);
  shuffleHistory = [];
  shuffleBag = randomize(queue.filter((id) => id !== excludeId));
  playbackDebug('shuffle-cycle-created', { excludeId, queueLength: queue.length, bagLength: shuffleBag.length });
}
function setShuffleEnabled(enabled) {
  const next = Boolean(enabled);
  if (next === shuffleOn) return;
  shuffleOn = next;
  if (shuffleOn) refillShuffleBag(currentId);
  else { shuffleBag = []; shuffleHistory = []; queueIndex = currentId ? queue.indexOf(currentId) : queueIndex; }
  discardPreparedNext('shuffle-mode-changed'); saveQueueSession(); updatePlayerMode();
  toast(shuffleOn ? 'Shuffle on' : 'Shuffle off');
}
function nextQueueIdForPreload() {
  if (!queue.length) return null;
  if (shuffleOn) return shuffleBag[0] || null;
  const nextIndex = queueIndex + 1;
  if (nextIndex < queue.length) return queue[nextIndex];
  return repeatMode === 'all' ? queue[0] : null;
}
function discardPreparedNext(reason) {
  const prepared = preparedNext; preparedNext = null; preloadToken += 1;
  if (!prepared) return;
  if (prepared.url !== currentUrl && audio.src !== prepared.url && audio.currentSrc !== prepared.url) URL.revokeObjectURL(prepared.url);
  playbackDebug('next-preload-discarded', { reason, next: prepared.track });
}
async function prepareNextTrack() {
  const id = nextQueueIdForPreload();
  if (!id || id === currentId) { discardPreparedNext('no-upcoming-track'); return; }
  if (preparedNext?.id === id) return;
  discardPreparedNext('upcoming-track-changed');
  const token = ++preloadToken;
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  playbackDebug('next-preload-start', { next: trackDebug(track) });
  try {
    const blob = await getAudioBlob(id);
    if (token !== preloadToken || id !== nextQueueIdForPreload()) return;
    if (!blob) { playbackDebug('next-preload-blob-missing', { next: trackDebug(track), blobLoaded: false }); return; }
    const url = URL.createObjectURL(blob);
    if (token !== preloadToken || id !== nextQueueIdForPreload()) { URL.revokeObjectURL(url); return; }
    preparedNext = { id, url, track: trackDebug(track), blobBytes: blob.size };
    playbackDebug('next-preload-ready', { next: trackDebug(track), blobLoaded: true, objectUrlCreated: true, blobBytes: blob.size });
  } catch (error) { playbackDebug('next-preload-failed', { next: trackDebug(track), preloadError: { name: error?.name || 'Error', message: error?.message || String(error) } }); }
}
async function nextTrack(fromEnd = false) {
  if (!queue.length) return;
  const previousTrack = tracks.find((entry) => entry.id === currentId);
  if (fromEnd && repeatMode === 'one') { audio.currentTime = 0; playbackDebug('repeat-one', { previous: trackDebug(previousTrack) }); const started = await requestAudioPlay(previousTrack, loadToken, 'repeat-one'); return started && confirmActualPlayback(previousTrack, loadToken, 'repeat-one'); }
  const previousQueueState = { queueIndex, shuffleBag: [...shuffleBag], shuffleHistory: [...shuffleHistory] };
  let id;
  if (shuffleOn) {
    if (!shuffleBag.length && repeatMode === 'all') refillShuffleBag();
    if (!shuffleBag.length) {
      audio.pause(); audio.currentTime = 0; setMediaPlaybackState('paused');
      $('#playButton').textContent = '▶'; $('#miniPlay').textContent = '▶'; syncAmbientMotionState(); savePlayerState(true); render();
      playbackDebug('shuffle-queue-ended', { fromEnd, previous: trackDebug(previousTrack) });
      return false;
    }
    id = shuffleBag.shift(); if (currentId) shuffleHistory.push(currentId);
  } else {
    const nextIndex = queueIndex + 1;
    if (nextIndex < queue.length) { queueIndex = nextIndex; id = queue[queueIndex]; }
    else if (repeatMode === 'all') { queueIndex = 0; id = queue[0]; }
    else {
      audio.pause(); audio.currentTime = 0; setMediaPlaybackState('paused');
      $('#playButton').textContent = '▶'; $('#miniPlay').textContent = '▶'; syncAmbientMotionState(); savePlayerState(true); render();
      if (!fromEnd) toast('You are at the end of this queue');
      playbackDebug('queue-ended', { fromEnd, previous: trackDebug(previousTrack) });
      return false;
    }
  }
  if (!id) { playbackDebug('next-track-missing', { fromEnd, previous: trackDebug(previousTrack) }); return; }
  queueIndex = queue.indexOf(id); savePlayerState(true);
  playbackDebug('next-track-resolved', { fromEnd, previous: trackDebug(previousTrack), next: trackDebug(tracks.find((entry) => entry.id === id)) });
  const started = await playTrack(id, null, { reason: fromEnd ? 'ended' : 'next' });
  if (!started) {
    // A rejected next-song start may leave a valid, paused source ready for an explicit retry.
    // Keep that source and its queue position rather than restoring a stale completed song.
    if (currentId !== id) {
      queueIndex = previousQueueState.queueIndex; shuffleBag = previousQueueState.shuffleBag; shuffleHistory = previousQueueState.shuffleHistory; savePlayerState(true);
    }
    setMediaPlaybackState('paused');
    playbackDebug('next-track-not-started', { fromEnd, previous: trackDebug(previousTrack), next: trackDebug(tracks.find((entry) => entry.id === id)), preparedPausedSource: currentId === id });
  }
  return started;
}
async function advanceAfterEnded() {
  const finishedTrack = tracks.find((entry) => entry.id === currentId);
  const finishedSource = currentAudioSource();
  if (!finishedTrack || !audio.ended) { playbackDebug('ended-ignored-not-current', { previous: trackDebug(finishedTrack) }); return; }
  if (endedTransitionInFlight || lastHandledEndedEpoch === playbackEpoch) { playbackDebug('ended-ignored-duplicate', { previous: trackDebug(finishedTrack), playbackEpoch }); return; }
  lastHandledEndedEpoch = playbackEpoch;
  endedTransitionInFlight = true;
  try {
    playbackDebug('ended-transition-start', { previous: trackDebug(finishedTrack), finishedSource, playbackEpoch });
    await nextTrack(true);
  }
  catch (error) { playbackDebug('ended-transition-failed', { transitionError: { name: error?.name || 'Error', message: error?.message || String(error) } }); toast('Zombie could not start the next song'); }
  finally { endedTransitionInFlight = false; }
}
function reflectPausedPlayback(reason = 'paused') {
  setMediaPlaybackState('paused'); $('#playButton').textContent = '▶'; $('#miniPlay').textContent = '▶';
  syncAmbientMotionState(); savePlayerState(true); render();
  playbackDebug('playback-reflected-paused', { reason, next: trackDebug(tracks.find((entry) => entry.id === (pendingAudio?.id || currentId))) });
}
function reconcilePlaybackAfterForeground() {
  const track = tracks.find((entry) => entry.id === (pendingAudio?.id || currentId));
  const token = ++foregroundRecoveryToken;
  if (!track) return;
  if (audio.ended) {
    playbackDebug('foreground-ended-recovery', { previous: trackDebug(track) });
    void advanceAfterEnded();
    return;
  }
  const claimedPlaying = !audio.paused || navigator.mediaSession?.playbackState === 'playing';
  if (claimedPlaying && (audio.paused || !currentAudioSource() || Boolean(audio.error))) {
    playbackDebug('foreground-playing-state-corrected', { next: trackDebug(track), claimedPlaying });
    reflectPausedPlayback('foreground-state-mismatch');
    return;
  }
  if (audio.paused || audio.readyState < 2) return;
  const position = audio.currentTime;
  window.setTimeout(() => {
    if (token !== foregroundRecoveryToken || document.visibilityState !== 'visible' || audio.paused || audio.ended || currentId !== track.id) return;
    if (audio.currentTime <= position + .02) {
      playbackDebug('foreground-silent-state-corrected', { next: trackDebug(track), position });
      audio.pause(); reflectPausedPlayback('foreground-no-progress');
    }
  }, 1100);
}
async function previousTrack() {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (shuffleOn && shuffleHistory.length) { const id = shuffleHistory.pop(); if (currentId) shuffleBag.unshift(currentId); await playTrack(id); return; }
  if (!queue.length) return;
  if (queueIndex > 0) { queueIndex -= 1; await playTrack(queue[queueIndex]); }
  else if (repeatMode === 'all') { queueIndex = queue.length - 1; await playTrack(queue[queueIndex]); }
  else audio.currentTime = 0;
}
function updatePlayerMode() {
  $('#shuffleButton').classList.toggle('mode-active', shuffleOn);
  $('#repeatButton').classList.toggle('mode-active', repeatMode !== 'off');
  $('#repeatButton').textContent = repeatMode === 'one' ? '↻¹' : '↻';
  $('#repeatButton').setAttribute('aria-label', `Repeat ${repeatMode}`);
  savePlayerState(true);
}
function setMiniPlayerTransitionOrigin(screen) {
  const miniArt = $('#miniArt'), stage = $('#npArtStage'); if (!miniArt || !stage) return;
  const mini = miniArt.getBoundingClientRect(), full = stage.getBoundingClientRect(); if (!mini.width || !full.width) return;
  const x = (mini.left + (mini.width / 2)) - (full.left + (full.width / 2)); const y = (mini.top + (mini.height / 2)) - (full.top + (full.height / 2));
  screen.style.setProperty('--mini-origin-x', `${x}px`); screen.style.setProperty('--mini-origin-y', `${y}px`); screen.style.setProperty('--mini-origin-scale', String(Math.max(.1, Math.min(.32, mini.width / full.width))));
}
function openNowPlaying() {
  if (!currentId) return;
  clearTimeout(panelTimer); const screen = $('#nowPlayingScreen'), mini = $('#miniPlayer'); screen.classList.remove('hidden', 'closing'); screen.classList.add('from-mini');
  syncModalScrollLock();
  requestAnimationFrame(() => { setMiniPlayerTransitionOrigin(screen); requestAnimationFrame(() => { mini.classList.add('expanding'); screen.classList.add('presented'); syncNowPlaying(tracks.find((entry) => entry.id === currentId)); void syncNowPlayingVisual(); }); });
}
function closeNowPlaying() {
  const screen = $('#nowPlayingScreen'); if (screen.classList.contains('hidden')) return;
  stopNowPlayingVisual(); setMiniPlayerTransitionOrigin(screen);
  screen.classList.remove('presented'); screen.classList.add('closing'); clearTimeout(panelTimer);
  panelTimer = setTimeout(() => { screen.classList.add('hidden'); screen.classList.remove('closing', 'from-mini'); $('#miniPlayer').classList.remove('expanding'); syncModalScrollLock(); }, 360);
}
function syncModalScrollLock() { document.body.classList.toggle('zombie-modal-open', ['#nowPlayingScreen', '#lyricsScreen', '#sheet'].some((selector) => !$(selector).classList.contains('hidden'))); }
function showSheet() { clearTimeout(window.zombieSheetTimer); $('#sheetContent').scrollTop = 0; const sheet = $('#sheet'); sheet.classList.remove('hidden', 'closing'); syncModalScrollLock(); requestAnimationFrame(() => sheet.classList.add('shown')); }
function queueTrackMarkup(track, position, kind = 'upcoming') {
  const canMoveUp = position > 0;
  const state = kind === 'current' ? (audio.paused ? 'Ⅱ' : '▶') : String(position + 1).padStart(2, '0');
  const controls = kind === 'current' ? '' : `<div class="queue-row-actions"><button data-queue-move="up" data-queue-id="${track.id}" aria-label="Move ${escapeHTML(track.title)} earlier" ${canMoveUp ? '' : 'disabled'}>↑</button><button data-queue-move="down" data-queue-id="${track.id}" aria-label="Move ${escapeHTML(track.title)} later">↓</button><button data-queue-remove="${track.id}" aria-label="Remove ${escapeHTML(track.title)} from queue">×</button></div>`;
  return `<article class="queue-row ${kind === 'current' ? 'queue-current' : ''}"><button class="queue-jump" data-queue-jump="${track.id}" aria-label="Play ${escapeHTML(track.title)}"><span class="queue-state">${state}</span><span class="queue-row-art art-${artVariant(track)}" data-queue-art="${track.id}"></span><span class="queue-row-copy"><strong>${track.emoji} ${escapeHTML(track.title)}${kind === 'current' && !audio.paused ? '<span class="playing-bars" aria-label="Playing"><i></i><i></i><i></i></span>' : ''}</strong><small>${escapeHTML(track.artist)} · ${escapeHTML(track.album || 'Single')}</small></span></button>${controls}</article>`;
}
function currentQueueTrack() { return tracks.find((track) => track.id === currentId); }
function upcomingQueueIds() {
  const valid = (id) => id !== currentId && tracks.some((track) => track.id === id);
  return (shuffleOn ? shuffleBag : queue.slice(Math.max(0, queueIndex + 1))).filter(valid);
}
function queueArtworkInSheet() { document.querySelectorAll('#sheetContent [data-queue-art]').forEach((element) => applyArtwork(element, tracks.find((track) => track.id === element.dataset.queueArt))); }
function saveQueueSession() { savePlayerState(true); updatePlayerMode(); void prepareNextTrack(); }
function openQueue() {
  const currentTrack = currentQueueTrack();
  const upcoming = upcomingQueueIds().map((id) => tracks.find((track) => track.id === id)).filter(Boolean);
  $('#queueButton').classList.add('active'); $('#sheetTitle').textContent = 'Queue';
  $('#sheetContent').innerHTML = currentTrack ? `<div class="queue-summary"><span>${shuffleOn ? 'SHUFFLED ORDER' : 'PLAYBACK QUEUE'}</span><button id="clearUpcoming" ${upcoming.length ? '' : 'disabled'}>Clear upcoming</button></div><p class="sheet-section">NOW PLAYING</p>${queueTrackMarkup(currentTrack, 0, 'current')}${upcoming.length ? `<p class="sheet-section">UP NEXT</p>${queueTrackMarkup(upcoming[0], 0)}${upcoming.slice(1).length ? `<p class="sheet-section">REMAINING</p>${upcoming.slice(1).map((track, index) => queueTrackMarkup(track, index + 1)).join('')}` : ''}` : '<p class="sheet-note">No more songs are queued after this one.</p>'}` : '<p class="sheet-note">Choose a song to start a queue.</p>';
  queueArtworkInSheet();
  $('#clearUpcoming')?.addEventListener('click', clearUpcomingQueue);
  document.querySelectorAll('#sheetContent [data-queue-jump]').forEach((button) => { button.onclick = () => { closeSheet(); void playQueuedTrack(button.dataset.queueJump); }; });
  document.querySelectorAll('#sheetContent [data-queue-remove]').forEach((button) => { button.onclick = () => removeFromQueue(button.dataset.queueRemove); });
  document.querySelectorAll('#sheetContent [data-queue-move]').forEach((button) => { button.onclick = () => moveQueueItem(button.dataset.queueId, button.dataset.queueMove); });
  showSheet();
}
async function playQueuedTrack(id) {
  if (shuffleOn) {
    const position = shuffleBag.indexOf(id);
    if (position >= 0) { shuffleBag.splice(position, 1); if (currentId && currentId !== id) shuffleHistory.push(currentId); }
  }
  queueIndex = queue.indexOf(id); saveQueueSession();
  await playTrack(id, null, { reason: 'queue-jump' });
}
function moveQueueItem(id, direction) {
  const ids = shuffleOn ? shuffleBag : queue;
  const from = ids.indexOf(id); const minimum = shuffleOn ? 0 : queueIndex + 1;
  const to = direction === 'up' ? from - 1 : from + 1;
  if (from < minimum || to < minimum || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]]; saveQueueSession(); openQueue();
}
function removeFromQueue(id) {
  if (id === currentId) { toast('The current song stays in the queue'); return; }
  const removedIndex = queue.indexOf(id); queue = queue.filter((entry) => entry !== id); shuffleBag = shuffleBag.filter((entry) => entry !== id); shuffleHistory = shuffleHistory.filter((entry) => entry !== id);
  if (!shuffleOn && removedIndex >= 0 && removedIndex < queueIndex) queueIndex -= 1;
  saveQueueSession(); toast('Removed from queue'); openQueue();
}
function clearUpcomingQueue() {
  const count = upcomingQueueIds().length;
  if (!count || !confirm(`Clear ${count} upcoming ${count === 1 ? 'song' : 'songs'}? Your Library will not be changed.`)) return;
  queue = currentId ? [currentId] : []; queueIndex = currentId ? 0 : -1; shuffleBag = []; shuffleHistory = [];
  saveQueueSession(); toast('Upcoming queue cleared'); openQueue();
}
function addToQueue(trackId, playNext = false) {
  const track = tracks.find((entry) => entry.id === trackId); if (!track) return;
  if (!currentId) { void playTrack(trackId, [trackId], { reason: 'queue-start' }); toast('Started a new queue'); return; }
  if (trackId === currentId) { toast('That song is already playing'); return; }
  queue = queue.filter((id) => id !== trackId);
  const currentIndex = queue.indexOf(currentId); if (currentIndex < 0) { queue.unshift(currentId); queueIndex = 0; } else queueIndex = currentIndex;
  if (shuffleOn) { queue.push(trackId); shuffleBag = shuffleBag.filter((id) => id !== trackId); playNext ? shuffleBag.unshift(trackId) : shuffleBag.push(trackId); }
  else { queue.splice(playNext ? queueIndex + 1 : queue.length, 0, trackId); }
  saveQueueSession(); toast(playNext ? 'Will play next' : 'Added to the queue');
}

async function metadataFor(file) {
  const name = file.name.replace(/\.[^.]+$/, '').trim();
  const [possibleArtist, ...titleParts] = name.split(' - ');
  const hasArtist = titleParts.length > 0;
  let duration = 0;
  try {
    duration = await new Promise((resolve) => {
      const probe = document.createElement('audio'); const url = URL.createObjectURL(file);
      const cleanup = () => { URL.revokeObjectURL(url); probe.remove(); };
      probe.preload = 'metadata'; probe.onloadedmetadata = () => { const value = Number.isFinite(probe.duration) ? probe.duration : 0; cleanup(); resolve(value); };
      probe.onerror = () => { cleanup(); resolve(0); }; probe.src = url;
    });
  } catch { duration = 0; }
  return { title: hasArtist ? titleParts.join(' - ') : name || 'Untitled song', artist: neutralArtist(hasArtist ? possibleArtist : ''), album: 'Single', duration };
}
async function extractMp3Artwork(file) {
  if (!/^audio\/mpeg$/i.test(file.type) && !/\.mp3$/i.test(file.name)) return null;
  try {
    const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 8 * 1024 * 1024)).arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0, 3)) !== 'ID3') return null;
    const version = bytes[3], tagSize = ((bytes[6] & 127) << 21) | ((bytes[7] & 127) << 14) | ((bytes[8] & 127) << 7) | (bytes[9] & 127);
    let offset = 10;
    while (offset + 10 < Math.min(bytes.length, tagSize + 10)) {
      const id = String.fromCharCode(...bytes.slice(offset, offset + 4));
      const size = version === 4 ? ((bytes[offset + 4] & 127) << 21) | ((bytes[offset + 5] & 127) << 14) | ((bytes[offset + 6] & 127) << 7) | (bytes[offset + 7] & 127) : (bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7];
      if (!id || !size || size < 0) break;
      if (id === 'APIC') { let p = offset + 10 + 1; const mimeEnd = bytes.indexOf(0, p); if (mimeEnd < p) return null; const mime = new TextDecoder().decode(bytes.slice(p, mimeEnd)) || 'image/jpeg'; p = mimeEnd + 2; const descEnd = bytes.indexOf(0, p); p = descEnd >= p ? descEnd + 1 : p; return new Blob([bytes.slice(p, offset + 10 + size)], { type: mime }); }
      offset += 10 + size;
    }
  } catch { /* artwork is optional */ }
  return null;
}
function decodeId3Text(bytes, encoding = 3) {
  try { return new TextDecoder(encoding === 0 ? 'iso-8859-1' : encoding === 1 || encoding === 2 ? 'utf-16' : 'utf-8').decode(bytes).replace(/\u0000/g, '').trim(); } catch { return ''; }
}
function id3Terminator(bytes, start, encoding) {
  if (encoding === 0 || encoding === 3) return bytes.indexOf(0, start);
  for (let index = start; index + 1 < bytes.length; index += 2) if (bytes[index] === 0 && bytes[index + 1] === 0) return index;
  return -1;
}
async function extractEmbeddedLyrics(file) {
  if (!/^audio\/mpeg$/i.test(file.type) && !/\.mp3$/i.test(file.name)) return null;
  try {
    const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 8 * 1024 * 1024)).arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0, 3)) !== 'ID3') return null;
    const version = bytes[3], tagSize = ((bytes[6] & 127) << 21) | ((bytes[7] & 127) << 14) | ((bytes[8] & 127) << 7) | (bytes[9] & 127);
    let offset = 10;
    while (offset + 10 < Math.min(bytes.length, tagSize + 10)) {
      const id = String.fromCharCode(...bytes.slice(offset, offset + 4));
      const size = version === 4 ? ((bytes[offset + 4] & 127) << 21) | ((bytes[offset + 5] & 127) << 14) | ((bytes[offset + 6] & 127) << 7) | (bytes[offset + 7] & 127) : (bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7];
      if (!id || !size || size < 0 || offset + 10 + size > bytes.length) break;
      const frame = bytes.slice(offset + 10, offset + 10 + size);
      if (id === 'USLT' && frame.length > 5) {
        const encoding = frame[0]; const end = id3Terminator(frame, 4, encoding); const lyricStart = end < 0 ? 4 : end + (encoding === 0 || encoding === 3 ? 1 : 2);
        const lyrics = decodeId3Text(frame.slice(lyricStart), encoding); if (lyrics) return { lyrics, syncedLyrics: [] };
      }
      if (id === 'SYLT' && frame.length > 8) {
        const encoding = frame[0]; let cursor = id3Terminator(frame, 6, encoding); cursor = cursor < 0 ? 6 : cursor + (encoding === 0 || encoding === 3 ? 1 : 2);
        const syncedLyrics = [];
        while (cursor < frame.length - 5) {
          const end = id3Terminator(frame, cursor, encoding); if (end < cursor || end + 4 >= frame.length) break;
          const text = decodeId3Text(frame.slice(cursor, end), encoding); const timeOffset = end + (encoding === 0 || encoding === 3 ? 1 : 2); const stamp = (frame[timeOffset] * 16777216) + (frame[timeOffset + 1] * 65536) + (frame[timeOffset + 2] * 256) + frame[timeOffset + 3];
          if (text && Number.isFinite(stamp)) syncedLyrics.push({ time: stamp / 1000, text });
          cursor = end + (encoding === 0 || encoding === 3 ? 5 : 6);
        }
        if (syncedLyrics.length) return { lyrics: '', syncedLyrics };
      }
      offset += 10 + size;
    }
  } catch { /* Embedded lyric formats are optional; local pasted and LRC lyrics remain available. */ }
  return null;
}
async function importFiles(fileList) {
  const files = [...fileList].filter((file) => file.type.startsWith('audio/') || file.type.startsWith('video/') || SUPPORTED_FILES.test(file.name));
  if (!files.length) { toast('Choose an MP3, M4A, AAC, WAV, or recording'); return; }
  navigator.storage?.persist?.().catch(() => {});
  let saved = 0, skipped = 0;
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]; showProgress(`Saving ${index + 1} of ${files.length}`, file.name);
      const fingerprint = `${file.name}|${file.size}|${file.lastModified}`;
      if (tracks.some((track) => track.fingerprint === fingerprint)) { skipped += 1; continue; }
      const metadata = await metadataFor(file); const embeddedLyrics = await extractEmbeddedLyrics(file);
      const track = { id: crypto.randomUUID(), ...metadata, fileName: file.name, type: file.type || 'audio/mpeg', size: file.size, fingerprint, emoji: randomEmoji(), isFavorite: false, genre: '', lyrics: embeddedLyrics?.lyrics || '', syncedLyrics: embeddedLyrics?.syncedLyrics || [], playCount: 0, addedAt: Date.now(), blobStored: true };
      await saveTrack(track, file); tracks.unshift(track); saved += 1;
      const embeddedArtwork = await extractMp3Artwork(file); if (embeddedArtwork) { track.artworkId = `track:${track.id}`; await saveArtwork(track.artworkId, embeddedArtwork); await saveRecord('tracks', track); }
    }
    render(); await refreshStorageStatus();
    toast(saved ? `${saved} ${saved === 1 ? 'song' : 'songs'} saved on this iPhone${skipped ? ` · ${skipped} duplicate skipped` : ''}` : 'Those songs are already in Zombie');
  } catch (error) {
    const quota = error?.name === 'QuotaExceededError';
    toast(quota ? 'Not enough iPhone storage to save that music' : 'Zombie could not save one of those files');
  } finally { hideProgress(); }
}

async function toggleFavorite(id) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  track.isFavorite = !track.isFavorite; await saveRecord('tracks', track); replayVisualClass($('#npFavorite'), 'favorite-pop'); syncNowPlaying(); render();
}
async function deleteTrack(id) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  if (!confirm(`Delete “${track.title}” from this iPhone?`)) return;
  if (id === currentId) { stopNowPlayingVisual(); audio.pause(); audio.removeAttribute('src'); audio.load(); if (currentUrl) URL.revokeObjectURL(currentUrl); currentUrl = null; currentId = null; $('#miniPlayer').classList.add('hidden'); }
  const transaction = db.transaction(['tracks', 'audioBlobs', 'artworkBlobs'], 'readwrite'); transaction.objectStore('tracks').delete(id); transaction.objectStore('audioBlobs').delete(id); transaction.objectStore('artworkBlobs').delete(track.artworkId || `track:${id}`); transaction.objectStore('artworkBlobs').delete(track.visualId || `visual:${id}`);
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
  tracks = tracks.filter((entry) => entry.id !== id); queue = queue.filter((entry) => entry !== id);
  for (const playlist of playlists) { playlist.trackIds = playlist.trackIds.filter((entry) => entry !== id); await saveRecord('playlists', playlist); }
  render(); refreshStorageStatus(); toast('Removed from this device');
}

async function createPlaylist() {
  const name = prompt('Name your playlist'); if (!name?.trim()) return;
  const playlist = { id: crypto.randomUUID(), name: name.trim(), trackIds: [], createdAt: Date.now(), updatedAt: Date.now() };
  await saveRecord('playlists', playlist); playlists.push(playlist); render(); toast('Playlist created');
}
async function savePlaylist(playlist) { playlist.updatedAt = Date.now(); await saveRecord('playlists', playlist); playlists = playlists.map((entry) => entry.id === playlist.id ? playlist : entry); }
async function savePlaylistFolders() { await saveRecord('settings', { key: 'playlistFolders', folders: playlistFolders }); }
async function createPlaylistFolder() {
  const name = prompt('Name your playlist folder'); if (!name?.trim()) return;
  playlistFolders.push({ id: `folder:${crypto.randomUUID()}`, name: name.trim().slice(0, 80), createdAt: Date.now() });
  await savePlaylistFolders(); render(); toast('Playlist folder created');
}
function openPlaylistFolderPicker(id) {
  const playlist = playlists.find((entry) => entry.id === id); if (!playlist) return;
  $('#sheetTitle').textContent = 'Move playlist';
  $('#sheetContent').innerHTML = `<p class="sheet-note">Choose where “${escapeHTML(playlist.name)}” belongs.</p><button class="sheet-option" data-folder="">${playlist.folderId ? 'No folder' : '✓ No folder'}</button>${playlistFolders.map((folder) => `<button class="sheet-option" data-folder="${escapeHTML(folder.id)}">${playlist.folderId === folder.id ? '✓ ' : ''}${escapeHTML(folder.name)}</button>`).join('')}`;
  $('#sheetContent').querySelectorAll('[data-folder]').forEach((button) => {
    button.onclick = async () => { playlist.folderId = button.dataset.folder || ''; await savePlaylist(playlist); closeSheet(); render(); toast(playlist.folderId ? 'Playlist moved to folder' : 'Playlist removed from folder'); };
  });
  showSheet();
}
function openPlaylistFolderOptions(id) {
  const folder = playlistFolders.find((entry) => entry.id === id); if (!folder) return;
  $('#sheetTitle').textContent = folder.name;
  $('#sheetContent').innerHTML = '<button class="sheet-option" data-folder-option="rename">Rename folder</button><button class="sheet-option danger-text" data-folder-option="delete">Delete folder</button>';
  $('#sheetContent').querySelector('[data-folder-option="rename"]').onclick = async () => {
    const name = prompt('New folder name', folder.name); if (name?.trim()) { folder.name = name.trim().slice(0, 80); await savePlaylistFolders(); render(); } closeSheet();
  };
  $('#sheetContent').querySelector('[data-folder-option="delete"]').onclick = async () => {
    if (confirm(`Delete folder “${folder.name}”? Its playlists will stay in Zombie.`)) {
      for (const playlist of playlists.filter((entry) => entry.folderId === id)) { playlist.folderId = ''; await savePlaylist(playlist); }
      playlistFolders = playlistFolders.filter((entry) => entry.id !== id); await savePlaylistFolders(); render(); toast('Folder deleted; playlists were kept');
    }
    closeSheet();
  };
  showSheet();
}
function openPlaylistNoteEditor(id) {
  const playlist = playlists.find((entry) => entry.id === id); if (!playlist) return;
  $('#sheetTitle').textContent = 'Playlist note';
  $('#sheetContent').innerHTML = `<label class="edit-field">A private note for this playlist<textarea id="playlistNote" maxlength="1200" placeholder="Mood, memory, reminder…">${escapeHTML(playlist.note || '')}</textarea></label><button class="sheet-option" id="savePlaylistNote">Save note</button>${playlist.note ? '<button class="sheet-option danger-text" id="deletePlaylistNote">Delete note</button>' : ''}`;
  $('#savePlaylistNote').onclick = async () => { playlist.note = $('#playlistNote').value.trim(); await savePlaylist(playlist); closeSheet(); render(); toast(playlist.note ? 'Playlist note saved' : 'Playlist note cleared'); };
  $('#deletePlaylistNote')?.addEventListener('click', async () => { delete playlist.note; await savePlaylist(playlist); closeSheet(); render(); toast('Playlist note deleted'); });
  showSheet();
}
function openPlaylistSort(id) {
  const playlist = playlists.find((entry) => entry.id === id); if (!playlist) return;
  $('#sheetTitle').textContent = 'Sort playlist';
  $('#sheetContent').innerHTML = '<p class="sheet-note">This changes the playlist’s saved order. It does not change your music library.</p><button class="sheet-option" data-playlist-sort="title">Title A–Z</button><button class="sheet-option" data-playlist-sort="artist">Artist A–Z</button><button class="sheet-option" data-playlist-sort="album">Album A–Z</button><button class="sheet-option" data-playlist-sort="recent">Recently added</button><button class="sheet-option" data-playlist-sort="oldest">Oldest added</button><button class="sheet-option" data-playlist-sort="duration">Duration</button>';
  $('#sheetContent').querySelectorAll('[data-playlist-sort]').forEach((button) => { button.onclick = () => { void sortPlaylistTracks(id, button.dataset.playlistSort); }; });
  showSheet();
}
async function sortPlaylistTracks(id, mode) {
  const playlist = playlists.find((entry) => entry.id === id); if (!playlist) return;
  const compare = (a, b) => {
    if (mode === 'recent') return (b.addedAt || 0) - (a.addedAt || 0);
    if (mode === 'oldest') return (a.addedAt || 0) - (b.addedAt || 0);
    if (mode === 'duration') return (b.duration || 0) - (a.duration || 0);
    return String(a[mode] || '').localeCompare(String(b[mode] || ''), undefined, { sensitivity: 'base', numeric: true });
  };
  playlist.trackIds = playlist.trackIds.map((trackId) => tracks.find((track) => track.id === trackId)).filter(Boolean).sort(compare).map((track) => track.id);
  await savePlaylist(playlist); closeSheet(); render(); toast('Playlist sorted');
}
async function smartOrderPlaylist(id) {
  const playlist = playlists.find((entry) => entry.id === id); if (!playlist) return;
  const remaining = playlist.trackIds.map((trackId) => tracks.find((track) => track.id === trackId)).filter(Boolean);
  const ordered = []; let last = null;
  while (remaining.length) {
    const preferred = remaining.filter((track) => !last || (track.artist !== last.artist && track.album !== last.album));
    const relaxed = preferred.length ? preferred : remaining.filter((track) => !last || track.artist !== last.artist);
    const choices = relaxed.length ? relaxed : remaining;
    const next = choices[Math.floor(Math.random() * choices.length)];
    ordered.push(next.id); remaining.splice(remaining.indexOf(next), 1); last = next;
  }
  playlist.trackIds = ordered; await savePlaylist(playlist); render(); toast('Smart order saved');
}
function openPlaylistSheet(trackId) {
  const track = tracks.find((entry) => entry.id === trackId); if (!track) return;
  $('#sheetTitle').textContent = `Add “${track.title}” to playlist`;
  const content = $('#sheetContent'); content.innerHTML = '';
  const create = document.createElement('button'); create.className = 'sheet-option'; create.textContent = '+ New playlist'; create.onclick = async () => { await createPlaylist(); openPlaylistSheet(trackId); }; content.append(create);
  if (!playlists.length) content.insertAdjacentHTML('beforeend', '<p class="sheet-note">Create a playlist to start organizing music.</p>');
  playlists.forEach((playlist) => { const button = document.createElement('button'); button.className = 'sheet-option'; button.textContent = playlist.trackIds.includes(trackId) ? `✓ ${playlist.name}` : playlist.name; button.onclick = () => addToPlaylist(playlist.id, trackId); content.append(button); });
  showSheet();
}
async function addToPlaylist(playlistId, trackId) {
  const playlist = playlists.find((entry) => entry.id === playlistId); if (!playlist) return;
  if (playlist.trackIds.includes(trackId)) { playlist.trackIds = playlist.trackIds.filter((id) => id !== trackId); await savePlaylist(playlist); closeSheet(); toast(`Removed from ${playlist.name}`); return; }
  playlist.trackIds.push(trackId); await savePlaylist(playlist); closeSheet(); toast(`Added to ${playlist.name}`);
}
function openPlaylistOptions(id) {
  const playlist = playlists.find((entry) => entry.id === id); if (!playlist) return;
  $('#sheetTitle').textContent = playlist.name; $('#sheetContent').innerHTML = `<button class="sheet-option" data-option="cover">Choose playlist cover</button><button class="sheet-option" data-option="rename">Rename playlist</button><button class="sheet-option" data-option="note">${playlist.note ? 'Edit playlist note' : 'Add playlist note'}</button><button class="sheet-option" data-option="folder">${playlist.folderId ? 'Move to another folder' : 'Add to folder'}</button><button class="sheet-option" data-option="exclude">${playlist.excludeFromRecommendations ? '✓ Include in future recommendations' : '⊘ Exclude from future recommendations'}</button><button class="sheet-option danger-text" data-option="delete">Delete playlist</button>`;
  $('#sheetContent').querySelector('[data-option="cover"]').onclick = () => { artTarget = { type: 'playlist', id }; $('#artInput').click(); };
  $('#sheetContent').querySelector('[data-option="rename"]').onclick = async () => { const name = prompt('New playlist name', playlist.name); if (name?.trim()) { playlist.name = name.trim(); await savePlaylist(playlist); render(); } closeSheet(); };
  $('#sheetContent').querySelector('[data-option="note"]').onclick = () => openPlaylistNoteEditor(id);
  $('#sheetContent').querySelector('[data-option="folder"]').onclick = () => openPlaylistFolderPicker(id);
  $('#sheetContent').querySelector('[data-option="exclude"]').onclick = async () => { playlist.excludeFromRecommendations = !playlist.excludeFromRecommendations; await savePlaylist(playlist); closeSheet(); toast(playlist.excludeFromRecommendations ? 'Excluded from future recommendations' : 'Included in future recommendations'); };
  $('#sheetContent').querySelector('[data-option="delete"]').onclick = async () => { if (confirm(`Delete playlist “${playlist.name}”? Songs will stay on your iPhone.`)) { await deleteRecord('playlists', id); playlists = playlists.filter((entry) => entry.id !== id); if (activePlaylistId === id) activePlaylistId = null; render(); } closeSheet(); };
  showSheet();
}
async function removeFromPlaylist(playlistId, trackId) { const playlist = playlists.find((entry) => entry.id === playlistId); if (!playlist) return; playlist.trackIds = playlist.trackIds.filter((entry) => entry !== trackId); await savePlaylist(playlist); render(); }
async function reorderPlaylist(playlistId, from, to) { const playlist = playlists.find((entry) => entry.id === playlistId); if (!playlist || from < 0 || to < 0 || to >= playlist.trackIds.length || from === to) return; const [moved] = playlist.trackIds.splice(from, 1); playlist.trackIds.splice(to, 0, moved); await savePlaylist(playlist); render(); }
function closeSheet() {
  const sheet = $('#sheet'); if (sheet.classList.contains('hidden')) return;
  sheet.classList.remove('shown'); sheet.classList.add('closing'); $('.player-tools .queue-button.active:not(#visualButton)')?.classList.remove('active'); clearTimeout(window.zombieSheetTimer);
  window.zombieSheetTimer = setTimeout(() => { sheet.classList.add('hidden'); sheet.classList.remove('closing'); syncModalScrollLock(); }, 180);
}

function openSongOptions(id) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  $('#sheetTitle').textContent = track.title;
  $('#sheetContent').innerHTML = `<div class="sheet-song-header"><span class="sheet-song-art art-${artVariant(track)}" data-sheet-art="${track.id}"></span><span><strong>${track.emoji} ${escapeHTML(track.title)}</strong><small>${escapeHTML(track.artist)} · ${escapeHTML(track.album || 'Single')}</small></span></div><p class="sheet-section">SONG</p><button class="sheet-option" data-action="favorite">${track.isFavorite ? '♥ Remove from favorites' : '♡ Add to favorites'}</button><button class="sheet-option" data-action="play-next">Play next</button><button class="sheet-option" data-action="queue">Add to queue</button><button class="sheet-option" data-action="playlist">Add or remove from playlist</button><button class="sheet-option" data-action="lyrics">≡ Lyrics</button><button class="sheet-option" data-action="exclude">${track.excludeFromRecommendations ? '✓ Include in future recommendations' : '⊘ Exclude from future recommendations'}</button><p class="sheet-section">EDIT</p><button class="sheet-option" data-action="edit">Edit song information</button><button class="sheet-option" data-action="artwork">Change artwork</button><button class="sheet-option" data-action="visual">${track.visualId ? '◇ Replace animated visual' : '◇ Add animated visual'}</button>${track.visualId ? '<button class="sheet-option" data-action="remove-visual">Remove animated visual</button>' : ''}<button class="sheet-option" data-action="details">Song details</button><p class="sheet-section">BROWSE</p><button class="sheet-option" data-action="album">Go to album</button><button class="sheet-option" data-action="artist">Go to artist</button><button class="sheet-option" data-action="share">Share local file</button><p class="sheet-section">DEVICE</p><button class="sheet-option danger-text" data-action="delete">Delete song from this iPhone</button>`;
  applyArtwork($('#sheetContent [data-sheet-art]'), track);
  $('#sheetContent').querySelector('[data-action="favorite"]').onclick = async () => { await toggleFavorite(id); closeSheet(); };
  $('#sheetContent').querySelector('[data-action="play-next"]').onclick = () => { addToQueue(id, true); closeSheet(); };
  $('#sheetContent').querySelector('[data-action="queue"]').onclick = () => { addToQueue(id); closeSheet(); };
  $('#sheetContent').querySelector('[data-action="playlist"]').onclick = () => openPlaylistSheet(id);
  $('#sheetContent').querySelector('[data-action="lyrics"]').onclick = () => { closeSheet(); openLyrics(id); };
  $('#sheetContent').querySelector('[data-action="exclude"]').onclick = async () => { track.excludeFromRecommendations = !track.excludeFromRecommendations; await saveRecord('tracks', track); closeSheet(); render(); toast(track.excludeFromRecommendations ? 'Excluded from future recommendations' : 'Included in future recommendations'); };
  $('#sheetContent').querySelector('[data-action="edit"]').onclick = () => openSongEditor(id);
  $('#sheetContent').querySelector('[data-action="artwork"]').onclick = () => { artTarget = { type: 'track', id }; closeSheet(); $('#artInput').click(); };
  $('#sheetContent').querySelector('[data-action="visual"]').onclick = () => { visualTarget = id; closeSheet(); $('#visualInput').click(); };
  $('#sheetContent').querySelector('[data-action="remove-visual"]')?.addEventListener('click', async () => { await removeTrackVisual(track); closeSheet(); render(); toast('Animated visual removed'); });
  $('#sheetContent').querySelector('[data-action="details"]').onclick = () => openSongDetails(id);
  $('#sheetContent').querySelector('[data-action="album"]').onclick = () => goToCollection('album', track.album || 'Single');
  $('#sheetContent').querySelector('[data-action="artist"]').onclick = () => goToCollection('artist', track.artist || 'Unknown artist');
  $('#sheetContent').querySelector('[data-action="share"]').onclick = () => { void shareTrack(track); };
  $('#sheetContent').querySelector('[data-action="delete"]').onclick = () => { closeSheet(); deleteTrack(id); };
  showSheet();
}
function goToCollection(type, value) {
  currentView = 'songs'; activePlaylistId = null; collectionFilter = { type, value }; closeSheet(); render();
}
async function shareTrack(track) {
  try {
    const blob = await getAudioBlob(track.id);
    if (!blob) { toast('This local file is missing from Zombie'); return; }
    const safeName = (track.fileName || `${track.title}.mp3`).replace(/[\\/:*?"<>|]+/g, '-');
    const file = new File([blob], safeName, { type: blob.type || track.type || 'audio/mpeg' });
    const payload = { title: track.title, text: `${track.artist} · ${track.album || 'Single'}`, files: [file] };
    if (!navigator.share || (navigator.canShare && !navigator.canShare({ files: [file] }))) { toast('Sharing local files is unavailable in this browser'); return; }
    await navigator.share(payload);
  } catch (error) { if (error?.name !== 'AbortError') toast('Zombie could not share that local file'); }
}
function openSongDetails(id) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  $('#sheetTitle').textContent = 'Song information';
  const fileType = (track.type || track.fileName?.split('.').pop() || 'Audio').replace(/^audio\//i, '').toUpperCase();
  $('#sheetContent').innerHTML = `<dl class="song-details"><dt>Title</dt><dd>${escapeHTML(track.title)}</dd><dt>Artist</dt><dd>${escapeHTML(track.artist)}</dd><dt>Album</dt><dd>${escapeHTML(track.album)}</dd><dt>Genre</dt><dd>${escapeHTML(track.genre || 'Not set')}</dd><dt>Duration</dt><dd>${formatTime(track.duration)}</dd><dt>Added</dt><dd>${new Date(track.addedAt).toLocaleDateString(undefined,{day:'numeric',month:'long',year:'numeric'})}</dd><dt>Last played</dt><dd>${track.lastPlayed ? new Date(track.lastPlayed).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}) : 'Not played yet'}</dd><dt>Plays</dt><dd>${track.playCount || 0}</dd><dt>File</dt><dd>${escapeHTML(track.fileName || track.title)}</dd><dt>Type</dt><dd>${escapeHTML(fileType)}</dd><dt>Size</dt><dd>${formatBytes(track.size || 0)}</dd>${track.note ? `<dt>Note</dt><dd>${escapeHTML(track.note)}</dd>` : ''}</dl><button class="sheet-option" id="editFromDetails">Edit song</button>`;
  $('#editFromDetails').onclick = () => openSongEditor(id); showSheet();
}
function openSongEditor(id) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  $('#sheetTitle').textContent = 'Edit song';
  $('#sheetContent').innerHTML = `<label class="edit-field">Title<input id="editTitle" value="${escapeHTML(track.title)}"></label><label class="edit-field">Artist<input id="editArtist" value="${escapeHTML(track.artist)}"></label><label class="edit-field">Album<input id="editAlbum" value="${escapeHTML(track.album)}"></label><label class="edit-field">Emoji<input id="editEmoji" value="${escapeHTML(track.emoji)}" maxlength="8"></label><label class="edit-field">Genre<input id="editGenre" list="genreChoices" value="${escapeHTML(track.genre || '')}" placeholder="Optional genre"></label><label class="edit-field">Personal note<textarea id="editNote" maxlength="1200" placeholder="Optional private note about this song">${escapeHTML(track.note || '')}</textarea></label><datalist id="genreChoices"><option>Hip-Hop</option><option>R&B</option><option>Pop</option><option>Rock</option><option>Rap</option><option>Indie</option><option>Electronic</option><option>Reggae</option><option>Soul</option><option>Other</option></datalist><button class="sheet-option" id="chooseTrackArt">Choose artwork from Photos</button>${track.artworkId ? '<button class="sheet-option" id="removeTrackArt">Remove artwork</button>' : ''}<button class="sheet-option" id="saveSongEdit">Save changes</button>`;
  $('#chooseTrackArt').onclick = () => { artTarget = { type: 'track', id }; $('#artInput').click(); };
  if ($('#removeTrackArt')) $('#removeTrackArt').onclick = async () => { await removeTrackArtwork(track); render(); syncNowPlaying(); closeSheet(); toast('Artwork removed'); };
  $('#saveSongEdit').onclick = async () => { track.title = $('#editTitle').value.trim() || 'Untitled song'; track.artist = neutralArtist($('#editArtist').value); track.album = $('#editAlbum').value.trim() || 'Single'; track.emoji = $('#editEmoji').value.trim() || randomEmoji(); track.genre = $('#editGenre').value.trim(); track.note = $('#editNote').value.trim(); await saveRecord('tracks', track); render(); syncNowPlaying(); updateMediaSession(track); closeSheet(); toast('Song details saved'); };
  showSheet();
}
async function removeTrackArtwork(track) {
  if (!track?.artworkId) return;
  const id = track.artworkId, url = artworkUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  artworkUrls.delete(id); await deleteRecord('artworkBlobs', id); delete track.artworkId; await saveRecord('tracks', track);
}
async function saveSelectedArtwork(file) {
  if (!file || !artTarget) return;
  try {
    showProgress('Saving artwork', file.name);
    const id = `${artTarget.type}:${artTarget.id}`; await saveArtwork(id, file);
    if (artTarget.type === 'track') { const track = tracks.find((entry) => entry.id === artTarget.id); if (track) { track.artworkId = id; await saveRecord('tracks', track); syncNowPlaying(); } }
    else { const playlist = playlists.find((entry) => entry.id === artTarget.id); if (playlist) { playlist.artworkId = id; await savePlaylist(playlist); } }
    render(); toast('Artwork saved offline');
  } catch { toast('Zombie could not save that artwork'); } finally { hideProgress(); artTarget = null; }
}

async function refreshStorageStatus() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    const usage = estimate?.usage || tracks.reduce((sum, track) => sum + (track.size || 0), 0);
    $('#storageStatus').textContent = `${formatBytes(usage)} used`;
    const persisted = await navigator.storage?.persisted?.();
    $('#persistenceStatus').textContent = persisted ? 'Storage protection is enabled.' : 'Ask iPhone to protect this library from cleanup.';
  } catch { $('#storageStatus').textContent = `${formatBytes(tracks.reduce((sum, track) => sum + (track.size || 0), 0))} used`; }
  refreshLibraryStats();
}
function refreshLibraryStats() {
  const favorites = tracks.filter((track) => track.isFavorite).length;
  $('#libraryStats').innerHTML = `<span class="library-stat"><strong>${tracks.length}</strong><small>${tracks.length === 1 ? 'Song' : 'Songs'}</small></span><span class="library-stat"><strong>${favorites}</strong><small>${favorites === 1 ? 'Favorite' : 'Favorites'}</small></span><span class="library-stat"><strong>${playlists.length}</strong><small>${playlists.length === 1 ? 'Playlist' : 'Playlists'}</small></span>`;
}
async function requestPersistentStorage() {
  try { const granted = await navigator.storage?.persist?.(); await refreshStorageStatus(); toast(granted ? 'Zombie storage is protected' : 'iPhone manages storage automatically'); } catch { toast('Storage protection is unavailable here'); }
}
async function clearAllMusic() {
  if (!confirm('Clear every song, favorite, and playlist from this iPhone? This cannot be undone.')) return;
  const transaction = db.transaction(['tracks', 'audioBlobs', 'playlists', 'artworkBlobs', 'settings'], 'readwrite');
  ['tracks', 'audioBlobs', 'playlists', 'artworkBlobs'].forEach((name) => transaction.objectStore(name).clear());
  transaction.objectStore('settings').delete('playlistFolders');
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
  audio.pause(); audio.removeAttribute('src'); audio.load(); if (currentUrl) URL.revokeObjectURL(currentUrl);
  tracks = []; playlists = []; playlistFolders = []; queue = []; currentId = null; currentUrl = null; activePlaylistId = null; $('#miniPlayer').classList.add('hidden'); render(); refreshStorageStatus(); toast('All music cleared from this device');
}

function wireUI() {
  buildDecorativeWaveform();
  $('#importButton').onclick = () => $('#fileInput').click(); $('#chooseFiles').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (event) => { importFiles(event.target.files); event.target.value = ''; };
  $('#artInput').onchange = (event) => { saveSelectedArtwork(event.target.files?.[0]); event.target.value = ''; };
  $('#lyricsInput').onchange = (event) => { importLyricsFile(event.target.files?.[0]); event.target.value = ''; };
  $('#visualInput').onchange = (event) => { saveSelectedVisual(event.target.files?.[0]); event.target.value = ''; };
  $('#backupInput').onchange = (event) => { chooseBackupFile(event.target.files?.[0]); event.target.value = ''; };
  $('#searchInput').oninput = () => { activePlaylistId = null; render(); }; $('#sortSelect').onchange = (event) => { preferences.sort = event.target.value; savePreferences(); render(); };
  document.querySelectorAll('.tab').forEach((button) => button.onclick = () => { currentView = button.dataset.view; collectionFilter = null; activePlaylistId = null; render(); });
  document.querySelectorAll('.bottom-nav button').forEach((button) => button.onclick = () => { currentView = button.dataset.nav === 'settings' ? 'settings' : 'songs'; collectionFilter = null; activePlaylistId = null; render(); });
  $('#storageRefresh').onclick = refreshStorageStatus; $('#persistenceButton').onclick = requestPersistentStorage; $('#clearMusicButton').onclick = clearAllMusic;
  $('#layoutButton').onclick = () => cyclePreference('layout', ['comfortable', 'compact', 'grid']);
  $('#appearanceButton').onclick = () => cyclePreference('appearance', ['soft', 'pure', 'ambient']);
  $('#visualPreferenceButton').onclick = () => { cyclePreference('visualMode', ['artwork', 'animation']); void syncNowPlayingVisual(); };
  $('#exportBackupButton').onclick = () => exportBackup(false); $('#exportFullBackupButton').onclick = () => exportBackup(true); $('#restoreBackupButton').onclick = () => $('#backupInput').click();
  $('[data-action="back-to-library"]').onclick = () => { currentView = 'songs'; render(); };
  $('#openNowPlaying').onclick = openNowPlaying; $('#closeNowPlaying').onclick = closeNowPlaying;
  $('#miniPlay').onclick = togglePlayback; $('#miniNext').onclick = () => nextTrack(); $('#miniPrevious').onclick = previousTrack;
  $('#playButton').onclick = togglePlayback; $('#nextButton').onclick = () => nextTrack(); $('#previousButton').onclick = previousTrack;
  $('#shuffleButton').onclick = () => setShuffleEnabled(!shuffleOn);
  $('#repeatButton').onclick = () => { repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'; updatePlayerMode(); toast(`Repeat ${repeatMode}`); };
  $('#npSeek').oninput = (event) => { const percent = Number(event.target.value) || 0; event.target.style.setProperty('--seek-progress', `${percent}%`); setWaveformProgress(percent); if (audio.duration) { audio.currentTime = (percent / 100) * audio.duration; $('#currentTime').textContent = formatTime(audio.currentTime); $('#remainingTime').textContent = formatRemainingTime((audio.duration || 0) - audio.currentTime); savePlayerState(true); } };
  $('#volumeControl').oninput = (event) => { audio.volume = Number(event.target.value); savePlayerState(true); };
  $('#npFavorite').onclick = () => currentId && toggleFavorite(currentId); $('#npMore').onclick = () => currentId && openSongOptions(currentId); $('#queueButton').onclick = openQueue;
  $('#sleepTimerButton').onclick = openSleepTimer; $('#addPlaylistButton').onclick = () => currentId && openPlaylistSheet(currentId); $('#songInfoButton').onclick = () => currentId && openSongDetails(currentId); $('#npUtilityMore').onclick = () => currentId && openSongOptions(currentId);
  $('#lyricsButton').onclick = () => openLyrics(); $('#audioModsButton').onclick = openAudioMods;
  $('#visualButton').onclick = () => { preferences.visualMode = preferences.visualMode === 'animation' ? 'artwork' : 'animation'; savePreferences(); void syncNowPlayingVisual(); const track = tracks.find((entry) => entry.id === currentId); if (preferences.visualMode === 'animation' && !track?.visualId) toast('Add a local animated visual from the song menu'); };
  $('#closeLyrics').onclick = closeLyrics; $('#lyricsMenuButton').onclick = openLyricsMenu;
  $('#syncPreviousButton').onclick = backLyricsSyncLine; $('#syncRedoButton').onclick = redoLyricsSyncLine; $('#syncSaveButton').onclick = () => { void saveLyricsSync(); }; $('#syncCancelButton').onclick = cancelLyricsSync;
  $('#sheetClose').onclick = closeSheet; $('#sheet').onclick = (event) => { if (event.target === $('#sheet')) closeSheet(); };
  const importArea = $('#importArea'); ['dragenter', 'dragover'].forEach((type) => importArea.addEventListener(type, (event) => { event.preventDefault(); importArea.classList.add('dragging'); })); ['dragleave', 'drop'].forEach((type) => importArea.addEventListener(type, (event) => { event.preventDefault(); importArea.classList.remove('dragging'); })); importArea.addEventListener('drop', (event) => importFiles(event.dataTransfer.files));
  audio.ontimeupdate = () => { const percent = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0; $('#npSeek').value = percent; $('#npSeek').style.setProperty('--seek-progress', `${percent}%`); $('#miniPlayer').style.setProperty('--mini-progress', `${percent}%`); setWaveformProgress(percent); $('#currentTime').textContent = formatTime(audio.currentTime); $('#remainingTime').textContent = formatRemainingTime((audio.duration || 0) - (audio.currentTime || 0)); updateMediaPosition(); updateSyncedLyrics(); savePlayerState(); };
  audio.onloadedmetadata = () => { $('#remainingTime').textContent = formatRemainingTime(audio.duration); updateMediaPosition(); releaseRetiredAudioUrls('new metadata loaded'); playbackDebug('loadedmetadata'); };
  audio.onplay = () => { playbackEpoch += 1; syncAmbientMotionState(); const track = tracks.find((entry) => entry.id === pendingAudio?.id || entry.id === currentId); playbackDebug('play-event', { next: trackDebug(track), pendingSource: Boolean(pendingAudio), playbackEpoch }); };
  audio.onpause = () => { syncAmbientMotionState(); capturePausedResumeSnapshot('audio-pause-event'); $('#playButton').textContent = '▶'; $('#miniPlay').textContent = '▶'; animatePlaybackControls('paused'); setMediaPlaybackState('paused'); playbackDebug('pause-event'); savePlayerState(true); render(); };
  audio.onended = () => { const track = tracks.find((entry) => entry.id === currentId); playbackDebug('ended-event', { previous: trackDebug(track) }); void advanceAfterEnded(); };
  audio.onerror = () => { const track = tracks.find((entry) => entry.id === pendingAudio?.id || entry.id === currentId); playbackDebug('error-event', { next: trackDebug(track), pendingSource: Boolean(pendingAudio) }); $('#miniPlayer').classList.remove('loading'); setMediaPlaybackState('paused'); toast("This audio file couldn't be played."); };
  ['waiting', 'stalled', 'suspend', 'emptied', 'abort', 'canplay'].forEach((eventName) => audio.addEventListener(eventName, () => playbackDebug(`audio-${eventName}`)));
  let miniTouch = null, fullTouchY = null, sheetTouchY = null;
  $('#miniPlayer').addEventListener('touchstart', (event) => { if (event.target.closest('#miniPrevious,#miniPlay,#miniNext')) { miniTouch = null; return; } const touch = event.changedTouches[0]; miniTouch = touch ? { x: touch.clientX, y: touch.clientY, direction: null } : null; }, { passive: true });
  $('#miniPlayer').addEventListener('touchmove', (event) => { const touch = event.changedTouches[0]; if (!miniTouch || !touch) return; const dx = touch.clientX - miniTouch.x, dy = touch.clientY - miniTouch.y; if (!miniTouch.direction && Math.max(Math.abs(dx), Math.abs(dy)) > 8) miniTouch.direction = Math.abs(dx) > Math.abs(dy) * 1.25 ? 'horizontal' : 'vertical'; if (miniTouch.direction === 'horizontal') { const offset = Math.max(-30, Math.min(30, dx * 0.22)); $('#miniPlayer').style.transform = `translateX(${offset}px)`; $('#miniPlayer').classList.add('swiping'); } else if (miniTouch.direction === 'vertical' && dy < 0) { const lift = Math.max(-10, dy * 0.12); $('#miniPlayer').style.transform = `translateY(${lift}px) scale(1.004)`; $('#miniPlayer').classList.add('swiping'); } }, { passive: true });
  $('#miniPlayer').addEventListener('touchend', (event) => { const touch = event.changedTouches[0]; if (!miniTouch || !touch) return; const dx = touch.clientX - miniTouch.x, dy = touch.clientY - miniTouch.y; $('#miniPlayer').style.transform = ''; $('#miniPlayer').classList.remove('swiping'); if (miniTouch.direction === 'horizontal' && Math.abs(dx) > 68) { dx < 0 ? nextTrack() : previousTrack(); } else if (miniTouch.direction !== 'horizontal' && dy < -40 && Math.abs(dy) > Math.abs(dx)) openNowPlaying(); miniTouch = null; }, { passive: true });
  $('#nowPlayingScreen').addEventListener('touchstart', (event) => { fullTouchY = event.target.closest('button,input') ? null : event.changedTouches[0]?.clientY ?? null; }, { passive: true });
  $('#nowPlayingScreen').addEventListener('touchmove', (event) => {
    const touch = event.changedTouches[0]; if (fullTouchY === null || !touch) return;
    const distance = Math.max(0, Math.min(150, touch.clientY - fullTouchY));
    if (distance) { const screen = $('#nowPlayingScreen'); screen.style.setProperty('--dismiss-distance', `${distance}px`); screen.classList.add('dragging'); }
  }, { passive: true });
  $('#nowPlayingScreen').addEventListener('touchend', (event) => {
    const endY = event.changedTouches[0]?.clientY; const distance = fullTouchY !== null && Number.isFinite(endY) ? endY - fullTouchY : 0;
    const screen = $('#nowPlayingScreen'); screen.style.removeProperty('--dismiss-distance'); screen.classList.remove('dragging');
    if (fullTouchY !== null && distance > 70) closeNowPlaying(); fullTouchY = null;
  }, { passive: true });
  const sheetCard = $('#sheet .sheet-card');
  sheetCard.addEventListener('touchstart', (event) => { sheetTouchY = $('#sheetContent').scrollTop <= 0 && !event.target.closest('button,input') ? event.changedTouches[0]?.clientY ?? null : null; }, { passive: true });
  sheetCard.addEventListener('touchmove', (event) => {
    const touch = event.changedTouches[0]; if (sheetTouchY === null || !touch) return;
    const distance = Math.max(0, Math.min(145, touch.clientY - sheetTouchY));
    if (distance) { sheetCard.style.transform = `translateY(${distance}px)`; sheetCard.classList.add('dragging'); }
  }, { passive: true });
  sheetCard.addEventListener('touchend', (event) => {
    const endY = event.changedTouches[0]?.clientY; const distance = sheetTouchY !== null && Number.isFinite(endY) ? endY - sheetTouchY : 0;
    sheetCard.style.removeProperty('transform'); sheetCard.classList.remove('dragging');
    if (sheetTouchY !== null && distance > 76) closeSheet(); sheetTouchY = null;
  }, { passive: true });
  let lyricsTouchY = null;
  $('#lyricsScreen').addEventListener('touchstart', (event) => { lyricsTouchY = event.target.closest('button,.lyrics-content') ? null : event.changedTouches[0]?.clientY ?? null; }, { passive: true });
  $('#lyricsScreen').addEventListener('touchend', (event) => { const endY = event.changedTouches[0]?.clientY; if (lyricsTouchY !== null && Number.isFinite(endY) && endY - lyricsTouchY > 74) closeLyrics(); lyricsTouchY = null; }, { passive: true });
  $('#lyricsContent').addEventListener('scroll', () => {
    if (lyricsSyncDraft || Date.now() < lyricsAutoScrollUntil) return;
    lyricsManualScrollUntil = Date.now() + 3000; $('#lyricsContent').classList.add('manual-scroll');
    clearTimeout(window.zombieLyricsFollowTimer); window.zombieLyricsFollowTimer = setTimeout(() => { lyricsManualScrollUntil = 0; $('#lyricsContent').classList.remove('manual-scroll'); lastLyricsIndex = -1; updateSyncedLyrics(); }, 3000);
  }, { passive: true });
}
async function initialise() {
  try {
    installMobileScaleGuard(); await openDatabase(); await loadLibrary(); await restorePlayerState(); await restorePreferences(); wireUI(); $('#volumeControl').value = audio.volume; configureMediaSession(); if (currentId) { const track = tracks.find((entry) => entry.id === currentId); showMiniPlayer(track); $('#currentTime').textContent = formatTime(restoredPosition); $('#remainingTime').textContent = formatRemainingTime((track.duration || 0) - restoredPosition); $('#npSeek').value = track.duration ? Math.min(100, (restoredPosition / track.duration) * 100) : 0; $('#npSeek').style.setProperty('--seek-progress', `${$('#npSeek').value}%`); setWaveformProgress($('#npSeek').value); } syncAmbientMotionState(); render(); updatePlayerMode(); refreshStorageStatus();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js?v=33').catch(() => {});
  } catch (error) {
    $('#contentArea').innerHTML = `<div class="inline-empty">Zombie could not open local storage. ${escapeHTML(error.message || 'Try closing other Zombie tabs and reopening the app.')}</div>`;
    toast('Local music storage could not be opened');
  }
}
initialise();
window.addEventListener('pagehide', (event) => {
  if (audio.paused) capturePausedResumeSnapshot('pagehide');
  playbackDebug('pagehide', { persisted: Boolean(event.persisted), pausedSourceAlive: hasLivePausedSource(tracks.find((entry) => entry.id === currentId)) });
  stopNowPlayingVisual(); savePlayerState(true); artworkUrls.forEach((url) => URL.revokeObjectURL(url)); visualUrls.forEach((url) => URL.revokeObjectURL(url)); visualUrls.clear();
});
window.addEventListener('pageshow', (event) => playbackDebug('pageshow', { persisted: Boolean(event.persisted), pausedSourceAlive: hasLivePausedSource(tracks.find((entry) => entry.id === currentId)) }));
document.addEventListener('visibilitychange', () => {
  syncAmbientMotionState();
  const track = tracks.find((entry) => entry.id === (pendingAudio?.id || currentId));
  if (document.visibilityState === 'hidden') { if (audio.paused) capturePausedResumeSnapshot('visibility-hidden'); stopNowPlayingVisual(); savePlayerState(true); }
  else { void syncNowPlayingVisual(track); reconcilePlaybackAfterForeground(); }
  playbackDebug(`visibility-${document.visibilityState}`, { next: trackDebug(track), pausedSourceAlive: hasLivePausedSource(track) });
});
document.addEventListener('freeze', () => playbackDebug('document-freeze', { pausedSourceAlive: hasLivePausedSource(tracks.find((entry) => entry.id === currentId)) }));
document.addEventListener('resume', () => playbackDebug('document-resume', { pausedSourceAlive: hasLivePausedSource(tracks.find((entry) => entry.id === currentId)) }));
