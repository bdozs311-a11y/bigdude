const $ = (selector) => document.querySelector(selector);
const DB_NAME = 'my-sounds-db';
const DB_VERSION = 4;
const EMOJIS = ['🧟', '🧟‍♀️', '🦇', '🕸️', '🖤', '🪦', '🌙', '⚡', '👻', '🕯️', '💀', '🦴'];
const SUPPORTED_FILES = /\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|webm)$/i;
const audio = $('#audio');
let db;
let tracks = [], playlists = [];
let currentId = null, currentUrl = null, loadToken = 0;
let currentView = 'songs', collectionFilter = null, activePlaylistId = null;
let queue = [], queueIndex = -1, shuffleOn = false, shuffleBag = [], shuffleHistory = [];
let repeatMode = 'off';

const randomEmoji = () => EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
const formatTime = (seconds) => !Number.isFinite(seconds) ? '0:00' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const formatBytes = (bytes = 0) => bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
const escapeHTML = (value = '') => { const element = document.createElement('span'); element.textContent = value; return element.innerHTML; };

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
    emoji: track.emoji || randomEmoji(),
    isFavorite: Boolean(track.isFavorite),
    type: track.type || 'audio/mpeg',
  }));
  playlists = playlists.map((playlist) => ({ ...playlist, trackIds: Array.isArray(playlist.trackIds) ? playlist.trackIds : [] }));
}

