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
const LYRICS_PROVIDER = Object.freeze({ name: 'LRCLIB', baseUrl: 'https://lrclib.net/api' });
const LYRICS_REQUEST_GAP_MS = 420, LYRICS_REQUEST_TIMEOUT_MS = 8500;
let lyricSearchQueue = [], lyricSearchWorkerRunning = false;
const artworkUrls = new Map();
const visualUrls = new Map();
let panelTimer = null, lastVisualTrackId = null, visualTransitionToken = 0, activePaletteSignature = '';
let sleepTimerHandle = null, sleepTimerEndsAt = 0, sleepAfterCurrent = false, playlistDragTrackId = null;
let restoredPosition = 0, lastStateSaveAt = 0;
let pendingBackup = null;
let linkImportContext = null, linkImportDraft = null, pendingLinkImport = null, linkImportSaving = false;
let pendingImportCardDismissed = false, linkFilePickerOpen = false, pendingImportResumeTimer = null;
const PENDING_IMPORT_KEY = 'pendingLinkImport';
const BACKUP_FORMAT = 'zombie-backup';
const FULL_BACKUP_LIMIT = 40 * 1024 * 1024;
const preferences = { layout: 'comfortable', appearance: 'soft', visualMode: 'artwork', playbackRate: 1, sort: 'recent', dynamicColours: 'balanced', colourIntensity: 'medium', zombieAccent: 'purple', visualEffects: true, timeDisplay: 'remaining', reduceAnimations: false };
const AUDIO_MOD_DEFAULTS = { bass: 0, treble: 0, vocal: 'off', reverb: 'off', speed: 1, pitch: 0, eq: { bass: 0, lowMid: 0, mid: 0, highMid: 0, treble: 0 }, remember: true, preset: 'normal' };
const AUDIO_PRESETS = {
  normal: { label: 'Normal', values: {} },
  bass: { label: 'Bass Boosted', values: { bass: 52, eq: { bass: 4, lowMid: 2 } } },
  slowed: { label: 'Slowed', values: { speed: .85 } },
  slowedReverb: { label: 'Slowed + Reverb', values: { speed: .85, reverb: 'medium' } },
  nightcore: { label: 'Nightcore', values: { speed: 1.25, pitch: 4 } },
  vocal: { label: 'Vocal', values: { vocal: 'high', eq: { mid: 3, highMid: 4, bass: -2 } } },
  car: { label: 'Car', values: { bass: 40, eq: { bass: 4, lowMid: 2, treble: 1 } } },
  speaker: { label: 'Speaker', values: { bass: 20, eq: { bass: 2, lowMid: 1, highMid: 2, treble: 1 } } },
  soft: { label: 'Soft', values: { treble: -14, eq: { mid: 1, highMid: -2, treble: -3 } } },
};
const ZOMBIE_ACCENTS = { purple: { accent: [150, 91, 255], glow: [245, 91, 192] }, pink: { accent: [245, 86, 180], glow: [255, 156, 205] }, red: { accent: [244, 83, 92], glow: [255, 151, 112] }, blue: { accent: [74, 151, 255], glow: [89, 224, 255] }, green: { accent: [75, 206, 151], glow: [155, 245, 171] }, orange: { accent: [246, 145, 64], glow: [255, 205, 100] } };
let audioMods = { ...AUDIO_MOD_DEFAULTS, eq: { ...AUDIO_MOD_DEFAULTS.eq } }, customAudioPresets = [];
let audioGraph = null, audioModsRestored = false;

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
  const palette = preferences.dynamicColours === 'off' ? (ZOMBIE_ACCENTS[preferences.zombieAccent] || ZOMBIE_ACCENTS.purple) : (isPalette(track?.palette) ? track.palette : fallbackPaletteFor(track));
  const root = document.documentElement;
  const accent = rgbValue(palette.accent), glow = rgbValue(palette.glow), signature = `${accent}|${glow}`;
  const transition = $('#ambientTransition');
  if (activePaletteSignature && activePaletteSignature !== signature && transition) {
    const [previousAccent, previousGlow] = activePaletteSignature.split('|');
    transition.style.setProperty('--zombie-previous-accent-rgb', previousAccent); transition.style.setProperty('--zombie-previous-glow-rgb', previousGlow);
    transition.classList.remove('morphing'); void transition.offsetWidth; transition.classList.add('morphing');
  }
  root.style.setProperty('--zombie-accent-rgb', accent); root.style.setProperty('--zombie-glow-rgb', glow); activePaletteSignature = signature;
  root.dataset.zombieColourMode = preferences.dynamicColours;
  root.dataset.zombieColourIntensity = preferences.colourIntensity;
  root.dataset.zombieVisualEffects = preferences.visualEffects ? 'on' : 'off';
  root.dataset.zombiePalette = track?.id || 'default';
  if (preferences.dynamicColours !== 'off' && track?.artworkId && !isPalette(track.palette)) void deriveArtworkPalette(track);
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
      const score = saturation * saturation * (1 - Math.abs(light - .52)); if (saturation > .13 && score > bestScore) { bestScore = score; best = [r, g, b]; }
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
function updateTimeDisplay() {
  const display = $('#remainingTime'); if (!display) return;
  const duration = Number(audio.duration) || Number(tracks.find((track) => track.id === currentId)?.duration) || 0;
  const position = Number(audio.currentTime) || (currentId ? restoredPosition : 0);
  const isTotal = preferences.timeDisplay === 'total';
  display.textContent = isTotal ? formatTime(duration) : formatRemainingTime(duration - position);
  display.setAttribute('aria-label', isTotal ? 'Show remaining time' : 'Show total time');
}
function toggleTimeDisplay() {
  preferences.timeDisplay = preferences.timeDisplay === 'total' ? 'remaining' : 'total';
  savePreferences(); toast(preferences.timeDisplay === 'total' ? 'Showing total time' : 'Showing remaining time');
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
  document.documentElement.dataset.zombieReducedMotion = preferences.reduceAnimations ? 'on' : 'off';
  audio.playbackRate = preferences.playbackRate;
  if ($('#sortSelect')) $('#sortSelect').value = preferences.sort;
  $('#layoutStatus') && ($('#layoutStatus').textContent = preferences.layout === 'compact' ? 'Compact list' : preferences.layout === 'grid' ? 'Artwork grid' : 'Comfortable list');
  $('#appearanceStatus') && ($('#appearanceStatus').textContent = preferences.appearance === 'pure' ? 'Pure Black' : preferences.appearance === 'ambient' ? 'Artwork Ambient' : 'Soft Black');
  $('#visualStatus') && ($('#visualStatus').textContent = preferences.visualMode === 'animation' ? 'Animation when a song has one' : 'Artwork by default');
  $('#visualButton') && ($('#visualButton').textContent = preferences.visualMode === 'animation' ? '◇ Animation' : '◇ Artwork');
  $('#visualButton')?.classList.toggle('active', preferences.visualMode === 'animation');
  $('#dynamicColoursStatus') && ($('#dynamicColoursStatus').textContent = preferences.dynamicColours === 'full' ? 'Full artwork colour' : preferences.dynamicColours === 'minimal' ? 'Minimal colour' : preferences.dynamicColours === 'off' ? `Off · ${ZOMBIE_ACCENTS[preferences.zombieAccent] ? preferences.zombieAccent[0].toUpperCase() + preferences.zombieAccent.slice(1) : 'Purple'}` : 'Balanced');
  $('#colourIntensityStatus') && ($('#colourIntensityStatus').textContent = preferences.colourIntensity[0].toUpperCase() + preferences.colourIntensity.slice(1));
  $('#visualEffectsStatus') && ($('#visualEffectsStatus').textContent = preferences.visualEffects ? 'On · subtle only' : 'Off');
  $('#reduceAnimationsStatus') && ($('#reduceAnimationsStatus').textContent = preferences.reduceAnimations ? 'On · essential fades stay on' : 'Off · motion is on');
  updateTimeDisplay();
  applyAmbientPalette();
}
async function restorePreferences() {
  const record = await getRecord('settings', 'appPreferences').catch(() => null);
  if (record) {
    if (['compact', 'comfortable', 'grid'].includes(record.layout)) preferences.layout = record.layout;
    if (['pure', 'soft', 'ambient'].includes(record.appearance)) preferences.appearance = record.appearance;
    if (['artwork', 'animation'].includes(record.visualMode)) preferences.visualMode = record.visualMode;
    if ([0.8, 1, 1.2, 1.5].includes(record.playbackRate)) preferences.playbackRate = record.playbackRate;
    if (['recent', 'oldest', 'title', 'artist', 'album', 'plays', 'least', 'duration', 'played'].includes(record.sort)) preferences.sort = record.sort;
    if (['full', 'balanced', 'minimal', 'off'].includes(record.dynamicColours)) preferences.dynamicColours = record.dynamicColours;
    if (['low', 'medium', 'high'].includes(record.colourIntensity)) preferences.colourIntensity = record.colourIntensity;
    if (ZOMBIE_ACCENTS[record.zombieAccent]) preferences.zombieAccent = record.zombieAccent;
    if (typeof record.visualEffects === 'boolean') preferences.visualEffects = record.visualEffects;
    if (['remaining', 'total'].includes(record.timeDisplay)) preferences.timeDisplay = record.timeDisplay;
    if (typeof record.reduceAnimations === 'boolean') preferences.reduceAnimations = record.reduceAnimations;
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
function hasStoredLyrics(track) { return Boolean(track?.syncedLyrics?.length || String(track?.lyrics || '').trim()); }
function lyricsStatusLabel(track) {
  const status = track?.lyricsLookup?.status || '';
  if (status === 'queued') return 'Lyrics waiting…';
  if (status === 'searching') return 'Finding lyrics…';
  if (status === 'synced') return 'Synced lyrics ✓';
  if (status === 'plain') return 'Plain lyrics added ✓';
  if (status === 'offline') return 'Offline — lyrics skipped';
  if (status === 'unavailable') return 'Lyrics search unavailable';
  if (status === 'not-found') return 'Lyrics not found';
  return '';
}
function lyricsStatusMarkup(track) {
  const status = track?.lyricsLookup?.status || '';
  if (!status || status === 'embedded' || status === 'manual') return '';
  return `<em class="lyrics-status lyrics-status-${escapeHTML(status)}">${escapeHTML(lyricsStatusLabel(track))}</em>`;
}
function normaliseLyricsMatchText(value = '') {
  return String(value || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[._]+/g, ' ').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}
function lyricMatchScore(expected, candidate, maximum) {
  const left = normaliseLyricsMatchText(expected), right = normaliseLyricsMatchText(candidate);
  if (!left || !right) return 0;
  if (left === right) return maximum;
  if (left.includes(right) || right.includes(left)) return Math.round(maximum * .74);
  const leftWords = new Set(left.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1));
  const rightWords = new Set(right.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1));
  if (!leftWords.size || !rightWords.size) return 0;
  const shared = [...leftWords].filter((word) => rightWords.has(word)).length;
  return Math.round(maximum * .55 * (shared / Math.max(leftWords.size, rightWords.size)));
}
function hasUsefulLyricsArtist(track) { return Boolean(track?.artist && !/^(local audio|unknown artist|various artists)$/i.test(String(track.artist).trim())); }
function lyricSearchDetails(track) {
  const title = String(track?.title || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title || /^untitled song$/i.test(title)) return null;
  const artist = hasUsefulLyricsArtist(track) ? String(track.artist).trim() : '';
  const album = track?.album && !/^single$/i.test(track.album) ? String(track.album).trim() : '';
  return { title, artist, album, duration: Number(track?.duration) || 0 };
}
function lyricsCandidateFor(track, record) {
  const syncedLyrics = parseLrc(record?.syncedLyrics || '');
  const lyrics = String(record?.plainLyrics || '').trim();
  if (!syncedLyrics.length && !lyrics) return null;
  const details = lyricSearchDetails(track); if (!details) return null;
  const titleScore = lyricMatchScore(details.title, record?.trackName || record?.name, 42);
  const artistScore = details.artist ? lyricMatchScore(details.artist, record?.artistName, 34) : 0;
  const albumScore = details.album ? lyricMatchScore(details.album, record?.albumName, 8) : 0;
  const candidateDuration = Number(record?.duration) || 0;
  const durationDelta = details.duration && candidateDuration ? Math.abs(details.duration - candidateDuration) : null;
  const durationScore = durationDelta === null ? 0 : durationDelta <= 1.75 ? 24 : durationDelta <= 3.5 ? 20 : durationDelta <= 7 ? 10 : durationDelta <= 12 ? 2 : -26;
  const score = titleScore + artistScore + albumScore + durationScore + (syncedLyrics.length ? 8 : 1) + 4;
  const titleExact = titleScore === 42, durationLooksRight = durationDelta === null || durationDelta <= 7;
  const confident = (titleExact && (details.artist
    ? artistScore >= 28 && durationLooksRight && score >= (details.duration ? 70 : 66)
    : (durationDelta === null || durationDelta <= 4) && score >= 65))
    || (!titleExact && titleScore >= 31 && details.artist && artistScore === 34 && durationDelta !== null && durationDelta <= 3.5 && score >= 88);
  return { id: record?.id, trackName: record?.trackName || record?.name || 'Untitled song', artistName: record?.artistName || 'Unknown artist', albumName: record?.albumName || 'Single', duration: candidateDuration, durationDelta, syncedLyrics, lyrics, score, titleScore, artistScore, confident };
}
const LyricsProvider = {
  async search(track) {
    const details = lyricSearchDetails(track); if (!details) return [];
    const params = new URLSearchParams({ track_name: details.title });
    if (details.artist) params.set('artist_name', details.artist);
    if (details.album) params.set('album_name', details.album);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), LYRICS_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${LYRICS_PROVIDER.baseUrl}/search?${params.toString()}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (response.status === 404) return [];
      if (!response.ok) { const error = new Error(`LRCLIB request failed (${response.status})`); error.code = response.status; throw error; }
      const payload = await response.json();
      return Array.isArray(payload) ? payload : [];
    } finally { window.clearTimeout(timeout); }
  },
  async findMatches(track) {
    const results = await this.search(track);
    return results.map((record) => lyricsCandidateFor(track, record)).filter(Boolean).sort((left, right) => right.score - left.score || Number(Boolean(right.syncedLyrics.length)) - Number(Boolean(left.syncedLyrics.length)));
  },
};
async function updateLyricsLookup(track, status, details = {}) {
  if (!track) return;
  track.lyricsLookup = { status, provider: LYRICS_PROVIDER.name, updatedAt: Date.now(), ...details };
  try { await saveRecord('tracks', track); } catch { /* A lyric lookup status must never affect the saved audio. */ }
  render();
}
async function applyLyricsCandidate(track, candidate, { replace = false, origin = 'lrclib' } = {}) {
  if (!track || !candidate || (hasStoredLyrics(track) && !replace)) return false;
  if (candidate.syncedLyrics.length) { track.syncedLyrics = candidate.syncedLyrics; track.lyrics = ''; }
  else if (candidate.lyrics) { track.lyrics = candidate.lyrics; track.syncedLyrics = []; }
  else return false;
  track.lyricsSource = origin;
  track.lyricsLookup = { status: candidate.syncedLyrics.length ? 'synced' : 'plain', provider: LYRICS_PROVIDER.name, updatedAt: Date.now(), matchId: candidate.id || null, matchTitle: candidate.trackName, matchArtist: candidate.artistName, confidence: candidate.score };
  await saveRecord('tracks', track);
  if (activeLyricsId === track.id) { lastLyricsIndex = -1; renderLyrics(track); }
  render();
  return true;
}
function lyricLookupFailureStatus(error) {
  if (navigator.onLine === false) return 'offline';
  return error?.name === 'AbortError' || error?.code === 429 || error?.code >= 500 ? 'unavailable' : 'unavailable';
}
async function runAutomaticLyricsSearch(trackId, { notify = false } = {}) {
  const track = tracks.find((entry) => entry.id === trackId);
  if (!track || hasStoredLyrics(track)) return;
  if (navigator.onLine === false) { await updateLyricsLookup(track, 'offline'); return; }
  await updateLyricsLookup(track, 'searching');
  try {
    const matches = await LyricsProvider.findMatches(track);
    const best = matches.find((candidate) => candidate.confident);
    if (!best || hasStoredLyrics(track)) { await updateLyricsLookup(track, 'not-found'); if (notify) toast('Lyrics not found'); return; }
    const saved = await applyLyricsCandidate(track, best);
    if (saved && notify) toast(best.syncedLyrics.length ? 'Synced lyrics added ✓' : 'Plain lyrics added ✓');
  } catch (error) {
    const status = lyricLookupFailureStatus(error); await updateLyricsLookup(track, status);
    if (notify) toast(status === 'offline' ? 'Offline — lyrics search skipped' : 'Lyrics search unavailable');
  }
}
function queueAutomaticLyrics(track, { notify = false } = {}) {
  if (!track || hasStoredLyrics(track) || lyricSearchQueue.some((entry) => entry.id === track.id)) return;
  lyricSearchQueue.push({ id: track.id, notify });
  void updateLyricsLookup(track, 'queued');
  if (!lyricSearchWorkerRunning) void processAutomaticLyricsQueue();
}
async function processAutomaticLyricsQueue() {
  lyricSearchWorkerRunning = true;
  try {
    while (lyricSearchQueue.length) {
      const next = lyricSearchQueue.shift();
      await runAutomaticLyricsSearch(next.id, { notify: next.notify });
      if (lyricSearchQueue.length) await new Promise((resolve) => window.setTimeout(resolve, LYRICS_REQUEST_GAP_MS));
    }
  } finally { lyricSearchWorkerRunning = false; }
}
function lyricResultMarkup(candidate, selected = false) {
  const duration = candidate.duration ? formatTime(candidate.duration) : 'Unknown duration';
  return `<button class="lyrics-search-result ${selected ? 'selected' : ''}" data-lyrics-result="${escapeHTML(String(candidate.id || ''))}"><span><strong>${escapeHTML(candidate.trackName)}</strong><small>${escapeHTML(candidate.artistName)} · ${escapeHTML(candidate.albumName)} · ${duration}</small></span><b>${candidate.syncedLyrics.length ? 'SYNCED' : 'PLAIN'}</b></button>`;
}
async function openLyricsFinder(id = activeLyricsId || currentId) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  if (!lyricSearchDetails(track)) { toast('Add a song title before searching for lyrics'); return; }
  $('#sheetTitle').textContent = 'Find lyrics';
  $('#sheetContent').innerHTML = '<p class="lyrics-search-loading">Finding close matches…</p>';
  showSheet();
  try {
    if (navigator.onLine === false) throw Object.assign(new Error('offline'), { offline: true });
    const matches = await LyricsProvider.findMatches(track);
    if (!matches.length) { $('#sheetContent').innerHTML = '<p class="sheet-note">No lyrics matches found. Try editing the song title or artist, then retry.</p><button class="sheet-option" id="closeLyricsFinder">Done</button>'; $('#closeLyricsFinder').onclick = closeSheet; return; }
    const byId = new Map(matches.map((candidate) => [String(candidate.id), candidate]));
    $('#sheetContent').innerHTML = `<p class="sheet-note">Choose the matching release. Synced lyrics are preferred when available.</p><div class="lyrics-search-results">${matches.slice(0, 8).map((candidate, index) => lyricResultMarkup(candidate, index === 0)).join('')}</div><button class="sheet-option" id="cancelLyricsFinder">Cancel</button>`;
    $('#sheetContent').querySelectorAll('[data-lyrics-result]').forEach((button) => { button.onclick = () => openLyricsCandidatePreview(track.id, byId.get(button.dataset.lyricsResult)); });
    $('#cancelLyricsFinder').onclick = closeSheet;
  } catch (error) {
    $('#sheetContent').innerHTML = `<p class="sheet-note">${error?.offline ? 'Zombie is offline. Saved lyrics still work; reconnect to search for new ones.' : 'Lyrics search is unavailable right now. Your song is safely saved.'}</p><button class="sheet-option" id="closeLyricsFinder">Done</button>`;
    $('#closeLyricsFinder').onclick = closeSheet;
  }
}
function openLyricsCandidatePreview(trackId, candidate) {
  const track = tracks.find((entry) => entry.id === trackId); if (!track || !candidate) return;
  const preview = (candidate.syncedLyrics.length ? candidate.syncedLyrics.map((line) => line.text).join('\n') : candidate.lyrics).split(/\r?\n/).filter(Boolean).slice(0, 5).join('\n');
  $('#sheetTitle').textContent = 'Use these lyrics?';
  $('#sheetContent').innerHTML = `${lyricResultMarkup(candidate, true)}<pre class="lyrics-search-preview">${escapeHTML(preview || 'Lyrics preview unavailable')}</pre><button id="useLyricsMatch" class="link-import-continue">Use ${candidate.syncedLyrics.length ? 'Synced' : 'Plain'} Lyrics</button><button id="backToLyricsMatches" class="sheet-option">Back</button><button id="cancelLyricsFinder" class="link-import-text-action">Cancel</button>`;
  $('#useLyricsMatch').onclick = async () => {
    if (hasStoredLyrics(track) && !confirm('Replace the lyrics already saved for this song? Your existing lyrics will be replaced.')) return;
    try { const saved = await applyLyricsCandidate(track, candidate, { replace: true }); if (saved) { closeSheet(); toast(candidate.syncedLyrics.length ? 'Synced lyrics saved offline ✓' : 'Lyrics saved offline ✓'); } }
    catch { toast('Zombie could not save those lyrics'); }
  };
  $('#backToLyricsMatches').onclick = () => { void openLyricsFinder(track.id); };
  $('#cancelLyricsFinder').onclick = closeSheet;
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
  const finderLabel = hasStoredLyrics(track) ? 'Find / Replace Lyrics' : 'Find Lyrics';
  const retryable = !hasStoredLyrics(track) && ['not-found', 'offline', 'unavailable'].includes(track.lyricsLookup?.status);
  $('#sheetContent').innerHTML = `<button id="fixLyricsSync" class="lyrics-main-action">Fix Sync</button>${retryable ? '<button id="retryLyricsSearch" class="sheet-option">↻ Retry Lyrics Search</button>' : ''}<button id="findLyricsFromScreen" class="sheet-option">⌕ ${finderLabel}</button><button class="sheet-option" id="quickLyricsEditor">Edit Lyrics</button><details class="lyrics-advanced"><summary>Advanced Sync Settings</summary><p>Fine-tune timing, edit individual lines, or import lyrics. These tools are hidden during normal playback.</p><button class="sheet-option" id="advancedLyricsOffset">Adjust all lyric timing</button>${track.syncedLyrics?.length ? '<button class="sheet-option" id="advancedLineEditor">Edit timestamps and lyric text</button>' : ''}<button class="sheet-option" id="advancedLyricsEditor">Import or edit lyrics</button></details>`;
  $('#fixLyricsSync').onclick = () => { closeSheet(); startLyricsSync(); };
  $('#retryLyricsSearch')?.addEventListener('click', () => { closeSheet(); queueAutomaticLyrics(track, { notify: true }); });
  $('#findLyricsFromScreen').onclick = () => { void openLyricsFinder(track.id); };
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
  track.syncedLyrics = lines; track.lyrics = ''; track.lyricsSource = 'manual'; await saveRecord('tracks', track); lyricsSyncDraft = null; lastLyricsIndex = -1; renderLyrics(track); toast('Lyrics timing saved offline');
}
function cancelLyricsSync() { if (!lyricsSyncDraft) return; lyricsSyncDraft = null; lastLyricsIndex = -1; renderLyrics(); toast('Lyrics sync changes discarded'); }
function openSyncedLineEditor(id = activeLyricsId) {
  const track = tracks.find((entry) => entry.id === id); if (!track?.syncedLyrics?.length) return;
  $('#sheetTitle').textContent = 'Edit lyric lines';
  $('#sheetContent').innerHTML = `<p class="sheet-note">Edit each timestamp in seconds or change the lyric text. Zombie saves standard timestamps such as ${formatLrcTimestamp(6.1)}.</p><div class="lyric-line-editor">${track.syncedLyrics.map((line, index) => `<label class="lyric-edit-row" data-lyric-edit="${index}"><span>${formatLrcTimestamp(line.time)}</span><input class="lyric-edit-time" aria-label="Timestamp for lyric ${index + 1}" type="number" inputmode="decimal" min="0" step="0.01" value="${Number(line.time).toFixed(2)}"><input class="lyric-edit-text" aria-label="Text for lyric ${index + 1}" value="${escapeHTML(line.text)}"></label>`).join('')}</div><button class="sheet-option" id="saveSyncedLines">Save lyric line changes</button>`;
  $('#saveSyncedLines').onclick = async () => { const lines = [...$('#sheetContent').querySelectorAll('[data-lyric-edit]')].map((row) => ({ time: Number(row.querySelector('.lyric-edit-time').value), text: row.querySelector('.lyric-edit-text').value.trim() })).filter((line) => Number.isFinite(line.time) && line.time >= 0 && line.text).sort((a, b) => a.time - b.time); if (!lines.length) { toast('Keep at least one lyric line'); return; } track.syncedLyrics = lines; track.lyrics = ''; track.lyricsSource = 'manual'; await saveRecord('tracks', track); closeSheet(); if (activeLyricsId === id) { lastLyricsIndex = -1; renderLyrics(track); } toast('Lyric lines saved offline'); };
  showSheet();
}
function openLyricsEditor(id = currentId) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  $('#sheetTitle').textContent = 'Offline lyrics';
  $('#sheetContent').innerHTML = `<p class="sheet-note">Paste plain lyrics, or use timestamps such as ${formatLrcTimestamp(6.1)}. Nothing is sent online.</p><label class="edit-field">Lyrics<textarea id="lyricsEditor" rows="11" placeholder="Paste lyrics or LRC timestamps here"></textarea></label><button class="sheet-option" id="importLyrics">Import .lrc or .txt</button>${track.syncedLyrics?.length ? '<button class="sheet-option" id="editSyncedLines">Edit lyric lines</button>' : ''}<button class="sheet-option" id="saveLyrics">Save lyrics offline</button>${(track.lyrics || track.syncedLyrics?.length) ? '<button class="sheet-option danger-text" id="clearLyrics">Remove lyrics</button>' : ''}`;
  $('#lyricsEditor').value = lyricsTextForEditor(track);
  $('#importLyrics').onclick = () => { lyricsTarget = id; $('#lyricsInput').click(); };
  $('#editSyncedLines')?.addEventListener('click', () => openSyncedLineEditor(id));
  $('#saveLyrics').onclick = async () => { const value = $('#lyricsEditor').value.trim(); const syncedLyrics = parseLrc(value); track.syncedLyrics = syncedLyrics; track.lyrics = syncedLyrics.length ? '' : value; track.lyricsSource = 'manual'; await saveRecord('tracks', track); closeSheet(); if (activeLyricsId === id) renderLyrics(track); toast(syncedLyrics.length ? 'Synced lyrics saved offline' : 'Lyrics saved offline'); };
  $('#clearLyrics')?.addEventListener('click', async () => { track.lyrics = ''; track.syncedLyrics = []; track.lyricsSource = ''; track.lyricsLookup = null; await saveRecord('tracks', track); closeSheet(); if (activeLyricsId === id) renderLyrics(track); toast('Lyrics removed'); });
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
    const value = await file.text(); const syncedLyrics = parseLrc(value); track.syncedLyrics = syncedLyrics; track.lyrics = syncedLyrics.length ? '' : value.trim(); track.lyricsSource = 'manual'; await saveRecord('tracks', track);
    closeSheet(); if (activeLyricsId === id) renderLyrics(track); toast(syncedLyrics.length ? 'Synced LRC lyrics imported' : 'Lyrics imported offline');
  } catch (error) { toast(error.message || 'Zombie could not read those lyrics'); }
}
function cloneAudioMods(value = audioMods) { return { ...AUDIO_MOD_DEFAULTS, ...value, eq: { ...AUDIO_MOD_DEFAULTS.eq, ...(value?.eq || {}) } }; }
function isAppleMobileAudio() { return /iPad|iPhone|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function supportsLiveAudioProcessing() { return !isAppleMobileAudio() && Boolean(window.AudioContext || window.webkitAudioContext); }
function audioModsNeedProcessor(mods = audioMods) { return Boolean(mods.bass || mods.treble || mods.vocal !== 'off' || mods.reverb !== 'off' || Object.values(mods.eq || {}).some(Boolean)); }
function audioModsAreActive() { return Math.abs((audioMods.speed || 1) - 1) > .001 || (supportsLiveAudioProcessing() && audioModsNeedProcessor()); }
function audioModsSelectedPreset() { return audioModsAreActive() ? (AUDIO_PRESETS[audioMods.preset] ? audioMods.preset : 'custom') : 'normal'; }
function audioModsStatus() {
  const key = audioModsSelectedPreset();
  const label = key === 'custom' ? 'Custom' : (AUDIO_PRESETS[key]?.label || 'Normal');
  if (key === 'normal') return 'Normal';
  const speedOnly = !supportsLiveAudioProcessing() && (audioModsNeedProcessor(audioMods) || (AUDIO_PRESETS[key] && audioPresetSupport(AUDIO_PRESETS[key].values).state === 'partial'));
  if (speedOnly) return `${label} • Speed only`;
  if (key === 'custom') {
    const effects = [audioMods.bass && 'Bass', audioMods.treble && 'Treble', audioMods.vocal !== 'off' && 'Vocal', audioMods.reverb !== 'off' && 'Reverb'].filter(Boolean);
    return effects.length ? `Custom • ${effects.slice(0, 2).join(' + ')}` : `Custom • ${audioMods.speed}×`;
  }
  return Math.abs((audioMods.speed || 1) - 1) > .001 ? `${label} • ${audioMods.speed}×` : label;
}
function audioPresetSupport(values = {}) {
  const candidate = mergeAudioModValues(values);
  if (Number(candidate.pitch)) return { state: 'partial', note: supportsLiveAudioProcessing() ? 'Pitch unavailable' : 'Speed only on iPhone' };
  if (supportsLiveAudioProcessing()) return { state: 'available', note: 'Local playback' };
  if (!audioModsNeedProcessor(candidate)) return { state: 'available', note: 'Speed works on iPhone' };
  return Math.abs((candidate.speed || 1) - 1) > .001 ? { state: 'partial', note: 'Speed only on iPhone' } : { state: 'unavailable', note: 'Unavailable on iPhone' };
}
function updateAudioModsIndicator() {
  const button = $('#audioModsButton'); if (!button) return;
  const active = audioModsAreActive(); button.classList.toggle('active', active); button.classList.toggle('audio-mods-on', active); button.textContent = active ? '◌ Audio • On' : '◌ Audio'; button.setAttribute('aria-label', active ? `Audio Mods: ${audioModsStatus()}` : 'Audio Mods: Normal');
}
function setGraphValue(node, value) { if (!node) return; const now = audioGraph?.context?.currentTime || 0; node.gain.cancelScheduledValues(now); node.gain.linearRampToValueAtTime(value, now + .035); }
function createReverbImpulse(context) {
  const length = Math.max(1, Math.floor(context.sampleRate * .72)); const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) { const data = impulse.getChannelData(channel); for (let index = 0; index < length; index += 1) data[index] = (Math.random() * 2 - 1) * Math.pow(1 - index / length, 3.1); }
  return impulse;
}
function ensureAudioGraph({ resume = false } = {}) {
  if (!supportsLiveAudioProcessing()) return false;
  try {
    if (!audioGraph) {
      const Context = window.AudioContext || window.webkitAudioContext; const context = new Context();
      const source = context.createMediaElementSource(audio);
      const bass = context.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 105;
      const lowMid = context.createBiquadFilter(); lowMid.type = 'peaking'; lowMid.frequency.value = 310; lowMid.Q.value = .8;
      const mid = context.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = .9;
      const highMid = context.createBiquadFilter(); highMid.type = 'peaking'; highMid.frequency.value = 3200; highMid.Q.value = .95;
      const treble = context.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 7100;
      const vocal = context.createBiquadFilter(); vocal.type = 'peaking'; vocal.frequency.value = 2350; vocal.Q.value = 1.05;
      const dry = context.createGain(); const reverb = context.createConvolver(); const wet = context.createGain();
      reverb.buffer = createReverbImpulse(context); source.connect(bass).connect(lowMid).connect(mid).connect(highMid).connect(treble).connect(vocal); vocal.connect(dry).connect(context.destination); vocal.connect(reverb).connect(wet).connect(context.destination);
      audioGraph = { context, source, filters: { bass, lowMid, mid, highMid, treble, vocal }, wet };
    }
    if (resume && audioGraph.context.state === 'suspended') void audioGraph.context.resume().catch(() => {});
    return true;
  } catch (error) { console.warn('[Zombie Audio Mods] Web Audio unavailable; direct playback kept active.', error); return false; }
}
function applyAudioModGraph() {
  if (!audioGraph) return;
  setGraphValue(audioGraph.filters.bass, (Number(audioMods.bass) || 0) * .14 + (Number(audioMods.eq.bass) || 0));
  setGraphValue(audioGraph.filters.lowMid, Number(audioMods.eq.lowMid) || 0);
  setGraphValue(audioGraph.filters.mid, Number(audioMods.eq.mid) || 0);
  setGraphValue(audioGraph.filters.highMid, Number(audioMods.eq.highMid) || 0);
  setGraphValue(audioGraph.filters.treble, (Number(audioMods.treble) || 0) * .2 + (Number(audioMods.eq.treble) || 0));
  const vocalGain = { off: 0, low: 1.5, medium: 3, high: 4.7 }[audioMods.vocal] ?? 0; setGraphValue(audioGraph.filters.vocal, vocalGain);
  const wet = { off: 0, light: .10, medium: .19, strong: .28 }[audioMods.reverb] ?? 0; setGraphValue(audioGraph.wet, wet);
}
function applyAudioMods({ userGesture = false } = {}) {
  const speed = Math.min(2, Math.max(.5, Number(audioMods.speed) || 1)); audioMods.speed = speed; preferences.playbackRate = speed; audio.playbackRate = speed;
  // iPhone keeps the persistent audio element direct: saved desktop effects never attach or pretend to run here.
  if (!supportsLiveAudioProcessing() && audioModsNeedProcessor()) { audioMods.bass = 0; audioMods.treble = 0; audioMods.vocal = 'off'; audioMods.reverb = 'off'; audioMods.eq = { ...AUDIO_MOD_DEFAULTS.eq }; }
  if (audioModsNeedProcessor() && supportsLiveAudioProcessing() && userGesture) {
    if (ensureAudioGraph({ resume: true })) applyAudioModGraph();
    else { audioMods = { ...cloneAudioMods(), bass: 0, treble: 0, vocal: 'off', reverb: 'off', eq: { ...AUDIO_MOD_DEFAULTS.eq } }; toast('Live effects are unavailable here; original playback is still safe'); }
  } else if (audioGraph) applyAudioModGraph();
  updateAudioModsIndicator(); updateMediaPosition();
}
function saveAudioMods() { saveRecord('settings', { key: 'audioMods', ...cloneAudioMods() }).catch(() => {}); savePreferences(); updateAudioModsIndicator(); }
async function restoreAudioMods() {
  const [stored, savedPresets] = await Promise.all([getRecord('settings', 'audioMods').catch(() => null), getRecord('settings', 'customAudioPresets').catch(() => null)]);
  const legacySpeed = preferences.playbackRate || 1;
  if (stored) { audioMods = cloneAudioMods(stored.remember === false ? { remember: false, speed: 1 } : stored); }
  else audioMods = cloneAudioMods({ speed: legacySpeed });
  customAudioPresets = Array.isArray(savedPresets?.presets) ? savedPresets.presets.filter((preset) => preset?.id && preset?.name && preset?.values).slice(0, 24).map((preset) => ({ id: String(preset.id), name: String(preset.name).slice(0, 42), values: cloneAudioMods(preset.values) })) : [];
  audioModsRestored = true; applyAudioMods();
}
function resetAudioMods() {
  const remember = audioMods.remember; audioMods = cloneAudioMods({ remember, preset: 'normal' }); applyAudioMods({ userGesture: true }); saveAudioMods(); toast('Audio Mods reset'); openAudioMods();
}
function mergeAudioModValues(values = {}) { return cloneAudioMods({ ...AUDIO_MOD_DEFAULTS, ...values, remember: audioMods.remember, preset: values.preset || 'custom', eq: { ...AUDIO_MOD_DEFAULTS.eq, ...(values.eq || {}) } }); }
function applyAudioPreset(key, values, label) {
  audioMods = mergeAudioModValues({ ...values, preset: key });
  if (audioMods.pitch) { audioMods.pitch = 0; toast(`${label}: speed only while pitch stays protected`); }
  if (!supportsLiveAudioProcessing() && audioModsNeedProcessor()) {
    const speedWorks = Math.abs((audioMods.speed || 1) - 1) > .001;
    audioMods.bass = 0; audioMods.treble = 0; audioMods.vocal = 'off'; audioMods.reverb = 'off'; audioMods.eq = { ...AUDIO_MOD_DEFAULTS.eq };
    audioMods.preset = speedWorks ? key : 'normal';
    toast(speedWorks ? `${label}: speed only on iPhone` : `${label}: unavailable on iPhone`);
  }
  applyAudioMods({ userGesture: true }); saveAudioMods(); openAudioMods();
}
async function saveCustomAudioPreset() {
  const name = prompt('Name this Audio Mods preset'); if (!name?.trim()) return;
  const existing = customAudioPresets.findIndex((preset) => preset.name.toLowerCase() === name.trim().toLowerCase()); const preset = { id: existing >= 0 ? customAudioPresets[existing].id : crypto.randomUUID(), name: name.trim().slice(0, 42), values: cloneAudioMods() };
  if (existing >= 0) customAudioPresets.splice(existing, 1, preset); else customAudioPresets.push(preset);
  await saveRecord('settings', { key: 'customAudioPresets', presets: customAudioPresets }); toast('Custom Audio preset saved'); openAudioMods();
}
async function deleteCustomAudioPreset(id) { const preset = customAudioPresets.find((entry) => entry.id === id); if (!preset || !confirm(`Delete “${preset.name}”?`)) return; customAudioPresets = customAudioPresets.filter((entry) => entry.id !== id); await saveRecord('settings', { key: 'customAudioPresets', presets: customAudioPresets }); toast('Custom preset deleted'); openAudioMods(); }
function updateAudioModRange(key, value) { audioMods[key] = Number(value); audioMods.preset = 'custom'; applyAudioMods({ userGesture: true }); saveAudioMods(); }
function updateAudioEq(key, value) { audioMods.eq[key] = Number(value); audioMods.preset = 'custom'; applyAudioMods({ userGesture: true }); saveAudioMods(); }
function openAudioMods() {
  const processing = supportsLiveAudioProcessing(), active = audioModsAreActive(), selected = audioModsSelectedPreset();
  const lock = '<span class="unavailable-label">⌁ Unavailable on iPhone</span>';
  const icon = (key) => `<i class="preset-icon preset-${key}" aria-hidden="true"><b></b><b></b><b></b></i>`;
  const slider = (label, key, min, max, value, suffix = '') => `<label class="audio-mod-slider ${processing ? '' : 'is-unavailable'}"><span><strong>${label}${processing ? '' : lock}</strong><output id="${key}Value">${value}${suffix}</output></span><input id="${key}Control" type="range" min="${min}" max="${max}" value="${value}" ${processing ? '' : 'disabled'}></label>`;
  const choice = (label, key, values, note) => `<div class="audio-choice ${processing ? '' : 'is-unavailable'}"><span><strong>${label}${processing ? '' : lock}</strong><small>${note}</small></span><div>${values.map((value) => `<button data-${key}="${value}" class="${audioMods[key] === value ? 'selected-option' : ''}" ${processing ? '' : 'disabled'}>${value}</button>`).join('')}</div></div>`;
  const eq = [['Bass', 'bass'], ['Low Mid', 'lowMid'], ['Mid', 'mid'], ['High Mid', 'highMid'], ['Treble', 'treble']];
  $('#audioModsButton').classList.add('active'); $('#sheetTitle').textContent = 'Audio Mods';
  $('#sheetContent').innerHTML = `<section class="audio-mod-hero ${active ? 'is-active' : ''}"><i>◌</i><span><strong>${audioModsStatus()}</strong><small>${processing ? 'Local effects only. Your original files are never changed.' : 'Direct playback stays protected on this iPhone.'}</small></span><button id="resetAudioMods">Reset Audio</button></section>${processing ? '' : '<button id="audioSafeMode" class="audio-safe-mode" type="button" aria-expanded="false"><span><b>ⓘ iPhone Safe Mode</b><small>Speed is available. Live effects stay off.</small></span><i>⌄</i></button><p id="audioSafeDetails" class="audio-safe-details hidden">Bass, treble, EQ, vocal boost, reverb, and pitch are intentionally off here. Keeping one direct player protects background playback, Lock Screen controls, and reliable next-song playback.</p>'}<p class="sheet-section">PRESETS</p><div class="audio-preset-grid">${Object.entries(AUDIO_PRESETS).map(([key, preset]) => { const support = audioPresetSupport(preset.values); return `<button class="audio-preset ${selected === key ? 'selected' : ''} ${support.state}" data-audio-preset="${key}" aria-pressed="${selected === key}">${icon(key)}<strong>${preset.label}</strong><small>${support.note}</small><b class="preset-check">✓</b></button>`; }).join('')}</div><p class="sheet-section">PLAYBACK</p><div class="audio-speed-row">${[.5,.75,.85,1,1.15,1.25,1.5,1.75,2].map((rate) => `<button class="audio-speed ${audioMods.speed === rate ? 'selected-option' : ''}" data-audio-speed="${rate}">${rate}×</button>`).join('')}</div><p class="sheet-section">LIVE EFFECTS ${processing ? '' : '· DESKTOP ONLY'}</p>${slider('Bass Boost', 'bass', 0, 100, audioMods.bass, '%')}${slider('Treble', 'treble', -50, 50, audioMods.treble)}${choice('Vocal Boost', 'vocal', ['off','low','medium','high'], 'EQ-style clarity, not vocal isolation.')}${choice('Reverb', 'reverb', ['off','light','medium','strong'], 'Light local ambience.')}<p class="sheet-section">5-BAND EQ ${processing ? '' : '· DESKTOP ONLY'}</p><div class="audio-eq ${processing ? '' : 'is-unavailable'}">${eq.map(([label, key]) => `<label><span><strong>${label}${processing ? '' : lock}</strong><output id="eq${key}Value">${audioMods.eq[key] > 0 ? '+' : ''}${audioMods.eq[key]}</output></span><input data-eq="${key}" type="range" min="-12" max="12" value="${audioMods.eq[key]}" ${processing ? '' : 'disabled'}></label>`).join('')}</div><button id="resetEq" class="sheet-option" ${processing ? '' : 'disabled'}>Reset EQ</button><p class="sheet-section">YOUR PRESETS</p><button id="saveCustomAudioPreset" class="sheet-option">＋ Save current Audio preset</button>${customAudioPresets.length ? `<div class="custom-audio-presets">${customAudioPresets.map((preset) => `<span><button data-custom-audio="${preset.id}">${escapeHTML(preset.name)}</button><button data-delete-custom-audio="${preset.id}" aria-label="Delete ${escapeHTML(preset.name)}">×</button></span>`).join('')}</div>` : '<p class="sheet-note">Save a setup like “My Bass” and it stays only on this device.</p>'}<label class="audio-remember"><input id="rememberAudioMods" type="checkbox" ${audioMods.remember ? 'checked' : ''}><span><strong>Remember Audio Mods</strong><small>Restores safe settings when Zombie opens again.</small></span></label><p class="audio-experimental">Pitch is unavailable for now because independent real-time pitch shifting could weaken iPhone background playback.</p>`;
  $('#audioSafeMode')?.addEventListener('click', () => { const details = $('#audioSafeDetails'), expanded = details.classList.toggle('hidden'); $('#audioSafeMode').setAttribute('aria-expanded', String(!expanded)); $('#audioSafeMode').classList.toggle('expanded', !expanded); });
  $('#resetAudioMods').onclick = resetAudioMods; $('#resetEq').onclick = () => { audioMods.eq = { ...AUDIO_MOD_DEFAULTS.eq }; audioMods.preset = 'custom'; applyAudioMods({ userGesture: true }); saveAudioMods(); openAudioMods(); toast('EQ reset'); };
  $('#bassControl')?.addEventListener('input', (event) => { $('#bassValue').textContent = `${event.target.value}%`; updateAudioModRange('bass', event.target.value); });
  $('#trebleControl')?.addEventListener('input', (event) => { $('#trebleValue').textContent = String(event.target.value); updateAudioModRange('treble', event.target.value); });
  $('#sheetContent').querySelectorAll('[data-eq]').forEach((input) => input.addEventListener('input', (event) => { const key = event.target.dataset.eq, value = Number(event.target.value); $(`#eq${key}Value`).textContent = `${value > 0 ? '+' : ''}${value}`; updateAudioEq(key, value); }));
  $('#sheetContent').querySelectorAll('[data-audio-speed]').forEach((button) => { button.onclick = () => { audioMods.speed = Number(button.dataset.audioSpeed); audioMods.preset = audioMods.speed === 1 && !audioModsNeedProcessor() ? 'normal' : 'custom'; applyAudioMods({ userGesture: true }); saveAudioMods(); toast(audioMods.speed === 1 ? 'Original speed restored' : `Playback speed: ${audioMods.speed}×`); openAudioMods(); }; });
  $('#sheetContent').querySelectorAll('[data-vocal]').forEach((button) => { button.onclick = () => { audioMods.vocal = button.dataset.vocal; audioMods.preset = 'custom'; applyAudioMods({ userGesture: true }); saveAudioMods(); openAudioMods(); }; });
  $('#sheetContent').querySelectorAll('[data-reverb]').forEach((button) => { button.onclick = () => { audioMods.reverb = button.dataset.reverb; audioMods.preset = 'custom'; applyAudioMods({ userGesture: true }); saveAudioMods(); openAudioMods(); }; });
  $('#sheetContent').querySelectorAll('[data-audio-preset]').forEach((button) => { button.onclick = () => { const preset = AUDIO_PRESETS[button.dataset.audioPreset]; applyAudioPreset(button.dataset.audioPreset, preset.values, preset.label); }; });
  $('#saveCustomAudioPreset').onclick = () => { void saveCustomAudioPreset(); }; $('#sheetContent').querySelectorAll('[data-custom-audio]').forEach((button) => { button.onclick = () => { const preset = customAudioPresets.find((entry) => entry.id === button.dataset.customAudio); if (preset) applyAudioPreset('custom', preset.values, preset.name); }; }); $('#sheetContent').querySelectorAll('[data-delete-custom-audio]').forEach((button) => { button.onclick = () => { void deleteCustomAudioPreset(button.dataset.deleteCustomAudio); }; });
  $('#rememberAudioMods').onchange = (event) => { audioMods.remember = event.target.checked; saveAudioMods(); toast(audioMods.remember ? 'Audio Mods will be remembered' : 'Audio Mods will reset next time'); };
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
function animateSkip(direction) { replayVisualClass($('#nowPlayingScreen'), direction === 'next' ? 'skip-forward' : 'skip-backward'); replayVisualClass($('#miniPlayer'), direction === 'next' ? 'skip-forward' : 'skip-backward'); }
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
function rollbackPendingPlayback(reason) {
  const pending = pendingAudio;
  if (!pending) return;
  // A failed start must never leave the new source pretending to be the current song.
  // Put the still-valid prior source back before the queue state is restored.
  pendingAudio = null;
  if (audio.src === pending.url || audio.currentSrc === pending.url) {
    audio.pause();
    if (currentUrl) audio.src = currentUrl;
    else audio.removeAttribute('src');
  }
  pausedResumeSnapshot = null;
  retireAudioUrl(pending.url, `failed transition ${reason}`);
  releaseRetiredAudioUrls(`failed transition ${reason}`);
  playbackDebug('transition-rolled-back', { reason, previous: pending.previous, next: trackDebug(tracks.find((entry) => entry.id === pending.id)) });
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
  const source = currentAudioSource();
  const pendingMatches = Boolean(pendingAudio && pendingAudio.id === track.id && pendingAudio.token === token && (audio.src === pendingAudio.url || audio.currentSrc === pendingAudio.url));
  const currentMatches = currentId === track.id && Boolean(currentUrl) && (source === currentUrl || audio.src === currentUrl);
  // audio.play() resolving is the browser's reliable "started" signal. Requiring a
  // separate readyState threshold here could wrongly reject a real iPhone resume.
  if (token !== loadToken || audio.paused || !source || (!pendingMatches && !currentMatches)) {
    playbackDebug('play-confirmation-failed', { reason, next: trackDebug(track) }); setMediaPlaybackState('paused'); return false;
  }
  if (pendingMatches && !commitPendingPlayback('play-confirmed')) {
    playbackDebug('play-confirmation-commit-failed', { reason, next: trackDebug(track) }); setMediaPlaybackState('paused'); return false;
  }
  if (currentMatches) playbackDebug('play-confirmed-current-source', { reason, next: trackDebug(track) });
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
    // This is intentionally updated from the play promise, not only the DOM event:
    // iOS may delay DOM event delivery while a Home Screen app is backgrounded.
    playbackEpoch += 1;
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
    lyricsSource: typeof track.lyricsSource === 'string' ? track.lyricsSource : '',
    lyricsLookup: track.lyricsLookup && typeof track.lyricsLookup === 'object' ? track.lyricsLookup : null,
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
  updatePendingImportCard();
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
    item.innerHTML = `<button class="track-main" aria-label="Play ${escapeHTML(track.title)}"><span class="cover art-${artVariant(track)}" data-art="${track.id}">Z</span><span class="track-copy"><strong><i class="title-emoji">${track.emoji}</i>${escapeHTML(track.title)}${track.id === currentId && !audio.paused ? '<span class="playing-bars" aria-label="Playing"><i></i><i></i><i></i></span>' : ''}</strong><small>${escapeHTML(track.artist)} · ${escapeHTML(track.album)}${track.genre ? ` · <em>${escapeHTML(track.genre)}</em>` : ''}${lyricsStatusMarkup(track)}</small></span></button><button class="favorite ${track.isFavorite ? 'selected' : ''}" aria-label="${track.isFavorite ? 'Remove from' : 'Add to'} favorites">${track.isFavorite ? '♥' : '♡'}</button><button class="more" aria-label="Song options">⋯</button>${playlist ? `<span class="reorder"><button aria-label="Move song up">↑</button><button aria-label="Move song down">↓</button><button aria-label="Remove from playlist">×</button></span>` : '<button class="delete" aria-label="Delete from device">×</button>'}`;
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
  } else {
    queueIndex = queue.indexOf(id);
    // A manual jump inside an existing shuffled session consumes that upcoming item.
    // Internal next/previous/queue actions already manage the bag themselves.
    const managedShuffleTransition = ['next', 'ended', 'previous', 'queue-jump'].includes(options.reason);
    if (shuffleOn && id !== currentId && !managedShuffleTransition) {
      if (currentId && !shuffleHistory.includes(currentId)) shuffleHistory.push(currentId);
      shuffleBag = shuffleBag.filter((entry) => entry !== id);
      shuffleHistory = shuffleHistory.filter((entry) => entry !== id);
    }
  }
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
      // Do not advance currentId, metadata, or the visible queue for a rejected play().
      // Restoring the prior source also prevents a later resume from playing a different,
      // invisible track through a stale Blob URL.
      rollbackPendingPlayback('play-rejected');
      $('#playButton').textContent = '▶'; $('#miniPlay').textContent = '▶'; syncAmbientMotionState(); render();
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
  $('#sheetContent').innerHTML = `<p class="sheet-note">Zombie will pause the current player when the timer finishes. Keep in mind iPhone may delay browser timers while an app is suspended.</p>${remaining ? `<p class="sheet-section">ACTIVE · ${remaining} MIN LEFT</p>` : sleepAfterCurrent ? '<p class="sheet-section">ACTIVE · END OF CURRENT SONG</p>' : ''}<button class="sheet-option" data-sleep="0">Turn off timer</button><button class="sheet-option" data-sleep="end">End of current song</button>${[15, 30, 45, 60].map((minutes) => `<button class="sheet-option" data-sleep="${minutes}">${minutes === 60 ? '1 hour' : `${minutes} minutes`}</button>`).join('')}`;
  $('#sheetContent').querySelectorAll('[data-sleep]').forEach((button) => { button.onclick = () => setSleepTimer(button.dataset.sleep === 'end' ? 'end' : Number(button.dataset.sleep)); });
  showSheet();
}
function setSleepTimer(minutes) {
  clearTimeout(sleepTimerHandle); sleepTimerHandle = null; sleepTimerEndsAt = 0; sleepAfterCurrent = false;
  if (!minutes) { closeSheet(); toast('Sleep timer off'); return; }
  if (minutes === 'end') { sleepAfterCurrent = true; closeSheet(); toast('Sleep timer: end of this song'); return; }
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
    // playTrack rolls the source back before returning false, so restore the exact queue
    // snapshot too. This keeps a silent/failed candidate out of the saved session.
    if (currentId !== id) {
      queueIndex = previousQueueState.queueIndex; shuffleBag = previousQueueState.shuffleBag; shuffleHistory = previousQueueState.shuffleHistory; savePlayerState(true);
    }
    setMediaPlaybackState('paused');
    playbackDebug('next-track-not-started', { fromEnd, previous: trackDebug(previousTrack), next: trackDebug(tracks.find((entry) => entry.id === id)), queueRestored: currentId !== id });
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
    if (sleepAfterCurrent) { sleepAfterCurrent = false; audio.currentTime = 0; setMediaPlaybackState('paused'); $('#playButton').textContent = '▶'; $('#miniPlay').textContent = '▶'; syncAmbientMotionState(); savePlayerState(true); render(); toast('Sleep timer paused Zombie'); return; }
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
  if (shuffleOn && shuffleHistory.length) { const id = shuffleHistory.pop(); if (currentId) shuffleBag.unshift(currentId); await playTrack(id, null, { reason: 'previous' }); return; }
  if (!queue.length) return;
  if (queueIndex > 0) { queueIndex -= 1; await playTrack(queue[queueIndex]); }
  else if (repeatMode === 'all') { queueIndex = queue.length - 1; await playTrack(queue[queueIndex]); }
  else audio.currentTime = 0;
}
function updatePlayerMode() {
  $('#shuffleButton').classList.toggle('mode-active', shuffleOn);
  $('#repeatButton').classList.toggle('mode-active', repeatMode !== 'off');
  $('#shuffleButton').setAttribute('aria-pressed', String(shuffleOn));
  $('#repeatButton').dataset.repeat = repeatMode;
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
  const tagged = await extractMp3Metadata(file).catch(() => ({}));
  let duration = 0;
  try {
    duration = await new Promise((resolve) => {
      const probe = document.createElement('audio'); const url = URL.createObjectURL(file);
      const cleanup = () => { URL.revokeObjectURL(url); probe.remove(); };
      probe.preload = 'metadata'; probe.onloadedmetadata = () => { const value = Number.isFinite(probe.duration) ? probe.duration : 0; cleanup(); resolve(value); };
      probe.onerror = () => { cleanup(); resolve(0); }; probe.src = url;
    });
  } catch { duration = 0; }
  return { title: tagged.title || (hasArtist ? titleParts.join(' - ') : name || 'Untitled song'), artist: neutralArtist(tagged.artist || (hasArtist ? possibleArtist : '')), album: tagged.album || 'Single', duration };
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
async function extractMp3Metadata(file) {
  if (!/^audio\/mpeg$/i.test(file.type) && !/\.mp3$/i.test(file.name)) return {};
  try {
    const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0, 3)) !== 'ID3') return {};
    const version = bytes[3], tagSize = ((bytes[6] & 127) << 21) | ((bytes[7] & 127) << 14) | ((bytes[8] & 127) << 7) | (bytes[9] & 127);
    const metadata = {}; let offset = 10;
    while (offset + 10 <= Math.min(bytes.length, tagSize + 10)) {
      const id = String.fromCharCode(...bytes.slice(offset, offset + 4));
      const size = version === 4 ? ((bytes[offset + 4] & 127) << 21) | ((bytes[offset + 5] & 127) << 14) | ((bytes[offset + 6] & 127) << 7) | (bytes[offset + 7] & 127) : (bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7];
      if (!id || !size || size < 0 || offset + 10 + size > bytes.length) break;
      const field = id === 'TIT2' ? 'title' : id === 'TPE1' ? 'artist' : id === 'TALB' ? 'album' : '';
      if (field && !metadata[field]) { const frame = bytes.slice(offset + 10, offset + 10 + size); metadata[field] = decodeId3Text(frame.slice(1), frame[0]); }
      offset += 10 + size;
    }
    return metadata;
  } catch { return {}; }
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
  let saved = 0, skipped = 0; const addedTracks = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]; showProgress(`Saving ${index + 1} of ${files.length}`, file.name);
      const fingerprint = `${file.name}|${file.size}|${file.lastModified}`;
      if (tracks.some((track) => track.fingerprint === fingerprint)) { skipped += 1; continue; }
      const metadata = await metadataFor(file); const embeddedLyrics = await extractEmbeddedLyrics(file);
      const hasEmbeddedLyrics = Boolean(embeddedLyrics?.lyrics || embeddedLyrics?.syncedLyrics?.length);
      const track = { id: crypto.randomUUID(), ...metadata, fileName: file.name, type: file.type || 'audio/mpeg', size: file.size, fingerprint, emoji: randomEmoji(), isFavorite: false, genre: '', lyrics: embeddedLyrics?.lyrics || '', syncedLyrics: embeddedLyrics?.syncedLyrics || [], lyricsSource: hasEmbeddedLyrics ? 'embedded' : '', playCount: 0, addedAt: Date.now(), blobStored: true };
      await saveTrack(track, file); tracks.unshift(track); addedTracks.push(track); saved += 1;
      const embeddedArtwork = await extractMp3Artwork(file); if (embeddedArtwork) { track.artworkId = `track:${track.id}`; await saveArtwork(track.artworkId, embeddedArtwork); await saveRecord('tracks', track); }
    }
    render(); await refreshStorageStatus();
    toast(saved ? `${saved} ${saved === 1 ? 'song' : 'songs'} saved on this iPhone${skipped ? ` · ${skipped} duplicate skipped` : ''}` : 'Those songs are already in Zombie');
    addedTracks.filter((track) => !hasStoredLyrics(track)).forEach((track) => queueAutomaticLyrics(track, { notify: addedTracks.length === 1 }));
  } catch (error) {
    const quota = error?.name === 'QuotaExceededError';
    toast(quota ? 'Not enough iPhone storage to save that music' : 'Zombie could not save one of those files');
  } finally { hideProgress(); }
}

