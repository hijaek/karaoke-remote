const $ = id => document.getElementById(id);
const TJ_SEARCH = 'https://www.youtube.com/@TJ%EB%85%B8%EB%9E%98%EB%B0%A9TJKaraoke/search?query=';
const TJ_CHANNEL_ID = 'UCZUhx8ClCv6paFW7qi3qljg';
const emptySession = { queue: [], tabId: null, currentVideoId: null, stopped: false, key: 0 };
let session = emptySession;
let page = null;
let searchResults = [];
let searchLoading = false;
let view = 'queue';
let chart = [];
let chartLoadedAt = 0;
let candidates = [];
let melonSearchToken = 0;
let flashText = '';
let flashTimer;
let polling = false;

function flash(text) {
  flashText = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashText = ''; render(); }, 3000);
  render();
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '요청을 처리하지 못했습니다.');
  return response;
}

async function toPage(message) {
  if (session.tabId === null) throw new Error('YouTube 탭을 먼저 열어 주세요.');
  const response = await chrome.tabs.sendMessage(session.tabId, message);
  if (!response?.ok) throw new Error(response?.error || 'YouTube 페이지에 연결할 수 없습니다.');
  return response.state;
}

async function run(action) {
  try { await action(); }
  catch (error) { flash(error.message); }
}

function youtubeTab(tab) {
  return tab?.url?.startsWith('https://www.youtube.com/');
}

async function pollPage() {
  if (polling) return;
  polling = true;
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (session.tabId !== null) {
      try { await chrome.tabs.get(session.tabId); }
      catch {
        await send({ type: 'BIND_TAB', tabId: null });
        session = (await send({ type: 'SESSION_GET' })).session;
      }
    }
    if (youtubeTab(active) && active.url.includes('/watch?') && session.tabId === null) {
      await send({ type: 'BIND_TAB', tabId: active.id, videoId: new URL(active.url).searchParams.get('v') });
      session = (await send({ type: 'SESSION_GET' })).session;
    }
    if (session.tabId !== null) {
      try { page = await toPage({ type: 'GET_PAGE_STATE' }); }
      catch { page = null; }
    } else page = null;
    render();
  } finally { polling = false; }
}

