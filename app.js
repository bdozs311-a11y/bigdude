const $ = (selector) => document.querySelector(selector);
const DB_NAME = 'my-sounds-db';
const DB_VERSION = 5;
const EMOJIS = ['🧟', '🧟‍♀️', '🦇', '🕸️', '🖤', '🪦', '🌙', '⚡', '👻', '🕯️', '💀', '🦴'];
const SUPPORTED_FILES = /\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|webm)$/i;
const audio = $('#audio');
let db;
let tracks = [], playlists = [];
let currentId = null, currentUrl = null, loadToken = 0, playbackSerial = 0, countedSerial = -1;
let currentView = 'songs', collectionFilter = null, activePlaylistId = null;
let queue = [], queueIndex = -1, shuffleOn = false, shuffleBag = [], shuffleHistory = [];
let repeatMode = 'off';
let artTarget = null;
const artworkUrls = new Map();
let panelTimer = null;
let restoredPosition = 0, lastStateSaveAt = 0;
let pendingBackup = null;
const BACKUP_FORMAT = 'zombie-backup';
const FULL_BACKUP_LIMIT = 40 * 1024 * 1024;

const randomEmoji = () => EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
const formatTime = (seconds) => !Number.isFinite(seconds) ? '0:00' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const formatBytes = (bytes = 0) => bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
const formatTotalDuration = (seconds = 0) => { const minutes = Math.round(seconds / 60); const days = Math.floor(minutes / 1440); const hours = Math.floor((minutes % 1440) / 60); const mins = minutes % 60; return `${days ? `${days} day${days === 1 ? '' : 's'} ` : ''}${hours ? `${hours} hr ` : ''}${mins ? `${mins} min` : '0 min'}`.trim(); };
const escapeHTML = (value = '') => { const element = document.createElement('span'); element.textContent = value; return element.innerHTML; };
const libraryStats = (list = tracks) => `${list.length} ${list.length === 1 ? 'song' : 'songs'} · ${formatTotalDuration(list.reduce((total, track) => total + (Number(track.duration) || 0), 0))}`;

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
  restoredPosition = Number.isFinite(state.position) && state.position > 0 ? state.position : 0;
  audio.volume = Number.isFinite(state.volume) ? Math.min(1, Math.max(0, state.volume)) : 1;
}
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
function remapArtworkId(id, idMap) { return id?.startsWith('track:') ? `track:${idMap.get(id.slice(6)) || id.slice(6)}` : id; }
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
      if (existing) { const merged = { ...existing, ...cleanTrack(source), id: existing.id, artworkId: remapArtworkId(source.artworkId, new Map([[source.id, existing.id]])), blobStored: existing.blobStored }; await saveRecord('tracks', merged); idMap.set(source.id, existing.id); }
      else if (backup.kind === 'full' && backup.audio.some((entry) => entry.id === source.id)) { await saveRecord('tracks', cleanTrack(source)); idMap.set(source.id, source.id); }
    }
    for (const source of backup.audio) { if (backup.kind === 'full' && idMap.get(source.id) === source.id) await saveRecord('audioBlobs', { id: source.id, blob: base64ToBlob(source.data, source.type) }); }
    for (const source of backup.artwork) { const targetId = remapArtworkId(source.id, idMap); if (mode === 'replace' || source.id.startsWith('playlist:') || [...idMap.keys()].some((id) => source.id === `track:${id}`)) await saveRecord('artworkBlobs', { id: targetId, blob: base64ToBlob(source.data, source.type) }); }
    for (const source of backup.playlists) {
      const mappedIds = (source.trackIds || []).map((id) => idMap.get(id)).filter(Boolean);
      const existing = mode === 'merge' && playlists.find((playlist) => playlist.name === source.name);
      if (existing) { existing.trackIds = [...new Set([...existing.trackIds, ...mappedIds])]; await saveRecord('playlists', existing); }
      else if (mode === 'replace' || mappedIds.length) await saveRecord('playlists', { ...source, id: existing?.id || source.id, trackIds: mappedIds });
    }
    if (mode === 'replace') for (const setting of backup.settings) await saveRecord('settings', setting);
    if (mode === 'merge') for (const setting of backup.settings.filter((setting) => setting.key !== 'playerState')) await saveRecord('settings', setting);
    await loadLibrary(); await restorePlayerState(); $('#volumeControl').value = audio.volume; if (currentId) showMiniPlayer(tracks.find((track) => track.id === currentId)); else $('#miniPlayer').classList.add('hidden'); render(); refreshStorageStatus(); pendingBackup = null;
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
  element.className = `${element.className.split(' ').filter((name) => !name.startsWith('art-')).join(' ')} art-${artVariant(track)}`;
  element.style.backgroundImage = '';
  element.classList.remove('has-art');
  element.textContent = '';
  if (!track?.artworkId) return;
  try { const record = await getRecord('artworkBlobs', track.artworkId); if (!record?.blob) return; let url = artworkUrls.get(track.artworkId); if (!url) { url = URL.createObjectURL(record.blob); artworkUrls.set(track.artworkId, url); } element.style.backgroundImage = `url("${url}")`; element.classList.add('has-art'); element.textContent = ''; } catch { /* fall back to local Zombie art */ }
}
async function mediaArtworkFor(track) {
  const fallback = new URL('zombie-icon-512.png', location.href).href;
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
    play: () => audio.play().catch(() => {}), pause: () => audio.pause(),
    previoustrack: () => previousTrack(), nexttrack: () => nextTrack(),
  };
  Object.entries(actions).forEach(([action, handler]) => { try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* action not exposed by this iOS version */ } });
}
function artVariant(track) { let hash = 0; for (const character of `${track?.title || ''}${track?.artist || ''}${track?.genre || ''}`) hash = ((hash << 5) - hash) + character.charCodeAt(0); return Math.abs(hash) % 6; }
function randomize(values) {
  const output = [...values];
  for (let i = output.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [output[i], output[j]] = [output[j], output[i]]; }
  return output;
}