function isImportableAudioFile(file) { return Boolean(file && ((file.type || '').startsWith('audio/') || (file.type || '').startsWith('video/') || SUPPORTED_FILES.test(file.name || ''))); }
function youTubeVideoId(value) {
  try {
    const url = value instanceof URL ? value : new URL(String(value || ''));
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || '';
    if (!host.endsWith('youtube.com')) return '';
    return url.searchParams.get('v') || (/^\/(?:shorts|embed|live)\/([^/?#]+)/i.exec(url.pathname)?.[1] || '');
  } catch { return ''; }
}
function isYouTubeLink(url) {
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  return (host === 'youtu.be' && url.pathname.length > 1) || (host.endsWith('youtube.com') && (Boolean(url.searchParams.get('v')) || /^\/(shorts|embed|live)\//i.test(url.pathname)));
}
function isDirectAudioLink(url) { return /\.(mp3|m4a|aac|wav|flac|ogg|opus|mp4|mov|webm)(?:$|[?#])/i.test(url.pathname + url.search); }
function inspectImportLink(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!/^https?:$/i.test(url.protocol)) return null;
    if (isYouTubeLink(url)) {
      const videoId = youTubeVideoId(url);
      return { kind: 'youtube', label: 'YouTube', url: url.href, originalUrl: url.href, normalizedUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, videoId };
    }
    if (isDirectAudioLink(url)) return { kind: 'direct', label: 'Direct audio', url: url.href };
  } catch { /* Keep the simple inline validation message. */ }
  return null;
}
function pendingSource(pending = pendingLinkImport) {
  if (!pending?.sourceUrl) return null;
  return { kind: pending.sourceType || 'youtube', label: pending.sourceName || 'YouTube', url: pending.sourceUrl, originalUrl: pending.sourceUrl, normalizedUrl: pending.normalizedUrl || pending.sourceUrl, videoId: pending.videoId || '' };
}
function pendingImportAge(pending = pendingLinkImport) {
  const age = Math.max(0, Date.now() - Number(pending?.startedAt || Date.now()));
  const days = Math.floor(age / 86400000);
  return days ? `${days} day${days === 1 ? '' : 's'} ago` : 'Started today';
}
function cleanImportTitle(value = '') {
  return String(value || '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/\s*[-–—|]\s*(official\s+)?(?:music\s+)?(?:video|audio)(?:\s*\[[^\]]*\])?$/i, '')
    .replace(/\s*\((?:official\s+)?(?:music\s+)?(?:video|audio)\)$/i, '')
    .replace(/\s+(?:mp3|m4a|audio download)$/i, '')
    .replace(/\s{2,}/g, ' ').trim() || 'Untitled song';
}
async function savePendingImport(source, stage = 'convert', details = {}) {
  if (!source?.url) return null;
  const existing = pendingLinkImport?.sourceUrl === source.url ? pendingLinkImport : null;
  const next = {
    key: PENDING_IMPORT_KEY,
    sourceUrl: source.url,
    normalizedUrl: source.normalizedUrl || source.url,
    sourceName: source.label || 'Downloaded audio',
    sourceType: source.kind || 'file',
    videoId: source.videoId || '',
    titleSuggestion: existing?.titleSuggestion || (source.kind === 'youtube' ? 'YouTube audio' : cleanImportTitle(source.url)),
    startedAt: existing?.startedAt || Date.now(),
    updatedAt: Date.now(),
    stage,
    ...details,
  };
  pendingLinkImport = next;
  await saveRecord('settings', next);
  updatePendingImportCard();
  return next;
}
async function restorePendingImport() {
  const saved = await getRecord('settings', PENDING_IMPORT_KEY).catch(() => null);
  if (!saved?.sourceUrl) return;
  pendingLinkImport = saved;
  linkImportContext = pendingSource(saved);
}
async function clearPendingImport() {
  pendingLinkImport = null;
  pendingImportCardDismissed = false; linkFilePickerOpen = false; linkImportContext = null;
  await deleteRecord('settings', PENDING_IMPORT_KEY).catch(() => {});
  updatePendingImportCard();
}
async function cancelPendingImport(message = 'Import cancelled') {
  clearLinkImportDraft(); await clearPendingImport(); closeSheet(); toast(message);
}
async function startLinkImportOver() {
  await clearPendingImport(); openLinkImporter('');
}
function pendingIsStale(pending = pendingLinkImport) { return Boolean(pending && Date.now() - Number(pending.startedAt || 0) > 7 * 86400000); }
function schedulePendingImportResume() {
  clearTimeout(pendingImportResumeTimer);
  if (!pendingLinkImport || pendingImportCardDismissed || linkImportDraft || document.visibilityState !== 'visible') return;
  pendingImportResumeTimer = setTimeout(() => {
    if (!pendingLinkImport || pendingImportCardDismissed || linkImportDraft || !$('#sheet').classList.contains('hidden')) return;
    openFinishImportStep(pendingSource(), { returning: true });
  }, 220);
}
function updatePendingImportCard() {
  const card = $('#pendingImportCard'); if (!card) return;
  const pending = pendingLinkImport;
  const badge = $('#pendingImportBadge');
  const show = Boolean(pending && !pendingImportCardDismissed && currentView !== 'settings');
  badge?.classList.toggle('hidden', !pending); badge?.setAttribute('aria-label', pending ? 'Finish one pending import' : '');
  if (badge && pending) badge.onclick = () => openFinishImportStep(pendingSource(), { returning: true });
  card.classList.toggle('hidden', !show);
  if (!show) { card.innerHTML = ''; return; }
  const stale = pendingIsStale(pending);
  card.innerHTML = `<div class="pending-import-icon">↓</div><div class="pending-import-copy"><strong>${stale ? 'Still want to finish this import?' : 'Finish your import'}</strong><small>Downloaded the audio? Choose the file to add it to Zombie. · ${pendingImportAge(pending)}</small></div><button id="finishPendingImport" class="pending-import-primary">Choose Downloaded Audio</button><details class="pending-import-more"><summary>More</summary><button id="reopenPendingConverter">Open CnvMP3 Again</button><button id="restartPendingImport">Start Over</button><button id="dismissPendingImport">Not now</button><button id="cancelPendingImport">Cancel</button></details>`;
  $('#finishPendingImport').onclick = () => openFinishImportStep(pendingSource(pending), { returning: true });
  $('#reopenPendingConverter').onclick = () => openConverterStep(pendingSource(pending), { returning: true });
  $('#restartPendingImport').onclick = () => { void startLinkImportOver(); };
  $('#dismissPendingImport').onclick = () => { pendingImportCardDismissed = true; updatePendingImportCard(); toast('Import saved for later'); };
  $('#cancelPendingImport').onclick = () => { void cancelPendingImport('Pending import cancelled'); };
}
function importSteps(active = 'link') {
  const steps = [['link', 'Link'], ['convert', 'Convert'], ['import', 'Import'], ['done', 'Done']];
  const current = steps.findIndex(([key]) => key === active);
  return `<ol class="import-steps" aria-label="Import progress">${steps.map(([key, label], index) => `<li class="${index < current ? 'complete' : ''} ${key === active ? 'active' : ''}"><i>${index < current ? '✓' : index + 1}</i><span>${label}</span></li>`).join('')}</ol>`;
}
function openAddMusicMenu() {
  $('#sheetTitle').textContent = 'Add music';
  $('#sheetContent').innerHTML = `${pendingLinkImport ? `<button id="resumePendingFromMenu" class="import-choice import-choice-link"><i>↓</i><span><strong>Finish your import</strong><small>Choose the downloaded audio when you are ready.</small></span><b>›</b></button>` : ''}<button id="addMusicFiles" class="import-choice"><i>♫</i><span><strong>Import Files</strong><small>Choose music or screen recordings already on this iPhone.</small></span><b>›</b></button><button id="addMusicLink" class="import-choice import-choice-link"><i>↗</i><span><strong>Import from Link</strong><small>Paste a YouTube or direct-audio link.</small></span><b>›</b></button><p class="sheet-note import-privacy-note">Imported audio is saved to your local library for offline listening.</p>`;
  $('#addMusicFiles').onclick = () => { $('#fileInput').click(); closeSheet(); };
  $('#addMusicLink').onclick = () => openLinkImporter();
  $('#resumePendingFromMenu')?.addEventListener('click', () => openFinishImportStep(pendingSource(), { returning: true }));
  showSheet();
}
function setLinkImportFeedback(message = '', kind = '') { const note = $('#linkImportFeedback'); if (!note) return; note.textContent = message; note.className = `link-import-feedback ${kind}`; }
function openLinkImporter(value = linkImportContext?.url || pendingLinkImport?.sourceUrl || '') {
  $('#sheetTitle').textContent = 'Import from Link';
  $('#sheetContent').innerHTML = `${importSteps('link')}<section class="link-import-intro"><i>↗</i><span><strong>Paste your link</strong><small>YouTube links use a converter. Direct audio skips it.</small></span></section><label class="link-import-field">YouTube or audio link<span class="link-url-wrap"><input id="linkImportUrl" type="url" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://…" value="${escapeHTML(value)}"><button id="clearLinkImportUrl" class="link-clear-button" aria-label="Clear link">×</button></span></label><p id="linkImportFeedback" class="link-import-feedback" role="status"></p><div class="link-import-actions"><button id="pasteLinkImport" class="sheet-option">Paste from Clipboard</button><button id="continueLinkImport" class="link-import-continue">Continue</button></div>${pendingLinkImport ? '<button id="startOverLinkImport" class="link-import-text-action">Start Over</button>' : ''}<p class="sheet-note import-privacy-note">Your music is saved locally after you choose the downloaded audio file.</p>`;
  const updateLinkReady = () => {
    const valid = inspectImportLink($('#linkImportUrl').value);
    $('#pasteLinkImport').classList.toggle('link-ready', Boolean(valid));
    if (valid) setLinkImportFeedback(valid.kind === 'youtube' ? '✓ YouTube link ready' : '✓ Direct audio link ready', 'success');
    else if ($('#linkImportUrl').value.trim()) setLinkImportFeedback("That doesn't look like a supported link.", 'error');
    else setLinkImportFeedback('');
  };
  const continueWithLink = async () => {
    const source = inspectImportLink($('#linkImportUrl').value);
    if (!source) { setLinkImportFeedback("That link doesn't look valid.", 'error'); return; }
    linkImportContext = source;
    if (source.kind === 'youtube') { await savePendingImport(source, 'convert'); openConverterStep(source); }
    else openDirectAudioStep(source);
  };
  $('#pasteLinkImport').onclick = async () => {
    try {
      const text = await navigator.clipboard?.readText?.();
      if (!text) throw new Error('empty');
      $('#linkImportUrl').value = text.trim(); updateLinkReady(); $('#continueLinkImport').focus(); toast('Link pasted ✓');
    } catch { setLinkImportFeedback('Clipboard paste is unavailable here. Tap and hold the field to paste.', 'error'); }
  };
  $('#continueLinkImport').onclick = continueWithLink;
  $('#clearLinkImportUrl').onclick = () => { $('#linkImportUrl').value = ''; setLinkImportFeedback(''); updateLinkReady(); $('#linkImportUrl').focus(); };
  $('#linkImportUrl').addEventListener('input', updateLinkReady);
  $('#linkImportUrl').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); continueWithLink(); } });
  $('#startOverLinkImport')?.addEventListener('click', () => { void startLinkImportOver(); });
  updateLinkReady();
  showSheet();
}
function copyLinkForConverter(source) {
  try {
    if (!navigator.clipboard?.writeText) return Promise.reject(new Error('unavailable'));
    return Promise.resolve(navigator.clipboard.writeText(source.url));
  } catch { return Promise.reject(new Error('unavailable')); }
}
function openConverterFallback(source) {
  $('#sheetTitle').textContent = 'Converter could not open';
  $('#sheetContent').innerHTML = `${importSteps('convert')}<p class="sheet-note">The converter couldn't be opened. Your link is still saved.</p><button id="retryOpenConverter" class="link-import-continue">Try Again</button><button id="copyLinkAgain" class="sheet-option">Copy link again</button><button id="cancelConverterImport" class="link-import-text-action">Cancel Import</button>`;
  $('#retryOpenConverter').onclick = () => openConverterStep(source);
  $('#copyLinkAgain').onclick = () => { void copyLinkForConverter(source).then(() => toast('Link copied ✓')).catch(() => toast('Copy the link from Zombie if needed')); };
  $('#cancelConverterImport').onclick = () => { void cancelPendingImport(); };
  showSheet();
}
function launchConverter(source) {
  // Keep window.open inside the tap handler: iPhone can block it if it follows an awaited clipboard promise.
  const copyAttempt = copyLinkForConverter(source);
  void savePendingImport(source, 'converter-opened');
  const opened = window.open('https://cnvmp3.com/v55', '_blank', 'noopener,noreferrer');
  copyAttempt.then(() => toast('Link copied ✓')).catch(() => toast('Converter opened — copy and paste the link manually'));
  if (!opened) { openConverterFallback(source); return; }
  toast('Download the MP3, then come back to Zombie');
}
function openConverterStep(source, { returning = false } = {}) {
  const readyToFinish = returning || (pendingLinkImport?.sourceUrl === source.url && pendingLinkImport?.stage === 'converter-opened');
  if (readyToFinish) { openFinishImportStep(source, { returning: true }); return; }
  $('#sheetTitle').textContent = 'Download audio';
  $('#sheetContent').innerHTML = `${importSteps('convert')}<section class="link-import-intro"><i>▶</i><span><strong>Download your audio</strong><small>Zombie will copy your link first.</small></span></section><p class="converter-short-instructions">In CnvMP3: <strong>Paste → Convert → Download MP3</strong></p><button id="openLinkConverter" class="link-import-continue">Open CnvMP3 in Safari</button><button id="finishWithoutOpeningConverter" class="link-import-text-action">I've already downloaded it</button><p class="sheet-note import-privacy-note">Download audio you own or are allowed to save, then return to Zombie.</p>`;
  $('#openLinkConverter').onclick = () => launchConverter(source);
  $('#finishWithoutOpeningConverter').onclick = () => openFinishImportStep(source, { returning: true });
  showSheet();
}
function openDirectAudioStep(source) {
  $('#sheetTitle').textContent = 'Import direct audio';
  $('#sheetContent').innerHTML = `${importSteps('import')}<section class="link-import-intro"><i>♫</i><span><strong>Direct audio link detected</strong><small>Converter not needed.</small></span></section><button id="tryDirectAudioImport" class="link-import-continue">Download and review audio</button><button id="chooseDirectDownloadedAudio" class="sheet-option">I've Downloaded It — Choose Audio</button><button id="openDirectSource" class="link-import-text-action">Open link in Safari</button><p class="sheet-note import-privacy-note">If the website blocks a normal download, save the file to Files first.</p>`;
  $('#tryDirectAudioImport').onclick = () => { void fetchDirectAudioForImport(source); };
  $('#chooseDirectDownloadedAudio').onclick = () => chooseDownloadedLinkAudio(source);
  $('#openDirectSource').onclick = () => { const opened = window.open(source.url, '_blank', 'noopener,noreferrer'); if (!opened) toast('Open the link in Safari, then save the file to Files'); };
  showSheet();
}
function openFinishImportStep(source = pendingSource(), { returning = false } = {}) {
  if (!source) { openLinkImporter(''); return; }
  linkImportContext = source; pendingImportCardDismissed = false;
  void savePendingImport(source, 'import');
  const stale = pendingIsStale();
  $('#sheetTitle').textContent = 'Finish your import';
  $('#sheetContent').innerHTML = `${importSteps('import')}<section class="link-import-intro"><i>↓</i><span><strong>${stale ? 'Still want to finish?' : returning ? 'Welcome back' : 'Choose your downloaded audio'}</strong><small>${stale ? 'This link is still saved and ready.' : 'Choose the MP3 you just downloaded.'}</small></span></section><p class="file-picker-hint">Your downloaded file is usually in <strong>Files → Downloads.</strong></p><button id="chooseFinishedAudio" class="link-import-continue">I've Downloaded It — Choose Audio</button><button id="openConverterAgain" class="sheet-option">Open CnvMP3 Again</button><button id="startOverFinishedImport" class="link-import-text-action">Start Over</button><button id="cancelFinishedImport" class="link-import-text-action danger-text">Cancel Import</button>`;
  $('#chooseFinishedAudio').onclick = () => chooseDownloadedLinkAudio(source);
  $('#openConverterAgain').onclick = () => { void savePendingImport(source, 'convert'); openConverterStep(source); };
  $('#startOverFinishedImport').onclick = () => { void startLinkImportOver(); };
  $('#cancelFinishedImport').onclick = () => { void cancelPendingImport(); };
  showSheet();
}
function chooseDownloadedLinkAudio(source = null) {
  linkImportContext = source || linkImportContext || pendingSource() || null;
  if (linkImportContext) void savePendingImport(linkImportContext, 'import');
  linkFilePickerOpen = true;
  toast('Choose the MP3 you just downloaded');
  $('#linkFileInput').value = ''; $('#linkFileInput').click(); closeSheet();
}
function linkFileName(source, contentType = '') {
  try {
    const segment = decodeURIComponent(new URL(source.url).pathname.split('/').pop() || '').replace(/[\\/:*?"<>|]+/g, '-');
    if (/\.(mp3|m4a|aac|wav|flac|ogg|opus|mp4|mov|webm)$/i.test(segment)) return segment;
  } catch { /* A generic safe file name is enough. */ }
  const extension = /audio\/(mpeg|mp4|aac|wav|flac|ogg)/i.exec(contentType)?.[1];
  return `downloaded-audio.${extension === 'mpeg' ? 'mp3' : extension || 'mp3'}`;
}
async function fetchDirectAudioForImport(source) {
  try {
    showProgress('Preparing…', 'Getting the direct audio file');
    const response = await fetch(source.url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) throw new Error('download');
    const blob = await response.blob();
    if (!blob.size || (!/^audio\//i.test(blob.type || '') && !/^video\//i.test(blob.type || '') && !isDirectAudioLink(new URL(source.url)))) throw new Error('not-audio');
    if (blob.size > 350 * 1024 * 1024) throw new Error('too-large');
    const file = new File([blob], linkFileName(source, blob.type), { type: blob.type || 'audio/mpeg', lastModified: Date.now() });
    hideProgress(); await prepareLinkImportFile(file, source);
  } catch (error) {
    hideProgress();
    toast(error?.message === 'too-large' ? 'That audio file is too large to import safely' : 'Import failed. Try downloading the audio file first, then choose Import Downloaded Audio.');
    openDirectAudioStep(source);
  }
}
function findPossibleDuplicate(file, metadata, source) {
  const fingerprint = `${file.name}|${file.size}|${file.lastModified}`;
  return tracks.find((track) => track.fingerprint === fingerprint || (source?.url && track.sourceUrl === source.url) || (source?.videoId && track.sourceVideoId === source.videoId) || ((track.fileName || '') === file.name && Number(track.size) === Number(file.size)) || ((track.title || '') === metadata.title && (track.artist || '') === metadata.artist && Math.abs((Number(track.duration) || 0) - (Number(metadata.duration) || 0)) < 1));
}
function clearLinkImportDraft() {
  if (linkImportDraft?.previewUrl) URL.revokeObjectURL(linkImportDraft.previewUrl);
  linkImportDraft = null;
}
async function prepareLinkImportFile(file, source = linkImportContext) {
  linkFilePickerOpen = false;
  if (!isImportableAudioFile(file)) { toast('Choose an MP3, M4A, AAC, WAV, FLAC, or recording'); return; }
  clearLinkImportDraft(); navigator.storage?.persist?.().catch(() => {});
  try {
    showProgress('Preparing…', 'Reading audio details');
    const [metadata, embeddedLyrics, artwork] = await Promise.all([metadataFor(file), extractEmbeddedLyrics(file), extractMp3Artwork(file)]);
    metadata.title = cleanImportTitle(metadata.title || file.name);
    if (pendingLinkImport?.sourceUrl && pendingLinkImport.sourceUrl === source?.url) await savePendingImport(source, 'review', { titleSuggestion: metadata.title, selectedFile: { name: file.name, type: file.type || 'audio', size: file.size, duration: metadata.duration || 0 } });
    linkImportDraft = { file, source: source ? { ...source } : null, metadata, embeddedLyrics, artwork, duplicate: findPossibleDuplicate(file, metadata, source), previewUrl: artwork ? URL.createObjectURL(artwork) : '', artworkKind: artwork ? 'embedded artwork' : 'Zombie placeholder' };
    hideProgress(); openLinkImportReview();
  } catch {
    hideProgress(); toast('Import failed. Try choosing the downloaded audio again.');
  }
}
function rememberDraftFields() {
  if (!linkImportDraft) return;
  const title = $('#linkDraftTitle'), artist = $('#linkDraftArtist'), album = $('#linkDraftAlbum');
  if (title) linkImportDraft.metadata.title = title.value;
  if (artist) linkImportDraft.metadata.artist = artist.value;
  if (album) linkImportDraft.metadata.album = album.value;
}
function setLinkImportArtwork(artwork, kind = 'custom artwork') {
  const draft = linkImportDraft; if (!draft) return;
  if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
  draft.artwork = artwork || null; draft.previewUrl = artwork ? URL.createObjectURL(artwork) : ''; draft.artworkKind = artwork ? kind : 'Zombie placeholder';
}
async function cropSquareArtwork(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image(); image.decoding = 'async'; image.src = url;
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; });
    const size = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
    if (!size) throw new Error('image');
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
    canvas.getContext('2d').drawImage(image, ((image.naturalWidth || image.width) - size) / 2, ((image.naturalHeight || image.height) - size) / 2, size, size, 0, 0, 512, 512);
    return await new Promise((resolve, reject) => canvas.toBlob((output) => output ? resolve(output) : reject(new Error('image')), 'image/jpeg', .9));
  } finally { URL.revokeObjectURL(url); }
}
async function useYouTubeThumbnailForDraft() {
  const draft = linkImportDraft, videoId = draft?.source?.videoId;
  if (!draft || !videoId) return;
  rememberDraftFields();
  try {
    showProgress('Loading artwork…', 'Getting the video thumbnail');
    const response = await fetch(`https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) throw new Error('thumbnail');
    const type = response.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) throw new Error('thumbnail');
    setLinkImportArtwork(await cropSquareArtwork(await response.blob()), 'video thumbnail');
    toast('Video thumbnail ready');
  } catch { toast('That thumbnail is unavailable. Your audio can still import normally.'); }
  finally { hideProgress(); openLinkImportReview(); }
}
async function useCustomLinkArtwork(file) {
  if (!file || !/^image\//i.test(file.type || '')) { toast('Choose an image for artwork'); return; }
  rememberDraftFields();
  try { showProgress('Preparing artwork…', file.name); setLinkImportArtwork(await cropSquareArtwork(file), 'custom artwork'); }
  catch { toast('Zombie could not use that image'); }
  finally { hideProgress(); openLinkImportReview(); }
}
function openLinkImportReview() {
  const draft = linkImportDraft; if (!draft) return;
  const sourceText = draft.source ? `Source: ${draft.source.label}` : 'Downloaded audio file';
  const fileType = (draft.file.type || draft.file.name.split('.').pop() || 'audio').replace(/^audio\//i, '').toUpperCase();
  const durationText = draft.metadata.duration ? ` · ${formatTime(draft.metadata.duration)}` : '';
  $('#sheetTitle').textContent = 'Review import';
  $('#sheetContent').innerHTML = `${importSteps('import')}<section class="link-review-head"><div id="linkImportArt" class="link-import-art">${draft.artwork ? '' : '♫'}</div><span><strong>${escapeHTML(draft.file.name)}</strong><small>${fileType} · ${formatBytes(draft.file.size)}${durationText}</small></span></section>${draft.duplicate ? `<section class="duplicate-import-card"><div id="duplicateImportArt" class="link-import-art">♫</div><span><strong>Possible duplicate</strong><small>A similar song is already in your library.</small><b>${escapeHTML(draft.duplicate.title)}</b><small>${escapeHTML(draft.duplicate.artist)}</small></span></section><button id="viewExistingLinkDuplicate" class="sheet-option">View Existing</button>` : ''}<section class="link-art-section"><strong>Artwork</strong><div class="link-art-actions">${draft.source?.kind === 'youtube' && draft.source.videoId ? '<button id="useVideoThumbnail" class="sheet-option">Use Thumbnail</button>' : ''}<button id="chooseLinkArtwork" class="sheet-option">Choose Artwork</button><button id="usePlaceholderLinkArt" class="sheet-option">${draft.artwork ? 'No Artwork' : '✓ No Artwork'}</button></div><small>${escapeHTML(draft.artworkKind || 'No artwork')}</small></section><label class="edit-field">Title <small>Suggested from the filename — you can change it.</small><input id="linkDraftTitle" value="${escapeHTML(draft.metadata.title)}"></label><label class="edit-field">Artist<input id="linkDraftArtist" value="${escapeHTML(draft.metadata.artist)}"></label><label class="edit-field">Album<input id="linkDraftAlbum" value="${escapeHTML(draft.metadata.album || 'Single')}"></label><section class="link-source-details"><strong>Import details</strong><small>${draft.source ? `${escapeHTML(draft.source.label)} source` : 'File selected from this device'}<br>File: ${escapeHTML(draft.file.name)}</small></section><button id="cancelLinkImport" class="link-import-text-action danger-text">Cancel Import</button><button id="saveLinkImport" class="link-import-continue">${draft.duplicate ? 'Import Anyway' : 'Add to Zombie'}</button><p id="linkImportSaveError" class="link-import-feedback error" role="status"></p>`;
  if (draft.previewUrl) $('#linkImportArt').style.backgroundImage = `url("${draft.previewUrl}")`;
  if (draft.duplicate) void applyArtwork($('#duplicateImportArt'), draft.duplicate);
  $('#viewExistingLinkDuplicate')?.addEventListener('click', () => { const duplicateId = draft.duplicate.id; clearLinkImportDraft(); openSongDetails(duplicateId); });
  $('#usePlaceholderLinkArt').onclick = () => { rememberDraftFields(); setLinkImportArtwork(null); openLinkImportReview(); };
  $('#useVideoThumbnail')?.addEventListener('click', () => { void useYouTubeThumbnailForDraft(); });
  $('#chooseLinkArtwork').onclick = () => { rememberDraftFields(); $('#linkArtworkInput').click(); };
  $('#cancelLinkImport').onclick = () => { void cancelPendingImport(); };
  $('#saveLinkImport').onclick = () => { void saveLinkImportDraft(); };
  showSheet();
}
async function saveLinkImportDraft() {
  const draft = linkImportDraft; if (!draft || linkImportSaving) return;
  linkImportSaving = true;
  try {
    const title = $('#linkDraftTitle').value.trim() || 'Untitled song', artist = neutralArtist($('#linkDraftArtist').value), album = $('#linkDraftAlbum').value.trim() || 'Single';
    const file = draft.file, fingerprint = `${file.name}|${file.size}|${file.lastModified}`;
    const saveButton = $('#saveLinkImport'); if (saveButton) { saveButton.disabled = true; saveButton.textContent = 'Saving…'; }
    showProgress('Importing audio…', title);
    const hasEmbeddedLyrics = Boolean(draft.embeddedLyrics?.lyrics || draft.embeddedLyrics?.syncedLyrics?.length);
    const track = { id: crypto.randomUUID(), ...draft.metadata, title, artist, album, fileName: file.name, type: file.type || 'audio/mpeg', size: file.size, fingerprint, emoji: randomEmoji(), isFavorite: false, genre: '', lyrics: draft.embeddedLyrics?.lyrics || '', syncedLyrics: draft.embeddedLyrics?.syncedLyrics || [], lyricsSource: hasEmbeddedLyrics ? 'embedded' : '', playCount: 0, addedAt: Date.now(), blobStored: true };
    if (draft.source?.url) { track.sourceUrl = draft.source.url; track.sourceName = draft.source.label; track.sourceVideoId = draft.source.videoId || ''; track.sourceNormalizedUrl = draft.source.normalizedUrl || draft.source.url; }
    await saveTrack(track, file); tracks.unshift(track);
    showProgress('Saving offline…', 'Adding it to your local library');
    if (draft.artwork) { try { track.artworkId = `track:${track.id}`; await saveArtwork(track.artworkId, draft.artwork); await saveRecord('tracks', track); } catch { delete track.artworkId; /* Audio remains safely imported if optional artwork cannot be stored. */ } }
    clearLinkImportDraft(); await clearPendingImport(); currentView = 'songs'; collectionFilter = null; activePlaylistId = null; render(); await refreshStorageStatus(); openLinkImportSuccess(track); toast('Added to Zombie ✓');
    if (!hasStoredLyrics(track)) queueAutomaticLyrics(track, { notify: true });
  } catch (error) {
    const quota = error?.name === 'QuotaExceededError'; const message = quota ? 'Not enough iPhone storage to save that music' : 'Import failed. Check the downloaded audio, then try again.';
    const errorNote = $('#linkImportSaveError'); if (errorNote) errorNote.textContent = message;
    const saveButton = $('#saveLinkImport'); if (saveButton) { saveButton.disabled = false; saveButton.textContent = 'Try Saving Again'; }
    toast(message);
  } finally { linkImportSaving = false; hideProgress(); }
}
function openLinkImportSuccess(track) {
  currentView = 'songs'; collectionFilter = null; activePlaylistId = null;
  $('#sheetTitle').textContent = 'Added to Zombie ✓';
  $('#sheetContent').innerHTML = `${importSteps('done')}<section class="link-review-head link-import-success"><div id="successImportArt" class="link-import-art">♫</div><span><strong>${escapeHTML(track.title)}</strong><small>${escapeHTML(track.artist)} · Saved for offline playback.</small></span></section><button id="playImportedTrack" class="link-import-continue">Play Now</button><button id="playlistImportedTrack" class="sheet-option">Add to Playlist</button><button id="favoriteImportedTrack" class="sheet-option">♡ Favorite</button><button id="doneImportSuccess" class="link-import-text-action">Done</button>`;
  void applyArtwork($('#successImportArt'), track);
  $('#playImportedTrack').onclick = () => { closeSheet(); void playTrack(track.id, tracks.map((entry) => entry.id)); };
  $('#favoriteImportedTrack').onclick = async () => { if (!track.isFavorite) await toggleFavorite(track.id); $('#favoriteImportedTrack').textContent = '♥ Favorited'; };
  $('#playlistImportedTrack').onclick = () => openPlaylistSheet(track.id);
  $('#doneImportSuccess').onclick = closeSheet;
  showSheet();
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
  $('#sheetContent').innerHTML = `<div class="sheet-song-header"><span class="sheet-song-art art-${artVariant(track)}" data-sheet-art="${track.id}"></span><span><strong>${track.emoji} ${escapeHTML(track.title)}</strong><small>${escapeHTML(track.artist)} · ${escapeHTML(track.album || 'Single')}</small></span></div><p class="sheet-section">PLAYBACK</p><button class="sheet-option" data-action="play-next">Play next</button><button class="sheet-option" data-action="queue">Add to queue</button><p class="sheet-section">LIBRARY</p><button class="sheet-option" data-action="favorite">${track.isFavorite ? '♥ Remove from favorites' : '♡ Add to favorites'}</button><button class="sheet-option" data-action="playlist">Add or remove from playlist</button><button class="sheet-option" data-action="lyrics">≡ Lyrics</button><button class="sheet-option" data-action="find-lyrics">⌕ Find Lyrics</button><button class="sheet-option" data-action="exclude">${track.excludeFromRecommendations ? '✓ Include in future recommendations' : '⊘ Exclude from future recommendations'}</button><p class="sheet-section">EDIT</p><button class="sheet-option" data-action="edit">Edit song information and note</button><button class="sheet-option" data-action="artwork">Change artwork</button><button class="sheet-option" data-action="visual">${track.visualId ? '◇ Replace animated visual' : '◇ Add animated visual'}</button>${track.visualId ? '<button class="sheet-option" data-action="remove-visual">Remove animated visual</button>' : ''}<p class="sheet-section">MORE</p><button class="sheet-option" data-action="details">Song information</button><button class="sheet-option" data-action="album">Go to album</button><button class="sheet-option" data-action="artist">Go to artist</button><button class="sheet-option" data-action="share">Share local file</button><p class="sheet-section">DEVICE</p><button class="sheet-option danger-text" data-action="delete">Delete song from this iPhone</button>`;
  applyArtwork($('#sheetContent [data-sheet-art]'), track);
  $('#sheetContent').querySelector('[data-action="favorite"]').onclick = async () => { await toggleFavorite(id); closeSheet(); };
  $('#sheetContent').querySelector('[data-action="play-next"]').onclick = () => { addToQueue(id, true); closeSheet(); };
  $('#sheetContent').querySelector('[data-action="queue"]').onclick = () => { addToQueue(id); closeSheet(); };
  $('#sheetContent').querySelector('[data-action="playlist"]').onclick = () => openPlaylistSheet(id);
  $('#sheetContent').querySelector('[data-action="lyrics"]').onclick = () => { closeSheet(); openLyrics(id); };
  $('#sheetContent').querySelector('[data-action="find-lyrics"]').onclick = () => { void openLyricsFinder(id); };
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
  $('#sheetContent').innerHTML = `<dl class="song-details"><dt>Title</dt><dd>${escapeHTML(track.title)}</dd><dt>Artist</dt><dd>${escapeHTML(track.artist)}</dd><dt>Album</dt><dd>${escapeHTML(track.album)}</dd><dt>Genre</dt><dd>${escapeHTML(track.genre || 'Not set')}</dd>${track.sourceName ? `<dt>Source</dt><dd><span class="source-badge">Imported from ${escapeHTML(track.sourceName)}</span></dd>` : ''}<dt>Duration</dt><dd>${formatTime(track.duration)}</dd><dt>Added</dt><dd>${new Date(track.addedAt).toLocaleDateString(undefined,{day:'numeric',month:'long',year:'numeric'})}</dd><dt>Last played</dt><dd>${track.lastPlayed ? new Date(track.lastPlayed).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}) : 'Not played yet'}</dd><dt>Plays</dt><dd>${track.playCount || 0}</dd><dt>File</dt><dd>${escapeHTML(track.fileName || track.title)}</dd><dt>Type</dt><dd>${escapeHTML(fileType)}</dd><dt>Size</dt><dd>${formatBytes(track.size || 0)}</dd>${track.note ? `<dt>Note</dt><dd>${escapeHTML(track.note)}</dd>` : ''}</dl>${track.sourceUrl ? '<button class="sheet-option" id="openOriginalSource">Open original link</button>' : ''}<button class="sheet-option" id="editFromDetails">Edit song</button>`;
  $('#openOriginalSource')?.addEventListener('click', () => { const opened = window.open(track.sourceUrl, '_blank', 'noopener,noreferrer'); if (!opened) toast('Open the original link in Safari'); });
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
  $('#importButton').onclick = openAddMusicMenu; $('#chooseFiles').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (event) => { importFiles(event.target.files); event.target.value = ''; };
  $('#linkFileInput').onchange = (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void prepareLinkImportFile(file, linkImportContext); };
  $('#linkArtworkInput').onchange = (event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void useCustomLinkArtwork(file); };
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
  $('#dynamicColoursButton').onclick = () => cyclePreference('dynamicColours', ['balanced', 'full', 'minimal', 'off']);
  $('#colourIntensityButton').onclick = () => cyclePreference('colourIntensity', ['low', 'medium', 'high']);
  $('#visualEffectsButton').onclick = () => { preferences.visualEffects = !preferences.visualEffects; savePreferences(); };
  $('#reduceAnimationsButton').onclick = () => { preferences.reduceAnimations = !preferences.reduceAnimations; savePreferences(); };
  $('#exportBackupButton').onclick = () => exportBackup(false); $('#exportFullBackupButton').onclick = () => exportBackup(true); $('#restoreBackupButton').onclick = () => $('#backupInput').click();
  $('[data-action="back-to-library"]').onclick = () => { currentView = 'songs'; render(); };
  $('#openNowPlaying').onclick = openNowPlaying; $('#closeNowPlaying').onclick = closeNowPlaying;
  $('#miniPlay').onclick = togglePlayback; $('#miniNext').onclick = () => { animateSkip('next'); void nextTrack(); }; $('#miniPrevious').onclick = () => { animateSkip('previous'); void previousTrack(); };
  $('#playButton').onclick = togglePlayback; $('#nextButton').onclick = () => { animateSkip('next'); void nextTrack(); }; $('#previousButton').onclick = () => { animateSkip('previous'); void previousTrack(); };
  $('#shuffleButton').onclick = () => setShuffleEnabled(!shuffleOn);
  $('#repeatButton').onclick = () => { repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'; updatePlayerMode(); toast(`Repeat ${repeatMode}`); };
  $('#npSeek').oninput = (event) => { const percent = Number(event.target.value) || 0; event.target.style.setProperty('--seek-progress', `${percent}%`); setWaveformProgress(percent); if (audio.duration) { audio.currentTime = (percent / 100) * audio.duration; $('#currentTime').textContent = formatTime(audio.currentTime); updateTimeDisplay(); savePlayerState(true); } };
  $('#remainingTime').onclick = toggleTimeDisplay;
  $('#volumeControl').oninput = (event) => { audio.volume = Number(event.target.value); savePlayerState(true); };
  $('#npFavorite').onclick = () => currentId && toggleFavorite(currentId); $('#npMore').onclick = () => currentId && openSongOptions(currentId); $('#queueButton').onclick = openQueue;
  $('#sleepTimerButton').onclick = openSleepTimer; $('#addPlaylistButton').onclick = () => currentId && openPlaylistSheet(currentId); $('#songInfoButton').onclick = () => currentId && openSongDetails(currentId); $('#npUtilityMore').onclick = () => currentId && openSongOptions(currentId);
  $('#lyricsButton').onclick = () => openLyrics(); $('#audioModsButton').onclick = openAudioMods;
  $('#visualButton').onclick = () => { preferences.visualMode = preferences.visualMode === 'animation' ? 'artwork' : 'animation'; savePreferences(); void syncNowPlayingVisual(); const track = tracks.find((entry) => entry.id === currentId); if (preferences.visualMode === 'animation' && !track?.visualId) toast('Add a local animated visual from the song menu'); };
  $('#closeLyrics').onclick = closeLyrics; $('#lyricsMenuButton').onclick = openLyricsMenu;
  $('#syncPreviousButton').onclick = backLyricsSyncLine; $('#syncRedoButton').onclick = redoLyricsSyncLine; $('#syncSaveButton').onclick = () => { void saveLyricsSync(); }; $('#syncCancelButton').onclick = cancelLyricsSync;
  $('#sheetClose').onclick = closeSheet; $('#sheet').onclick = (event) => { if (event.target === $('#sheet')) closeSheet(); };
  const importArea = $('#importArea'); ['dragenter', 'dragover'].forEach((type) => importArea.addEventListener(type, (event) => { event.preventDefault(); importArea.classList.add('dragging'); })); ['dragleave', 'drop'].forEach((type) => importArea.addEventListener(type, (event) => { event.preventDefault(); importArea.classList.remove('dragging'); })); importArea.addEventListener('drop', (event) => importFiles(event.dataTransfer.files));
  audio.ontimeupdate = () => { const percent = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0; $('#npSeek').value = percent; $('#npSeek').style.setProperty('--seek-progress', `${percent}%`); $('#miniPlayer').style.setProperty('--mini-progress', `${percent}%`); setWaveformProgress(percent); $('#currentTime').textContent = formatTime(audio.currentTime); updateTimeDisplay(); updateMediaPosition(); updateSyncedLyrics(); savePlayerState(); };
  audio.onloadedmetadata = () => { updateTimeDisplay(); updateMediaPosition(); releaseRetiredAudioUrls('new metadata loaded'); playbackDebug('loadedmetadata'); };
  audio.onplay = () => { if (audioGraph?.context?.state === 'suspended') void audioGraph.context.resume().catch(() => {}); syncAmbientMotionState(); const track = tracks.find((entry) => entry.id === pendingAudio?.id || entry.id === currentId); playbackDebug('play-event', { next: trackDebug(track), pendingSource: Boolean(pendingAudio), playbackEpoch }); };
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
    installMobileScaleGuard(); await openDatabase(); await loadLibrary(); await restorePlayerState(); await restorePreferences(); await restoreAudioMods(); await restorePendingImport(); wireUI(); $('#volumeControl').value = audio.volume; configureMediaSession(); if (currentId) { const track = tracks.find((entry) => entry.id === currentId); showMiniPlayer(track); $('#currentTime').textContent = formatTime(restoredPosition); updateTimeDisplay(); $('#npSeek').value = track.duration ? Math.min(100, (restoredPosition / track.duration) * 100) : 0; $('#npSeek').style.setProperty('--seek-progress', `${$('#npSeek').value}%`); setWaveformProgress($('#npSeek').value); } syncAmbientMotionState(); render(); updatePlayerMode(); refreshStorageStatus(); schedulePendingImportResume();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js?v=36.4.2').catch(() => {});
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
window.addEventListener('pageshow', (event) => { playbackDebug('pageshow', { persisted: Boolean(event.persisted), pausedSourceAlive: hasLivePausedSource(tracks.find((entry) => entry.id === currentId)) }); schedulePendingImportResume(); });
document.addEventListener('visibilitychange', () => {
  syncAmbientMotionState();
  const track = tracks.find((entry) => entry.id === (pendingAudio?.id || currentId));
  if (document.visibilityState === 'hidden') { if (audio.paused) capturePausedResumeSnapshot('visibility-hidden'); stopNowPlayingVisual(); savePlayerState(true); }
  else { void syncNowPlayingVisual(track); reconcilePlaybackAfterForeground(); schedulePendingImportResume(); }
  playbackDebug(`visibility-${document.visibilityState}`, { next: trackDebug(track), pausedSourceAlive: hasLivePausedSource(track) });
});
document.addEventListener('freeze', () => playbackDebug('document-freeze', { pausedSourceAlive: hasLivePausedSource(tracks.find((entry) => entry.id === currentId)) }));
document.addEventListener('resume', () => playbackDebug('document-resume', { pausedSourceAlive: hasLivePausedSource(tracks.find((entry) => entry.id === currentId)) }));