function time(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function songRow({ number, title, artist, action, onAction, onOpen, onStart }) {
  const row = document.createElement('div');
  row.className = 'song-row';
  const rank = document.createElement('span');
  rank.className = 'song-number';
  rank.textContent = String(number);
  const info = document.createElement('div');
  info.className = 'song-info';
  const name = document.createElement('span');
  name.className = 'song-title';
  name.textContent = title;
  const singer = document.createElement('span');
  singer.className = 'song-artist';
  singer.textContent = artist || '';
  info.append(name, singer);
  row.append(rank, info);
  if (onStart) {
    const startButton = document.createElement('button');
    startButton.className = 'row-action row-start';
    startButton.textContent = '▶ 시작';
    startButton.addEventListener('click', event => { event.stopPropagation(); onStart(); });
    row.append(startButton);
  }
  if (action) {
    const button = document.createElement('button');
    button.className = 'row-action';
    button.textContent = action;
    button.addEventListener('click', event => { event.stopPropagation(); onAction?.(); });
    row.append(button);
  }
  if (onOpen) {
    row.style.cursor = 'pointer';
    row.addEventListener('click', onOpen);
  }
  return row;
}

function empty(message) {
  const element = document.createElement('div');
  element.className = 'empty';
  element.textContent = message;
  return element;
}

function renderList() {
  const body = $('list-body');
  const scrollTop = body.scrollTop;
  body.replaceChildren();
  if (view === 'queue') {
    $('list-title').textContent = 'RESERVED';
    $('list-meta').textContent = `${session.queue.length}곡 대기`;
    if (!session.queue.length) body.append(empty('예약된 곡이 없습니다. 검색하거나 멜론 TOP100에서 곡을 골라 주세요.'));
    session.queue.forEach((item, index) => {
      const start = () => run(async () => {
        await send({ type: 'QUEUE_PLAY', id: item.id });
        session = (await send({ type: 'SESSION_GET' })).session;
        flash(`재생 · ${item.title}`);
      });
      body.append(songRow({
        number: String(index + 1).padStart(2, '0'), title: item.title, artist: item.artist,
        onStart: start, onOpen: start,
        action: '삭제', onAction: () => run(async () => {
          await send({ type: 'QUEUE_REMOVE', id: item.id });
          flash(`예약 취소 · ${item.title}`);
        })
      }));
    });
    body.scrollTop = scrollTop;
    return;
  }

  $('list-title').textContent = 'TJ노래방 채널';
  $('list-meta').textContent = searchLoading ? '검색 중' : searchResults.length ? `${searchResults.length}개 결과` : '';
  searchResults.forEach((item, index) => body.append(songRow({
    number: index + 1, title: item.title, artist: item.artist,
    action: '+예약', onAction: () => addVideo(item),
    onOpen: () => addVideo(item)
  })));
  if (!body.childElementCount) body.append(empty(searchLoading ? 'TJ노래방 채널에서 찾는 중입니다.' : '검색어를 입력하면 TJ노래방 채널의 결과가 이곳에 표시됩니다.'));
  body.scrollTop = scrollTop;
}

function render() {
  const connected = !!page?.videoId;
  $('connection-light').classList.toggle('on', connected && page.playing && !session.stopped);
  $('key-value').textContent = session.key > 0 ? `+${session.key}` : session.key < 0 ? String(session.key) : '±0';
  $('tempo-value').textContent = `${(page?.tempo || 1).toFixed(1)}x`;
  $('queue-count').textContent = String(session.queue.length).padStart(2, '0');
  $('play-icon').textContent = !connected || session.stopped ? '■' : page.playing ? '▶' : '❚❚';
  $('lcd-line').textContent = flashText || (session.stopped ? '현재 곡 취소됨' : connected ? page.title : 'YouTube에서 TJ노래방 영상을 여세요');
  $('time-value').textContent = connected ? `${time(page.currentTime)}/${time(page.duration)}` : '--:--';
  $('progress-bar').style.width = connected && page.duration ? `${Math.min(100, page.currentTime / page.duration * 100)}%` : '0%';
  $('play-pause').textContent = page?.playing && !session.stopped ? '일시정지' : '시작';
  $('tempo-down').disabled = !connected || (page?.tempo || 1) <= 0.5;
  $('tempo-up').disabled = !connected || (page?.tempo || 1) >= 1.5;
  $('key-down').disabled = !connected || (session.key || 0) <= -5;
  $('key-up').disabled = !connected || (session.key || 0) >= 5;
  $('reset').disabled = !connected;
  $('cancel-current').disabled = !connected || session.stopped;
  $('play-pause').disabled = !connected;
  $('next-song').disabled = !connected && session.queue.length === 0;
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === view));
  renderList();
}

async function addVideo(video) {
  try {
    await send({ type: 'QUEUE_ADD', ...video });
    session = (await send({ type: 'SESSION_GET' })).session;
    flash(`예약 완료 · ${video.title}`);
    return true;
  } catch (error) {
    flash(error.message);
    return false;
  }
}

async function openChannelSearch(query) {
  searchResults = [];
  searchLoading = true;
  view = 'search';
  render();
  try {
    searchResults = await searchTJChannel(query);
    flash(searchResults.length ? `${searchResults.length}곡을 찾았습니다` : '검색 결과가 없습니다');
  } finally {
    searchLoading = false;
    render();
  }
}

async function searchTJChannel(query) {
  const response = await fetch(TJ_SEARCH + encodeURIComponent(query.trim()), { credentials: 'omit' });
  if (!response.ok) throw new Error(`YouTube 검색 응답 ${response.status}`);
  return parseChannelSearch(await response.text());
}

function parseChart(html) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  return [...document.querySelectorAll('tr.lst50, tr.lst100')].map(row => ({
    rank: Number(row.querySelector('span.rank')?.textContent?.trim()),
    title: row.querySelector('.ellipsis.rank01 a')?.textContent?.trim() || '',
    artist: row.querySelector('.ellipsis.rank02 > a')?.textContent?.trim() || ''
  })).filter(song => song.rank >= 1 && song.rank <= 100 && song.title).sort((a, b) => a.rank - b.rank);
}