async function loadLibrary() {
  [tracks, playlists] = await Promise.all([readAll('tracks'), readAll('playlists')]);
  tracks = tracks.map((track) => ({
    ...track,
    title: track.title || track.name || 'Untitled song',
    artist: track.artist || 'Unknown artist',
    album: track.album || 'Single',
    genre: track.genre || '',
    emoji: track.emoji || randomEmoji(),
    isFavorite: Boolean(track.isFavorite),
    playCount: Number(track.playCount || 0),
    type: track.type || 'audio/mpeg',
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
function render() {
  $('#screenTitle').textContent = activePlaylistId ? (playlists.find((playlist) => playlist.id === activePlaylistId)?.name || 'Playlist') : (collectionFilter?.value || 'Zombie');
  $('#libraryScreen').classList.toggle('hidden', currentView === 'settings');
  $('#settingsScreen').classList.toggle('hidden', currentView !== 'settings');
  document.querySelectorAll('.bottom-nav button').forEach((button) => button.classList.toggle('active', button.dataset.nav === (currentView === 'settings' ? 'settings' : 'library')));
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.view === currentView && !activePlaylistId));
  if (currentView === 'settings') { refreshStorageStatus(); return; }
  const area = $('#contentArea'); area.innerHTML = '';
  $('#importArea').classList.toggle('hidden', currentView !== 'songs' || Boolean(collectionFilter) || Boolean(activePlaylistId));
  $('#sortSelect').parentElement.classList.toggle('hidden', ['albums', 'artists', 'playlists'].includes(currentView) || Boolean(activePlaylistId));
  if (activePlaylistId) renderPlaylistDetail(area);
  else if (currentView === 'albums') renderCollections(area, 'album');
  else if (currentView === 'artists') renderCollections(area, 'artist');
  else if (currentView === 'genres') renderCollections(area, 'genre');
  else if (currentView === 'playlists') renderPlaylists(area);
  else renderTrackList(area, visibleTracks());
}
function renderTrackList(area, list, playlist = null) {
  $('#librarySummary').textContent = libraryStats(list);
  $('#emptyState').style.display = list.length || ['albums', 'artists', 'playlists'].includes(currentView) ? 'none' : 'block';
  if (!list.length) {
    area.innerHTML = currentView === 'favorites' ? '<div class="inline-empty">No favorites yet. Tap ♡ on a song to save it here.</div>' : playlist ? '<div class="inline-empty">This playlist is empty. Add songs from your library.</div>' : '';
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
  $('#emptyState').style.display = entries.length ? 'none' : 'block';
  entries.forEach(([name, group]) => {
    const card = document.createElement('button'); card.className = 'collection-card';
    card.innerHTML = `<span class="collection-art art-${artVariant(group[0])}" data-art="${group[0].id}">Z</span><span><strong>${escapeHTML(name || 'Other')}</strong><small>${group.length} ${group.length === 1 ? 'song' : 'songs'}${type === 'album' ? ` · ${escapeHTML(group[0].artist)}` : ''}</small></span><b>›</b>`;
    card.onclick = () => { collectionFilter = { type, value: name }; currentView = 'songs'; render(); };
    area.append(card); applyArtwork(card.querySelector('[data-art]'), group[0]);
  });
}
function renderPlaylists(area) {
  $('#librarySummary').textContent = `${playlists.length} ${playlists.length === 1 ? 'playlist' : 'playlists'}`;
  $('#emptyState').style.display = playlists.length ? 'none' : 'block';
  const create = document.createElement('button'); create.className = 'create-playlist'; create.textContent = '+ Create playlist'; create.onclick = createPlaylist; area.append(create);
  playlists.forEach((playlist) => {
    const card = document.createElement('article'); card.className = 'playlist-card';
    const playlistTracks = playlist.trackIds.map((id) => tracks.find((track) => track.id === id)).filter(Boolean);
    const cover = playlist.artworkId
      ? `<span class="collection-art art-${artVariant({title:playlist.name})}" data-playlist-art="${playlist.id}">Z</span>`
      : `<span class="collection-art playlist-collage">${playlistTracks.slice(0, 4).map((track) => `<i class="art-${artVariant(track)}" data-art="${track.id}">Z</i>`).join('') || '<i class="art-0">Z</i>'}</span>`;
    card.innerHTML = `<button class="playlist-open">${cover}<span><strong>${escapeHTML(playlist.name)}</strong><small>${playlistTracks.length} ${playlistTracks.length === 1 ? 'song' : 'songs'} · ${formatTotalDuration(playlistTracks.reduce((sum, track) => sum + (track.duration || 0), 0))}</small></span></button><button class="playlist-menu" aria-label="Playlist options">⋯</button>`;
    card.querySelector('.playlist-open').onclick = () => { activePlaylistId = playlist.id; render(); };
    card.querySelector('.playlist-menu').onclick = () => openPlaylistOptions(playlist.id);
    area.append(card);
    if (playlist.artworkId) applyArtwork(card.querySelector('[data-playlist-art]'), { ...playlist, title: playlist.name });
    else playlistTracks.slice(0, 4).forEach((track) => applyArtwork(card.querySelector(`[data-art="${track.id}"]`), track));
  });
}
function renderPlaylistDetail(area) {
  const playlist = playlists.find((entry) => entry.id === activePlaylistId);
  if (!playlist) { activePlaylistId = null; render(); return; }
  const ids = playlist.trackIds.filter((id) => tracks.some((track) => track.id === id));
  const list = ids.map((id) => tracks.find((track) => track.id === id));
  $('#librarySummary').textContent = `${list.length} ${list.length === 1 ? 'song' : 'songs'}`;
  $('#emptyState').style.display = 'none';
  const controls = document.createElement('div'); controls.className = 'playlist-controls';
  controls.innerHTML = '<button class="back-link">‹ Playlists</button><button class="primary-button">Play</button><button class="secondary-button">Shuffle</button>';
  controls.querySelector('.back-link').onclick = () => { activePlaylistId = null; currentView = 'playlists'; render(); };
  controls.querySelector('.primary-button').onclick = () => { if (list.length) { shuffleOn = false; updatePlayerMode(); playTrack(list[0].id, ids); } else toast('This playlist is empty'); };
  controls.querySelector('.secondary-button').onclick = () => { if (list.length) { shuffleOn = true; updatePlayerMode(); playTrack(list[Math.floor(Math.random() * list.length)].id, ids); } else toast('This playlist is empty'); };
  area.append(controls); renderTrackList(area, list, playlist);
}

async function playTrack(id, sourceIds = null) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  const resumePosition = id === currentId && !audio.src ? restoredPosition : 0;
  const token = ++loadToken;
  if (sourceIds?.length) { queue = [...new Set(sourceIds)]; queueIndex = queue.indexOf(id); if (shuffleOn) refillShuffleBag(); }
  else if (!queue.includes(id)) { queue = visibleTracks().map((entry) => entry.id); queueIndex = queue.indexOf(id); if (shuffleOn) refillShuffleBag(); }
  savePlayerState();
  if (currentId === id && audio.src) { audio.paused ? audio.play() : audio.pause(); return; }
  showMiniPlayer(track); $('#miniPlayer').classList.add('loading'); audio.pause();
  if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  try {
    const blob = await getAudioBlob(id);
    if (token !== loadToken) return;
    if (!blob) { toast('This song is missing from device storage'); return; }
    currentUrl = URL.createObjectURL(blob); currentId = id; playbackSerial += 1; audio.src = currentUrl;
    if (resumePosition > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.min(resumePosition, Math.max(0, (audio.duration || resumePosition) - 0.05)); restoredPosition = 0; }, { once: true });
    else restoredPosition = 0;
    audio.load(); savePlayerState(true);
    syncNowPlaying(track); render(); updateMediaSession(track);
    await audio.play();
  } catch (error) {
    if (token === loadToken) toast("This audio file couldn't be played.");
  } finally {
    $('#miniPlayer').classList.remove('loading');
  }
}
function showMiniPlayer(track) { $('#miniPlayer').classList.remove('hidden'); syncNowPlaying(track); }
function syncNowPlaying(track = tracks.find((entry) => entry.id === currentId)) {
  if (!track) return;
  ['#miniPlayer', '#nowPlayingScreen'].forEach((selector) => { const panel = $(selector); panel.classList.remove('song-changing'); requestAnimationFrame(() => panel.classList.add('song-changing')); });
  $('#nowTitle').textContent = track.title; $('#nowArtist').textContent = track.artist;
  applyArtwork($('#miniArt'), track); applyArtwork($('#npArt'), track);
  $('#npEmoji').textContent = track.emoji; $('#npTitle').textContent = track.title; $('#npArtist').textContent = `${track.artist} · ${track.album}`;
  $('#npFavorite').textContent = track.isFavorite ? '♥' : '♡';
}
function togglePlayback() {
  if (!audio.src && currentId) { playTrack(currentId); return; }
  if (audio.paused) audio.play().catch(() => toast('Tap a song to start playback')); else audio.pause();
}
function refillShuffleBag() {
  const options = queue.filter((id) => id !== currentId);
  shuffleBag = randomize(options); shuffleHistory = [];
}
async function nextTrack(fromEnd = false) {
  if (!queue.length) return;
  if (fromEnd && repeatMode === 'one') { audio.currentTime = 0; return audio.play(); }
  let id;
  if (shuffleOn) {
    if (!shuffleBag.length) refillShuffleBag();
    id = shuffleBag.shift(); if (currentId) shuffleHistory.push(currentId);
  } else {
    const nextIndex = queueIndex + 1;
    if (nextIndex < queue.length) { queueIndex = nextIndex; id = queue[queueIndex]; }
    else if (repeatMode === 'all') { queueIndex = 0; id = queue[0]; }
    else { audio.pause(); audio.currentTime = 0; if (!fromEnd) toast('You are at the end of this queue'); return; }
  }
  if (id) await playTrack(id);
}
async function advanceAfterEnded() {
  try { await nextTrack(true); } catch { toast('Zombie could not start the next song'); }
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
function openNowPlaying() {
  if (!currentId) return;
  clearTimeout(panelTimer); const screen = $('#nowPlayingScreen'); screen.classList.remove('hidden', 'closing');
  requestAnimationFrame(() => screen.classList.add('presented'));
}
function closeNowPlaying() {
  const screen = $('#nowPlayingScreen'); if (screen.classList.contains('hidden')) return;
  screen.classList.remove('presented'); screen.classList.add('closing'); clearTimeout(panelTimer);
  panelTimer = setTimeout(() => { screen.classList.add('hidden'); screen.classList.remove('closing'); }, 210);
}
function showSheet() { clearTimeout(window.zombieSheetTimer); const sheet = $('#sheet'); sheet.classList.remove('hidden', 'closing'); requestAnimationFrame(() => sheet.classList.add('shown')); }
function openQueue() {
  const queueTracks = queue.map((id) => tracks.find((track) => track.id === id)).filter(Boolean);
  $('#sheetTitle').textContent = 'Up next';
  $('#sheetContent').innerHTML = queueTracks.length ? queueTracks.map((track, index) => `<button class="sheet-option queue-item ${track.id === currentId ? 'queue-current' : ''}" data-queue-id="${track.id}"><span>${index === queueIndex ? '▶' : '·'}</span><span>${track.emoji} ${escapeHTML(track.title)}<small>${escapeHTML(track.artist)}</small></span></button>`).join('') : '<p class="sheet-note">Choose a song to start a queue.</p>';
  document.querySelectorAll('[data-queue-id]').forEach((button) => { button.onclick = () => { closeSheet(); playTrack(button.dataset.queueId); }; });
  showSheet();
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
  return { title: hasArtist ? titleParts.join(' - ') : name || 'Untitled song', artist: hasArtist ? possibleArtist : 'Unknown artist', album: 'Single', duration };
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
      const metadata = await metadataFor(file);
      const track = { id: crypto.randomUUID(), ...metadata, fileName: file.name, type: file.type || 'audio/mpeg', size: file.size, fingerprint, emoji: randomEmoji(), isFavorite: false, genre: '', playCount: 0, addedAt: Date.now(), blobStored: true };
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
  track.isFavorite = !track.isFavorite; await saveRecord('tracks', track); syncNowPlaying(); render();
}
async function deleteTrack(id) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  if (!confirm(`Delete “${track.title}” from this iPhone?`)) return;
  if (id === currentId) { audio.pause(); audio.removeAttribute('src'); audio.load(); if (currentUrl) URL.revokeObjectURL(currentUrl); currentUrl = null; currentId = null; $('#miniPlayer').classList.add('hidden'); }
  const transaction = db.transaction(['tracks', 'audioBlobs', 'artworkBlobs'], 'readwrite'); transaction.objectStore('tracks').delete(id); transaction.objectStore('audioBlobs').delete(id); transaction.objectStore('artworkBlobs').delete(track.artworkId || `track:${id}`);
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
  tracks = tracks.filter((entry) => entry.id !== id); queue = queue.filter((entry) => entry !== id);
  for (const playlist of playlists) { playlist.trackIds = playlist.trackIds.filter((entry) => entry !== id); await saveRecord('playlists', playlist); }
  render(); refreshStorageStatus(); toast('Removed from this device');
}

async function createPlaylist() {
  const name = prompt('Name your playlist'); if (!name?.trim()) return;
  const playlist = { id: crypto.randomUUID(), name: name.trim(), trackIds: [], createdAt: Date.now() };
  await saveRecord('playlists', playlist); playlists.push(playlist); render(); toast('Playlist created');
}
async function savePlaylist(playlist) { await saveRecord('playlists', playlist); playlists = playlists.map((entry) => entry.id === playlist.id ? playlist : entry); }
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
  $('#sheetTitle').textContent = playlist.name; $('#sheetContent').innerHTML = '<button class="sheet-option" data-option="cover">Choose playlist cover</button><button class="sheet-option" data-option="rename">Rename playlist</button><button class="sheet-option danger-text" data-option="delete">Delete playlist</button>';
  $('#sheetContent').querySelector('[data-option="cover"]').onclick = () => { artTarget = { type: 'playlist', id }; $('#artInput').click(); };
  $('#sheetContent').querySelector('[data-option="rename"]').onclick = async () => { const name = prompt('New playlist name', playlist.name); if (name?.trim()) { playlist.name = name.trim(); await savePlaylist(playlist); render(); } closeSheet(); };
  $('#sheetContent').querySelector('[data-option="delete"]').onclick = async () => { if (confirm(`Delete playlist “${playlist.name}”? Songs will stay on your iPhone.`)) { await deleteRecord('playlists', id); playlists = playlists.filter((entry) => entry.id !== id); if (activePlaylistId === id) activePlaylistId = null; render(); } closeSheet(); };
  showSheet();
}
async function removeFromPlaylist(playlistId, trackId) { const playlist = playlists.find((entry) => entry.id === playlistId); if (!playlist) return; playlist.trackIds = playlist.trackIds.filter((entry) => entry !== trackId); await savePlaylist(playlist); render(); }
async function reorderPlaylist(playlistId, from, to) { const playlist = playlists.find((entry) => entry.id === playlistId); if (!playlist || to < 0 || to >= playlist.trackIds.length) return; [playlist.trackIds[from], playlist.trackIds[to]] = [playlist.trackIds[to], playlist.trackIds[from]]; await savePlaylist(playlist); render(); }
function closeSheet() {
  const sheet = $('#sheet'); if (sheet.classList.contains('hidden')) return;
  sheet.classList.remove('shown'); sheet.classList.add('closing'); clearTimeout(window.zombieSheetTimer);
  window.zombieSheetTimer = setTimeout(() => { sheet.classList.add('hidden'); sheet.classList.remove('closing'); }, 180);
}