function visibleTracks() {
  const search = $('#searchInput').value.trim().toLowerCase();
  let list = [...tracks];
  if (currentView === 'recent') list.sort((a, b) => b.addedAt - a.addedAt);
  if (currentView === 'favorites') list = list.filter((track) => track.isFavorite);
  if (collectionFilter?.type === 'album') list = list.filter((track) => track.album === collectionFilter.value);
  if (collectionFilter?.type === 'artist') list = list.filter((track) => track.artist === collectionFilter.value);
  if (search) list = list.filter((track) => `${track.title} ${track.artist} ${track.album}`.toLowerCase().includes(search));
  const sort = $('#sortSelect').value;
  if (currentView !== 'recent' || sort !== 'recent') {
    if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === 'artist') list.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
    if (sort === 'album') list.sort((a, b) => a.album.localeCompare(b.album) || a.title.localeCompare(b.title));
    if (sort === 'recent') list.sort((a, b) => b.addedAt - a.addedAt);
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
  else if (currentView === 'playlists') renderPlaylists(area);
  else renderTrackList(area, visibleTracks());
}
function renderTrackList(area, list, playlist = null) {
  $('#librarySummary').textContent = `${list.length} ${list.length === 1 ? 'song' : 'songs'}`;
  $('#emptyState').style.display = list.length || ['albums', 'artists', 'playlists'].includes(currentView) ? 'none' : 'block';
  if (!list.length) {
    area.innerHTML = currentView === 'favorites' ? '<div class="inline-empty">No favorites yet. Tap ♡ on a song to save it here.</div>' : playlist ? '<div class="inline-empty">This playlist is empty. Add songs from your library.</div>' : '';
    return;
  }
  list.forEach((track, position) => {
    const item = document.createElement('article'); item.className = `track ${track.id === currentId ? 'active' : ''}`;
    item.innerHTML = `<button class="track-main" aria-label="Play ${escapeHTML(track.title)}"><span class="cover">${track.emoji}</span><span class="track-copy"><strong>${escapeHTML(track.title)}</strong><small>${escapeHTML(track.artist)} · ${escapeHTML(track.album)}</small></span></button><button class="favorite ${track.isFavorite ? 'selected' : ''}" aria-label="${track.isFavorite ? 'Remove from' : 'Add to'} favorites">${track.isFavorite ? '♥' : '♡'}</button><button class="more" aria-label="Add ${escapeHTML(track.title)} to playlist">⋯</button>${playlist ? `<span class="reorder"><button aria-label="Move song up">↑</button><button aria-label="Move song down">↓</button><button aria-label="Remove from playlist">×</button></span>` : '<button class="delete" aria-label="Delete from device">×</button>'}`;
    item.querySelector('.track-main').onclick = () => playTrack(track.id, list.map((entry) => entry.id));
    item.querySelector('.favorite').onclick = () => toggleFavorite(track.id);
    item.querySelector('.more').onclick = () => openPlaylistSheet(track.id);
    if (playlist) {
      const [up, down, removeButton] = item.querySelectorAll('.reorder button');
      up.onclick = () => reorderPlaylist(playlist.id, position, position - 1);
      down.onclick = () => reorderPlaylist(playlist.id, position, position + 1);
      removeButton.onclick = () => removeFromPlaylist(playlist.id, track.id);
      up.disabled = position === 0; down.disabled = position === list.length - 1;
    } else item.querySelector('.delete').onclick = () => deleteTrack(track.id);
    area.append(item);
  });
}
function renderCollections(area, type) {
  const key = type === 'album' ? 'album' : 'artist';
  const groups = new Map();
  tracks.forEach((track) => { const group = groups.get(track[key]) || []; group.push(track); groups.set(track[key], group); });
  const entries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  $('#librarySummary').textContent = `${entries.length} ${type}${entries.length === 1 ? '' : 's'}`;
  $('#emptyState').style.display = entries.length ? 'none' : 'block';
  entries.forEach(([name, group]) => {
    const card = document.createElement('button'); card.className = 'collection-card';
    card.innerHTML = `<span class="collection-art">${group[0].emoji}</span><span><strong>${escapeHTML(name)}</strong><small>${group.length} ${group.length === 1 ? 'song' : 'songs'}${type === 'album' ? ` · ${escapeHTML(group[0].artist)}` : ''}</small></span><b>›</b>`;
    card.onclick = () => { collectionFilter = { type, value: name }; currentView = 'songs'; render(); };
    area.append(card);
  });
}
function renderPlaylists(area) {
  $('#librarySummary').textContent = `${playlists.length} ${playlists.length === 1 ? 'playlist' : 'playlists'}`;
  $('#emptyState').style.display = playlists.length ? 'none' : 'block';
  const create = document.createElement('button'); create.className = 'create-playlist'; create.textContent = '+ Create playlist'; create.onclick = createPlaylist; area.append(create);
  playlists.forEach((playlist) => {
    const card = document.createElement('article'); card.className = 'playlist-card';
    card.innerHTML = `<button class="playlist-open"><span>☠</span><span><strong>${escapeHTML(playlist.name)}</strong><small>${playlist.trackIds.length} ${playlist.trackIds.length === 1 ? 'song' : 'songs'}</small></span></button><button class="playlist-menu" aria-label="Playlist options">⋯</button>`;
    card.querySelector('.playlist-open').onclick = () => { activePlaylistId = playlist.id; render(); };
    card.querySelector('.playlist-menu').onclick = () => openPlaylistOptions(playlist.id);
    area.append(card);
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
  const token = ++loadToken;
  if (sourceIds?.length) { queue = [...new Set(sourceIds)]; queueIndex = queue.indexOf(id); if (shuffleOn) refillShuffleBag(); }
  else if (!queue.includes(id)) { queue = visibleTracks().map((entry) => entry.id); queueIndex = queue.indexOf(id); if (shuffleOn) refillShuffleBag(); }
  if (currentId === id && audio.src) { audio.paused ? audio.play() : audio.pause(); return; }
  showMiniPlayer(track); audio.pause();
  if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  try {
    const blob = await getAudioBlob(id);
    if (token !== loadToken) return;
    if (!blob) { toast('This song is missing from device storage'); return; }
    currentUrl = URL.createObjectURL(blob); currentId = id; audio.src = currentUrl; audio.load();
    syncNowPlaying(track); render();
    await audio.play();
  } catch (error) {
    if (token === loadToken) toast('Zombie could not play this file');
  }
}
function showMiniPlayer(track) { $('#miniPlayer').classList.remove('hidden'); syncNowPlaying(track); }
function syncNowPlaying(track = tracks.find((entry) => entry.id === currentId)) {
  if (!track) return;
  $('#nowTitle').textContent = track.title; $('#nowArtist').textContent = track.artist;
  $('#miniArt').textContent = track.emoji; $('#npArt').textContent = track.emoji;
  $('#npTitle').textContent = track.title; $('#npArtist').textContent = `${track.artist} · ${track.album}`;
  $('#npFavorite').textContent = track.isFavorite ? '♥' : '♡';
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
      const track = { id: crypto.randomUUID(), ...metadata, type: file.type || 'audio/mpeg', size: file.size, fingerprint, emoji: randomEmoji(), isFavorite: false, addedAt: Date.now(), blobStored: true };
      await saveTrack(track, file); tracks.unshift(track); saved += 1;
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
  const transaction = db.transaction(['tracks', 'audioBlobs'], 'readwrite'); transaction.objectStore('tracks').delete(id); transaction.objectStore('audioBlobs').delete(id);
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
  $('#sheet').classList.remove('hidden');
}
async function addToPlaylist(playlistId, trackId) {
  const playlist = playlists.find((entry) => entry.id === playlistId); if (!playlist) return;
  if (playlist.trackIds.includes(trackId)) { toast('Already in that playlist'); return; }
  playlist.trackIds.push(trackId); await savePlaylist(playlist); closeSheet(); toast(`Added to ${playlist.name}`);
}
function openPlaylistOptions(id) {
  const playlist = playlists.find((entry) => entry.id === id); if (!playlist) return;
  $('#sheetTitle').textContent = playlist.name; $('#sheetContent').innerHTML = '<button class="sheet-option" data-option="rename">Rename playlist</button><button class="sheet-option danger-text" data-option="delete">Delete playlist</button>';
  $('#sheetContent').querySelector('[data-option="rename"]').onclick = async () => { const name = prompt('New playlist name', playlist.name); if (name?.trim()) { playlist.name = name.trim(); await savePlaylist(playlist); render(); } closeSheet(); };
  $('#sheetContent').querySelector('[data-option="delete"]').onclick = async () => { if (confirm(`Delete playlist “${playlist.name}”? Songs will stay on your iPhone.`)) { await deleteRecord('playlists', id); playlists = playlists.filter((entry) => entry.id !== id); if (activePlaylistId === id) activePlaylistId = null; render(); } closeSheet(); };
  $('#sheet').classList.remove('hidden');
}
async function removeFromPlaylist(playlistId, trackId) { const playlist = playlists.find((entry) => entry.id === playlistId); if (!playlist) return; playlist.trackIds = playlist.trackIds.filter((entry) => entry !== trackId); await savePlaylist(playlist); render(); }
async function reorderPlaylist(playlistId, from, to) { const playlist = playlists.find((entry) => entry.id === playlistId); if (!playlist || to < 0 || to >= playlist.trackIds.length) return; [playlist.trackIds[from], playlist.trackIds[to]] = [playlist.trackIds[to], playlist.trackIds[from]]; await savePlaylist(playlist); render(); }
function closeSheet() { $('#sheet').classList.add('hidden'); }

async function refreshStorageStatus() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    const usage = estimate?.usage || tracks.reduce((sum, track) => sum + (track.size || 0), 0);
    const quota = estimate?.quota;
    $('#storageStatus').textContent = `${formatBytes(usage)} used${quota ? ` of ${formatBytes(quota)}` : ''} · ${tracks.length} songs`;
    const persisted = await navigator.storage?.persisted?.();
    $('#persistenceStatus').textContent = persisted ? 'Storage protection is enabled.' : 'Ask iPhone to protect this library from cleanup.';
  } catch { $('#storageStatus').textContent = `${tracks.length} songs stored on this device`; }
}
async function requestPersistentStorage() {
  try { const granted = await navigator.storage?.persist?.(); await refreshStorageStatus(); toast(granted ? 'Zombie storage is protected' : 'iPhone manages storage automatically'); } catch { toast('Storage protection is unavailable here'); }
}
async function clearAllMusic() {
  if (!confirm('Clear every song, favorite, and playlist from this iPhone? This cannot be undone.')) return;
  const transaction = db.transaction(['tracks', 'audioBlobs', 'playlists'], 'readwrite');
  ['tracks', 'audioBlobs', 'playlists'].forEach((name) => transaction.objectStore(name).clear());
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
  audio.pause(); audio.removeAttribute('src'); audio.load(); if (currentUrl) URL.revokeObjectURL(currentUrl);
  tracks = []; playlists = []; queue = []; currentId = null; currentUrl = null; activePlaylistId = null; $('#miniPlayer').classList.add('hidden'); render(); refreshStorageStatus(); toast('All music cleared from this device');
}