async function loadChart() {
  if (chart.length && Date.now() - chartLoadedAt < 15 * 60 * 1000) return;
  $('melon-status').textContent = '멜론 TOP100을 불러오는 중입니다';
  try {
    const response = await fetch('https://www.melon.com/chart/', { cache: 'no-store' });
    if (!response.ok) throw new Error(`멜론 응답 ${response.status}`);
    chart = parseChart(await response.text());
    if (chart.length < 50) throw new Error('차트 형식을 읽을 수 없습니다.');
    chartLoadedAt = Date.now();
    $('melon-status').textContent = `${chart.length}곡 · 순위를 눌러 TJ 영상을 예약하세요`;
    renderChart();
  } catch (error) {
    $('melon-status').textContent = `차트를 불러오지 못했습니다: ${error.message}`;
    $('melon-list').replaceChildren(empty('멜론 페이지를 열어 순위를 확인할 수 있습니다.'));
  }
}

function renderChart() {
  const list = $('melon-list');
  list.replaceChildren();
  chart.forEach(song => list.append(songRow({
    number: song.rank, title: song.title, artist: song.artist,
    action: '+예약', onAction: () => matchMelon(song), onOpen: () => matchMelon(song)
  })));
}

function normalized(text) {
  return String(text).toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function showMelonChart() {
  melonSearchToken++;
  $('melon-results').hidden = true;
  $('melon-status').hidden = false;
  $('melon-list').hidden = false;
  $('api-settings').hidden = false;
}

function rankedMatches(items, song) {
  const titleKey = normalized(song.title);
  const artistKey = normalized(song.artist);
  return items.filter(item => item.videoId && normalized(item.title).includes(titleKey))
    .sort((a, b) => Number(normalized(b.title).includes(artistKey)) - Number(normalized(a.title).includes(artistKey)));
}

async function findMelonCandidates(song) {
  const { youtubeApiKey } = await chrome.storage.local.get('youtubeApiKey');
  if (youtubeApiKey) {
    try {
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.search = new URLSearchParams({
        part: 'snippet', channelId: TJ_CHANNEL_ID, type: 'video', maxResults: '10',
        q: `${song.title} ${song.artist}`, key: youtubeApiKey
      });
      const response = await fetch(url);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'YouTube 검색에 실패했습니다.');
      const matches = rankedMatches((data.items || []).map(item => ({
        videoId: item.id?.videoId,
        title: item.snippet?.title || '', artist: item.snippet?.channelTitle || 'TJ노래방'
      })), song);
      if (matches.length) return matches;
    } catch { /* Use the channel search when the API is unavailable. */ }
  }
  let matches = rankedMatches(await searchTJChannel(`${song.title} ${song.artist}`), song);
  if (!matches.length) {
    const titleResults = await searchTJChannel(song.title);
    matches = rankedMatches(titleResults, song);
    if (!matches.length) matches = titleResults;
  }
  return matches;
}

async function matchMelon(song) {
  const token = ++melonSearchToken;
  $('melon-status').hidden = true;
  $('melon-list').hidden = true;
  $('api-settings').hidden = true;
  $('melon-results').hidden = false;
  $('melon-results-title').textContent = song.title;
  $('melon-results-status').textContent = 'TJ노래방 영상을 찾는 중입니다';
  $('melon-results-list').replaceChildren(empty('검색 중입니다.'));
  try {
    const matches = await findMelonCandidates(song);
    if (token !== melonSearchToken) return;
    candidates = matches;
    $('melon-results-status').textContent = matches.length ? `${matches.length}개 영상 · 부를 버전을 예약하세요` : '일치하는 TJ노래방 영상을 찾지 못했습니다';
    renderCandidates();
  } catch (error) {
    if (token !== melonSearchToken) return;
    $('melon-results-status').textContent = `검색 실패: ${error.message}`;
    $('melon-results-list').replaceChildren(empty('TOP100으로 돌아가 다른 곡을 선택해 주세요.'));
  }
}