function openSongOptions(id) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  $('#sheetTitle').textContent = track.title;
  $('#sheetContent').innerHTML = `<button class="sheet-option" data-action="favorite">${track.isFavorite ? 'Remove from favorites' : 'Add to favorites'}</button><button class="sheet-option" data-action="playlist">Add or remove from playlist</button><button class="sheet-option" data-action="edit">Edit song information</button><button class="sheet-option" data-action="details">Song details</button><button class="sheet-option danger-text" data-action="delete">Delete song</button>`;
  $('#sheetContent').querySelector('[data-action="favorite"]').onclick = async () => { await toggleFavorite(id); closeSheet(); };
  $('#sheetContent').querySelector('[data-action="playlist"]').onclick = () => openPlaylistSheet(id);
  $('#sheetContent').querySelector('[data-action="edit"]').onclick = () => openSongEditor(id);
  $('#sheetContent').querySelector('[data-action="details"]').onclick = () => openSongDetails(id);
  $('#sheetContent').querySelector('[data-action="delete"]').onclick = () => { closeSheet(); deleteTrack(id); };
  showSheet();
}
function openSongDetails(id) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  $('#sheetTitle').textContent = 'Song information';
  $('#sheetContent').innerHTML = `<dl class="song-details"><dt>Title</dt><dd>${escapeHTML(track.title)}</dd><dt>Artist</dt><dd>${escapeHTML(track.artist)}</dd><dt>Album</dt><dd>${escapeHTML(track.album)}</dd><dt>Genre</dt><dd>${escapeHTML(track.genre || 'Not set')}</dd><dt>Duration</dt><dd>${formatTime(track.duration)}</dd><dt>Added</dt><dd>${new Date(track.addedAt).toLocaleDateString(undefined,{day:'numeric',month:'long',year:'numeric'})}</dd><dt>Last played</dt><dd>${track.lastPlayed ? new Date(track.lastPlayed).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}) : 'Not played yet'}</dd><dt>Plays</dt><dd>${track.playCount || 0}</dd><dt>File</dt><dd>${escapeHTML(track.fileName || track.title)}</dd></dl><button class="sheet-option" id="editFromDetails">Edit song</button>`;
  $('#editFromDetails').onclick = () => openSongEditor(id); showSheet();
}
function openSongEditor(id) {
  const track = tracks.find((entry) => entry.id === id); if (!track) return;
  $('#sheetTitle').textContent = 'Edit song';
  $('#sheetContent').innerHTML = `<label class="edit-field">Title<input id="editTitle" value="${escapeHTML(track.title)}"></label><label class="edit-field">Artist<input id="editArtist" value="${escapeHTML(track.artist)}"></label><label class="edit-field">Album<input id="editAlbum" value="${escapeHTML(track.album)}"></label><label class="edit-field">Emoji<input id="editEmoji" value="${escapeHTML(track.emoji)}" maxlength="8"></label><label class="edit-field">Genre<input id="editGenre" list="genreChoices" value="${escapeHTML(track.genre || '')}" placeholder="Optional genre"></label><datalist id="genreChoices"><option>Hip-Hop</option><option>R&B</option><option>Pop</option><option>Rock</option><option>Rap</option><option>Indie</option><option>Electronic</option><option>Reggae</option><option>Soul</option><option>Other</option></datalist><button class="sheet-option" id="chooseTrackArt">Choose artwork from Photos</button>${track.artworkId ? '<button class="sheet-option" id="removeTrackArt">Remove artwork</button>' : ''}<button class="sheet-option" id="saveSongEdit">Save changes</button>`;
  $('#chooseTrackArt').onclick = () => { artTarget = { type: 'track', id }; $('#artInput').click(); };
  if ($('#removeTrackArt')) $('#removeTrackArt').onclick = async () => { await removeTrackArtwork(track); render(); syncNowPlaying(); closeSheet(); toast('Artwork removed'); };
  $('#saveSongEdit').onclick = async () => { track.title = $('#editTitle').value.trim() || 'Untitled song'; track.artist = $('#editArtist').value.trim() || 'Unknown artist'; track.album = $('#editAlbum').value.trim() || 'Single'; track.emoji = $('#editEmoji').value.trim() || randomEmoji(); track.genre = $('#editGenre').value.trim(); await saveRecord('tracks', track); render(); syncNowPlaying(); updateMediaSession(track); closeSheet(); toast('Song details saved'); };
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
    const quota = estimate?.quota;
    $('#storageStatus').textContent = `${formatBytes(usage)} used${quota ? ` of ${formatBytes(quota)}` : ''} · ${libraryStats()}`;
    const persisted = await navigator.storage?.persisted?.();
    $('#persistenceStatus').textContent = persisted ? 'Storage protection is enabled.' : 'Ask iPhone to protect this library from cleanup.';
    refreshLibraryStats();
  } catch { $('#storageStatus').textContent = `${tracks.length} songs stored on this device`; }
}
function refreshLibraryStats() {
  const favorites = tracks.filter((track) => track.isFavorite).length;
  const mostPlayed = [...tracks].sort((a, b) => (b.playCount || 0) - (a.playCount || 0))[0];
  const recent = [...tracks].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 2).map((track) => track.title).join(', ');
  $('#libraryStats').textContent = `${libraryStats()} · ${playlists.length} ${playlists.length === 1 ? 'playlist' : 'playlists'} · ${favorites} favorites${mostPlayed?.playCount ? ` · Most played: ${mostPlayed.title}` : ''}${recent ? ` · Recent: ${recent}` : ''}`;
}
async function requestPersistentStorage() {
  try { const granted = await navigator.storage?.persist?.(); await refreshStorageStatus(); toast(granted ? 'Zombie storage is protected' : 'iPhone manages storage automatically'); } catch { toast('Storage protection is unavailable here'); }
}
async function clearAllMusic() {
  if (!confirm('Clear every song, favorite, and playlist from this iPhone? This cannot be undone.')) return;
  const transaction = db.transaction(['tracks', 'audioBlobs', 'playlists', 'artworkBlobs'], 'readwrite');
  ['tracks', 'audioBlobs', 'playlists', 'artworkBlobs'].forEach((name) => transaction.objectStore(name).clear());
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
  audio.pause(); audio.removeAttribute('src'); audio.load(); if (currentUrl) URL.revokeObjectURL(currentUrl);
  tracks = []; playlists = []; queue = []; currentId = null; currentUrl = null; activePlaylistId = null; $('#miniPlayer').classList.add('hidden'); render(); refreshStorageStatus(); toast('All music cleared from this device');
}

