const SESSION_KEY = 'karaokeSession';
const emptySession = () => ({ queue: [], tabId: null, currentVideoId: null, stopped: false, lastEndedId: null, key: 0 });
let pending = Promise.resolve();
let creatingOffscreen;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  if (!tab.url?.startsWith('https://www.youtube.com/')) return;
  return serialize(async () => {
    const session = await readSession();
    if (session.tabId !== tab.id) await stopAudio();
    session.tabId = tab.id;
    session.currentVideoId = new URL(tab.url).searchParams.get('v');
    session.stopped = false;
    session.lastEndedId = null;
    session.key = 0;
    await ensureAudioDocument();
    const existing = await toAudio({ type: 'AUDIO_SET', tabId: tab.id, key: 0 });
    if (!existing.started) {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      await toAudio({ type: 'AUDIO_START', tabId: tab.id, streamId, key: 0 });
    }
    await saveSession(session);
  }).catch(error => console.error('탭 소리 연결 실패:', error));
});

async function readSession() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return stored[SESSION_KEY] || emptySession();
}

async function saveSession(session) {
  await chrome.storage.session.set({ [SESSION_KEY]: session });
  return session;
}

function serialize(operation) {
  const result = pending.then(operation);
  pending = result.catch(() => {});
  return result;
}

async function audioDocumentExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('audio.html')]
  });
  return contexts.length > 0;
}

async function ensureAudioDocument() {
  if (await audioDocumentExists()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'audio.html',
      reasons: ['USER_MEDIA'],
      justification: 'Apply real-time key changes to the karaoke tab audio and play it back.'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function toAudio(message) {
  const response = await chrome.runtime.sendMessage({ target: 'audio', ...message });
  if (!response?.ok) throw new Error(response?.error || '오디오 처리를 시작하지 못했습니다.');
  return response;
}

async function stopAudio() {
  if (!await audioDocumentExists()) return;
  try { await toAudio({ type: 'AUDIO_STOP' }); }
  catch { /* A crashed audio document can still be closed. */ }
  await chrome.offscreen.closeDocument();
}

async function resetAudio() {
  if (!await audioDocumentExists()) return;
  await toAudio({ type: 'AUDIO_SET', key: 0 });
}

async function setKey(session, key) {
  if (!Number.isInteger(key) || key < -5 || key > 5) throw new Error('키는 ±5반음까지 조절할 수 있습니다.');
  if (key === 0) {
    await resetAudio();
    session.key = 0;
    await saveSession(session);
    return { ok: true, key: 0 };
  }
  if (session.tabId === null || !session.currentVideoId) throw new Error('YouTube 노래방 영상을 먼저 열어 주세요.');
  const tab = await chrome.tabs.get(session.tabId);
  if (!tab.url?.startsWith('https://www.youtube.com/watch?')) throw new Error('YouTube 영상 탭에서 키를 조절해 주세요.');
  await ensureAudioDocument();
  const active = await toAudio({ type: 'AUDIO_SET', tabId: session.tabId, key });
  if (!active.started) {
    let streamId;
    try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: session.tabId }); }
    catch (error) { throw new Error(`탭 소리를 캡처할 수 없습니다. 영상 탭에서 확장 프로그램 아이콘을 눌러 주세요. (${error.message})`); }
    await toAudio({ type: 'AUDIO_START', tabId: session.tabId, streamId, key });
  }
  session.key = key;
  await saveSession(session);
  return { ok: true, key };
}