function renderCandidates() {
  const list = $('melon-results-list');
  list.replaceChildren();
  if (!candidates.length) {
    list.append(empty('이 곡의 TJ노래방 영상을 찾지 못했습니다.'));
    return;
  }
  candidates.forEach((item, index) => list.append(songRow({
    number: index + 1, title: item.title, artist: item.artist,
    action: '+예약', onAction: () => reserveMelonCandidate(item),
    onOpen: () => reserveMelonCandidate(item)
  })));
}

async function reserveMelonCandidate(item) {
  try {
    await send({ type: 'QUEUE_ADD', ...item });
    session = (await send({ type: 'SESSION_GET' })).session;
    $('melon-results-status').textContent = `예약 완료 · ${item.title}`;
  } catch (error) {
    $('melon-results-status').textContent = `예약 실패: ${error.message}`;
  }
}

$('search-form').addEventListener('submit', event => {
  event.preventDefault();
  const query = $('search-query').value.trim();
  if (query) run(() => openChannelSearch(query));
});
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  if (tab.dataset.tab === 'melon') {
    showMelonChart();
    $('melon-screen').hidden = false;
    loadChart();
  } else { view = tab.dataset.tab; render(); }
}));
$('melon-back').addEventListener('click', () => { showMelonChart(); $('melon-screen').hidden = true; });
$('melon-results-back').addEventListener('click', showMelonChart);
$('tempo-down').addEventListener('click', () => run(async () => {
  page = await toPage({ type: 'SET_TEMPO', tempo: Math.round((page.tempo - 0.1) * 10) / 10 });
  flash(`템포 ${page.tempo.toFixed(1)}x`);
}));
$('tempo-up').addEventListener('click', () => run(async () => {
  page = await toPage({ type: 'SET_TEMPO', tempo: Math.round((page.tempo + 0.1) * 10) / 10 });
  flash(`템포 ${page.tempo.toFixed(1)}x`);
}));
$('key-down').addEventListener('click', () => run(async () => {
  const result = await send({ type: 'PITCH_STEP', delta: -1 });
  session.key = result.key;
  flash(`키 ${result.key > 0 ? '+' : ''}${result.key}반음`);
}));
$('key-up').addEventListener('click', () => run(async () => {
  const result = await send({ type: 'PITCH_STEP', delta: 1 });
  session.key = result.key;
  flash(`키 ${result.key > 0 ? '+' : ''}${result.key}반음`);
}));
$('reset').addEventListener('click', () => run(async () => {
  await send({ type: 'PITCH_SET', key: 0 });
  session.key = 0;
  page = await toPage({ type: 'SET_TEMPO', tempo: 1 });
  flash('원키 · 원템포');
}));
$('play-pause').addEventListener('click', () => run(async () => {
  page = await toPage({ type: 'PLAY_PAUSE' });
  if (page.playing && session.stopped) {
    await send({ type: 'CURRENT_RESUME' });
    session = (await send({ type: 'SESSION_GET' })).session;
  }
  render();
}));
$('cancel-current').addEventListener('click', () => run(async () => {
  await send({ type: 'CURRENT_CANCEL' });
  session = (await send({ type: 'SESSION_GET' })).session;
  flash('현재 곡 취소');
}));
$('next-song').addEventListener('click', () => run(async () => {
  const result = await send({ type: 'QUEUE_NEXT' });
  session = (await send({ type: 'SESSION_GET' })).session;
  flash(result.empty ? '예약된 다음 곡이 없습니다' : `다음곡 · ${result.next.title}`);
}));
$('api-settings-toggle').addEventListener('click', () => {
  $('api-settings-body').hidden = !$('api-settings-body').hidden;
});
$('save-api-key').addEventListener('click', () => run(async () => {
  await chrome.storage.local.set({ youtubeApiKey: $('api-key').value.trim() });
  $('api-settings-body').hidden = true;
  $('melon-status').textContent = '검색 API 설정을 저장했습니다';
}));
chrome.storage.onChanged.addListener(changes => {
  if (changes.karaokeSession) { session = changes.karaokeSession.newValue || emptySession; render(); }
});

run(async () => {
  session = (await send({ type: 'SESSION_GET' })).session;
  const { youtubeApiKey } = await chrome.storage.local.get('youtubeApiKey');
  $('api-key').value = youtubeApiKey || '';
  await pollPage();
  setInterval(pollPage, 1000);
});