function wireUI() {
  $('#importButton').onclick = () => $('#fileInput').click(); $('#chooseFiles').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (event) => { importFiles(event.target.files); event.target.value = ''; };
  $('#artInput').onchange = (event) => { saveSelectedArtwork(event.target.files?.[0]); event.target.value = ''; };
  $('#backupInput').onchange = (event) => { chooseBackupFile(event.target.files?.[0]); event.target.value = ''; };
  $('#searchInput').oninput = () => { activePlaylistId = null; render(); }; $('#sortSelect').onchange = render;
  document.querySelectorAll('.tab').forEach((button) => button.onclick = () => { currentView = button.dataset.view; collectionFilter = null; activePlaylistId = null; render(); });
  document.querySelectorAll('.bottom-nav button').forEach((button) => button.onclick = () => { currentView = button.dataset.nav === 'settings' ? 'settings' : 'songs'; collectionFilter = null; activePlaylistId = null; render(); });
  $('#storageRefresh').onclick = refreshStorageStatus; $('#persistenceButton').onclick = requestPersistentStorage; $('#clearMusicButton').onclick = clearAllMusic;
  $('#exportBackupButton').onclick = () => exportBackup(false); $('#exportFullBackupButton').onclick = () => exportBackup(true); $('#restoreBackupButton').onclick = () => $('#backupInput').click();
  $('[data-action="back-to-library"]').onclick = () => { currentView = 'songs'; render(); };
  $('#openNowPlaying').onclick = openNowPlaying; $('#closeNowPlaying').onclick = closeNowPlaying;
  $('#miniPlay').onclick = togglePlayback; $('#miniNext').onclick = () => nextTrack(); $('#miniPrevious').onclick = previousTrack;
  $('#playButton').onclick = togglePlayback; $('#nextButton').onclick = () => nextTrack(); $('#previousButton').onclick = previousTrack;
  $('#shuffleButton').onclick = () => { shuffleOn = !shuffleOn; if (shuffleOn) refillShuffleBag(); updatePlayerMode(); toast(shuffleOn ? 'Shuffle on' : 'Shuffle off'); };
  $('#repeatButton').onclick = () => { repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'; updatePlayerMode(); toast(`Repeat ${repeatMode}`); };
  $('#npSeek').oninput = (event) => { if (audio.duration) { audio.currentTime = (event.target.value / 100) * audio.duration; savePlayerState(true); } };
  $('#volumeControl').oninput = (event) => { audio.volume = Number(event.target.value); savePlayerState(true); };
  $('#npFavorite').onclick = () => currentId && toggleFavorite(currentId); $('#npMore').onclick = () => currentId && openSongOptions(currentId); $('#queueButton').onclick = openQueue;
  $('#sheetClose').onclick = closeSheet; $('#sheet').onclick = (event) => { if (event.target === $('#sheet')) closeSheet(); };
  const importArea = $('#importArea'); ['dragenter', 'dragover'].forEach((type) => importArea.addEventListener(type, (event) => { event.preventDefault(); importArea.classList.add('dragging'); })); ['dragleave', 'drop'].forEach((type) => importArea.addEventListener(type, (event) => { event.preventDefault(); importArea.classList.remove('dragging'); })); importArea.addEventListener('drop', (event) => importFiles(event.dataTransfer.files));
  audio.ontimeupdate = () => { const percent = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0; $('#npSeek').value = percent; $('#currentTime').textContent = formatTime(audio.currentTime); updateMediaPosition(); savePlayerState(); };
  audio.onloadedmetadata = () => { $('#duration').textContent = formatTime(audio.duration); updateMediaPosition(); };
  audio.onplay = () => { $('#miniPlayer').classList.remove('loading'); $('#playButton').textContent = 'Ⅱ'; $('#miniPlay').textContent = 'Ⅱ'; const track = tracks.find((entry) => entry.id === currentId); if (track && countedSerial !== playbackSerial) { countedSerial = playbackSerial; track.playCount = (track.playCount || 0) + 1; track.lastPlayed = Date.now(); saveRecord('tracks', track).catch(() => {}); } updateMediaSession(track); render(); };
  audio.onpause = () => { $('#playButton').textContent = '▶'; $('#miniPlay').textContent = '▶'; if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'; savePlayerState(true); render(); };
  audio.onended = () => { void advanceAfterEnded(); };
  audio.onerror = () => { $('#miniPlayer').classList.remove('loading'); if (currentId) toast("This audio file couldn't be played."); };
  let miniTouch = null, fullTouchY = null;
  $('#miniPlayer').addEventListener('touchstart', (event) => { if (event.target.closest('#miniPrevious,#miniPlay,#miniNext')) { miniTouch = null; return; } const touch = event.changedTouches[0]; miniTouch = touch ? { x: touch.clientX, y: touch.clientY, direction: null } : null; }, { passive: true });
  $('#miniPlayer').addEventListener('touchmove', (event) => { const touch = event.changedTouches[0]; if (!miniTouch || !touch) return; const dx = touch.clientX - miniTouch.x, dy = touch.clientY - miniTouch.y; if (!miniTouch.direction && Math.max(Math.abs(dx), Math.abs(dy)) > 8) miniTouch.direction = Math.abs(dx) > Math.abs(dy) * 1.25 ? 'horizontal' : 'vertical'; if (miniTouch.direction === 'horizontal') { const offset = Math.max(-30, Math.min(30, dx * 0.22)); $('#miniPlayer').style.transform = `translateX(${offset}px)`; $('#miniPlayer').classList.add('swiping'); } }, { passive: true });
  $('#miniPlayer').addEventListener('touchend', (event) => { const touch = event.changedTouches[0]; if (!miniTouch || !touch) return; const dx = touch.clientX - miniTouch.x, dy = touch.clientY - miniTouch.y; $('#miniPlayer').style.transform = ''; $('#miniPlayer').classList.remove('swiping'); if (miniTouch.direction === 'horizontal' && Math.abs(dx) > 68) { dx < 0 ? nextTrack() : previousTrack(); } else if (miniTouch.direction !== 'horizontal' && dy < -40 && Math.abs(dy) > Math.abs(dx)) openNowPlaying(); miniTouch = null; }, { passive: true });
  $('#nowPlayingScreen').addEventListener('touchstart', (event) => { fullTouchY = event.target.closest('button,input') ? null : event.changedTouches[0]?.clientY ?? null; }, { passive: true });
  $('#nowPlayingScreen').addEventListener('touchend', (event) => { const endY = event.changedTouches[0]?.clientY; if (fullTouchY !== null && endY - fullTouchY > 70) closeNowPlaying(); fullTouchY = null; }, { passive: true });
}
async function initialise() {
  try {
    await openDatabase(); await loadLibrary(); await restorePlayerState(); wireUI(); $('#volumeControl').value = audio.volume; configureMediaSession(); if (currentId) { const track = tracks.find((entry) => entry.id === currentId); showMiniPlayer(track); $('#currentTime').textContent = formatTime(restoredPosition); $('#duration').textContent = formatTime(track.duration); $('#npSeek').value = track.duration ? Math.min(100, (restoredPosition / track.duration) * 100) : 0; } render(); updatePlayerMode(); refreshStorageStatus();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js?v=13').catch(() => {});
  } catch (error) {
    $('#contentArea').innerHTML = `<div class="inline-empty">Zombie could not open local storage. ${escapeHTML(error.message || 'Try closing other Zombie tabs and reopening the app.')}</div>`;
    toast('Local music storage could not be opened');
  }
}
initialise();
window.addEventListener('pagehide', () => { savePlayerState(true); artworkUrls.forEach((url) => URL.revokeObjectURL(url)); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePlayerState(true); });