async function advance(session, selectedId = null) {
  const selectedIndex = selectedId === null ? 0 : session.queue.findIndex(item => item.id === selectedId);
  if (selectedId !== null && selectedIndex < 0) throw new Error('예약 목록에서 곡을 찾지 못했습니다.');
  await resetAudio();
  session.key = 0;
  if (session.queue.length === 0) {
    session.stopped = true;
    await saveSession(session);
    if (session.tabId !== null) {
      chrome.tabs.sendMessage(session.tabId, { type: 'STOP' }).catch(() => {});
    }
    return { ok: true, empty: true };
  }

  const [next] = session.queue.splice(selectedIndex, 1);
  session.currentVideoId = next.videoId;
  session.stopped = false;
  session.lastEndedId = null;
  await saveSession(session);
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(next.videoId)}&autoplay=1`;
  if (session.tabId !== null) {
    try { await chrome.tabs.update(session.tabId, { url }); }
    catch { session.tabId = null; }
  }
  if (session.tabId === null) {
    const tab = await chrome.tabs.create({ url });
    session.tabId = tab.id;
    await saveSession(session);
  }
  return { ok: true, next };
}

async function handle(message, sender) {
  if (message.type === 'SESSION_GET') return { ok: true, session: await readSession() };

  return serialize(async () => {
    const session = await readSession();
    switch (message.type) {
      case 'BIND_TAB':
        if (session.tabId !== message.tabId || session.currentVideoId !== (message.videoId || null)) {
          if (session.tabId !== message.tabId) await stopAudio();
          else await resetAudio();
          session.key = 0;
        }
        session.tabId = message.tabId;
        session.currentVideoId = message.videoId || null;
        session.lastEndedId = null;
        session.stopped = false;
        await saveSession(session);
        return { ok: true };
      case 'QUEUE_ADD': {
        const videoId = String(message.videoId || '');
        if (!/^[\w-]{11}$/.test(videoId)) throw new Error('올바른 YouTube 영상이 아닙니다.');
        session.queue.push({
          id: crypto.randomUUID(),
          videoId,
          title: String(message.title || '제목 없는 영상').slice(0, 200),
          artist: String(message.artist || '').slice(0, 100)
        });
        await saveSession(session);
        return { ok: true };
      }
      case 'QUEUE_REMOVE':
        session.queue = session.queue.filter(item => item.id !== message.id);
        await saveSession(session);
        return { ok: true };
      case 'QUEUE_NEXT':
        return advance(session);
      case 'QUEUE_PLAY':
        return advance(session, message.id);
      case 'PITCH_SET':
        return setKey(session, message.key);
      case 'PITCH_STEP':
        if (message.delta !== -1 && message.delta !== 1) throw new Error('올바른 키 조절값이 아닙니다.');
        return setKey(session, (session.key || 0) + message.delta);
      case 'CURRENT_CANCEL':
        await resetAudio();
        session.key = 0;
        session.stopped = true;
        await saveSession(session);
        if (session.tabId !== null) {
          chrome.tabs.sendMessage(session.tabId, { type: 'STOP' }).catch(() => {});
        }
        return { ok: true };
      case 'CURRENT_RESUME':
        session.stopped = false;
        await saveSession(session);
        return { ok: true };
      case 'VIDEO_CHANGED':
        if (sender.tab?.id !== session.tabId || !message.videoId) return { ok: true };
        if (session.currentVideoId !== message.videoId) {
          await resetAudio();
          session.key = 0;
          session.currentVideoId = message.videoId;
          session.lastEndedId = null;
          session.stopped = false;
          await saveSession(session);
        }
        return { ok: true };
      case 'VIDEO_ENDED':
        if (sender.tab?.id !== session.tabId || session.stopped) return { ok: true };
        if (session.currentVideoId !== message.videoId) return { ok: true };
        if (session.lastEndedId === message.videoId) return { ok: true };
        session.lastEndedId = message.videoId;
        await saveSession(session);
        return advance(session);
      case 'AUDIO_STOPPED':
        if (sender.url !== chrome.runtime.getURL('audio.html') || message.tabId !== session.tabId) return { ok: true };
        session.key = 0;
        await saveSession(session);
        return { ok: true };
      default:
        return { ok: false, error: '알 수 없는 명령입니다.' };
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'audio') return false;
  handle(message, sender).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  serialize(async () => {
    const session = await readSession();
    if (session.tabId !== tabId) return;
    await stopAudio();
    session.tabId = null;
    session.currentVideoId = null;
    session.key = 0;
    await saveSession(session);
  }).catch(() => {});
});

chrome.tabCapture.onStatusChanged.addListener(({ tabId, status }) => {
  if (status !== 'stopped' && status !== 'error') return;
  serialize(async () => {
    const session = await readSession();
    if (session.tabId !== tabId || !session.key) return;
    session.key = 0;
    await saveSession(session);
  }).catch(() => {});
});