function wireUI() {
  $('#importButton').onclick = () => $('#fileInput').click(); $('#chooseFiles').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (event) => { importFiles(event.target.files); event.target.value = ''; };
  $('#searchInput').oninput = () => { activePlaylistId = null; render(); }; $('#sortSelect').onchange = render;
  document.querySelectorAll('.tab').forEach((button) => button.onclick = () => { currentView = button.dataset.view; collectionFilter = null; activePlaylistId = null; render(); });
  document.querySelectorAll('.bottom-nav button').forEach((button) => button.onclick = () => { currentView = button.dataset.nav === 'settings' ? 'settings' : 'songs'; collectionFilter = null; activePlaylistId = null; render(); });
  $('#storageRefresh').onclick = refreshStorageStatus; $('#persistenceButton').onclick = requestPersistentStorage; $('#clearMusicButton').onclick = clearAllMusic;
  $('[data-action="back-to-library"]').onclick = () => { currentView = 'songs'; render(); };
  $('#openNowPlaying').onclick = () => $('#nowPlayingScreen').classList.remove('hidden'); $('#closeNowPlaying').onclick = () => $('#nowPlayingScreen').classList.add('hidden');
  $('#miniPlay').onclick = () => audio.paused ? audio.play() : audio.pause(); $('#miniNext').onclick = () => nextTrack(); $('#miniPrevious').onclick = previousTrack;
  $('#playButton').onclick = () => audio.paused ? audio.play() : audio.pause(); $('#nextButton').onclick = () => nextTrack(); $('#previousButton').onclick = previousTrack;
  $('#backButton').onclick = () => audio.currentTime = Math.max(0, audio.currentTime - 10); $('#forwardButton').onclick = () => audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10);
  $('#shuffleButton').onclick = () => { shuffleOn = !shuffleOn; if (shuffleOn) refillShuffleBag(); updatePlayerMode(); toast(shuffleOn ? 'Shuffle on' : 'Shuffle off'); };
  $('#repeatButton').onclick = () => { repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'; updatePlayerMode(); toast(`Repeat ${repeatMode}`); };
  $('#npSeek').oninput = (event) => { if (audio.duration) audio.currentTime = (event.target.value / 100) * audio.duration; };
  $('#volumeControl').oninput = (event) => { audio.volume = Number(event.target.value); };
  $('#npFavorite').onclick = () => currentId && toggleFavorite(currentId); $('#npMore').onclick = () => currentId && openPlaylistSheet(currentId);
  $('#sheetClose').onclick = closeSheet; $('#sheet').onclick = (event) => { if (event.target === $('#sheet')) closeSheet(); };
  const importArea = $('#importArea'); ['dragenter', 'dragover'].forEach((type) => importArea.addEventListener(type, (event) => { event.preventDefault(); importArea.classList.add('dragging'); })); ['dragleave', 'drop'].forEach((type) => importArea.addEventListener(type, (event) => { event.preventDefault(); importArea.classList.remove('dragging'); })); importArea.addEventListener('drop', (event) => importFiles(event.dataTransfer.files));
  audio.ontimeupdate = () => { const percent = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0; $('#npSeek').value = percent; $('#currentTime').textContent = formatTime(audio.currentTime); };
  audio.onloadedmetadata = () => { $('#duration').textContent = formatTime(audio.duration); };
  audio.onplay = () => { $('#playButton').textContent = 'Ⅱ'; $('#miniPlay').textContent = 'Ⅱ'; };
  audio.onpause = () => { $('#playButton').textContent = '▶'; $('#miniPlay').textContent = '▶'; };
  audio.onended = () => nextTrack(true);
  audio.onerror = () => { if (currentId) toast('This audio file cannot be played on this iPhone'); };
}
async function initialise() {
  try {
    await openDatabase(); await loadLibrary(); wireUI(); render(); updatePlayerMode(); refreshStorageStatus();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js?v=6').catch(() => {});
  } catch (error) {
    $('#contentArea').innerHTML = `<div class="inline-empty">Zombie could not open local storage. ${escapeHTML(error.message || 'Try closing other Zombie tabs and reopening the app.')}</div>`;
    toast('Local music storage could not be opened');
  }
}
initialise();
