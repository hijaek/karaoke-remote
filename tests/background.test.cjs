const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function extension() {
  let listener;
  let actionListener;
  const store = {};
  const navigations = [];
  const commands = [];
  const captures = [];
  let audioDocument = false;
  let audioStarted = false;
  const chrome = {
    runtime: {
      getURL(path) { return `chrome-extension://test/${path}`; },
      async getContexts() { return audioDocument ? [{}] : []; },
      async sendMessage(message) {
        if (message.type === 'AUDIO_SET') return { ok: true, started: audioStarted };
        if (message.type === 'AUDIO_START') audioStarted = true;
        if (message.type === 'AUDIO_STOP') audioStarted = false;
        return { ok: true };
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(callback) { listener = callback; } }
    },
    action: { onClicked: { addListener(callback) { actionListener = callback; } } },
    sidePanel: { async setPanelBehavior() {}, async open() {} },
    offscreen: {
      async createDocument() { audioDocument = true; },
      async closeDocument() { audioDocument = false; }
    },
    tabCapture: {
      onStatusChanged: { addListener() {} },
      async getMediaStreamId(options) { captures.push(options); return 'stream-id'; }
    },
    storage: { session: {
      async get(key) { return { [key]: store[key] }; },
      async set(value) { Object.assign(store, value); }
    } },
    tabs: {
      onRemoved: { addListener() {} },
      async get(id) { return { id, url: 'https://www.youtube.com/watch?v=abcdefghijk' }; },
      async update(tabId, options) { navigations.push({ tabId, ...options }); },
      async create(options) { navigations.push({ tabId: 7, ...options }); return { id: 7 }; },
      async sendMessage(tabId, message) { commands.push({ tabId, ...message }); }
    }
  };
  vm.runInNewContext(fs.readFileSync('extension/background.js', 'utf8'), { chrome, crypto: webcrypto, URL });
  const message = (payload, tabId) => new Promise(resolve => {
    listener(payload, tabId === undefined ? {} : { tab: { id: tabId } }, resolve);
  });
  return { message, actionClick: tab => actionListener(tab), navigations, commands, captures };
}

test('예약 순서대로 넘기고 지난 곡의 중복 종료 신호는 무시한다', async () => {
  const app = extension();
  await app.message({ type: 'BIND_TAB', tabId: 7 });
  await app.message({ type: 'QUEUE_ADD', videoId: 'abcdefghijk', title: '첫 곡' });
  await app.message({ type: 'QUEUE_ADD', videoId: 'lmnopqrstuv', title: '둘째 곡' });

  let response = await app.message({ type: 'QUEUE_NEXT' });
  assert.equal(response.next.title, '첫 곡');
  assert.match(app.navigations[0].url, /abcdefghijk/);

  response = await app.message({ type: 'VIDEO_ENDED', videoId: 'abcdefghijk' }, 7);
  assert.equal(response.next.title, '둘째 곡');
  assert.match(app.navigations[1].url, /lmnopqrstuv/);

  await app.message({ type: 'VIDEO_ENDED', videoId: 'abcdefghijk' }, 7);
  assert.equal(app.navigations.length, 2);
  assert.equal((await app.message({ type: 'SESSION_GET' })).session.queue.length, 0);
});

test('예약 목록의 원하는 곡을 바로 재생하고 나머지 순서는 유지한다', async () => {
  const app = extension();
  await app.message({ type: 'BIND_TAB', tabId: 7, videoId: 'abcdefghijk' });
  await app.message({ type: 'QUEUE_ADD', videoId: 'lmnopqrstuv', title: '첫 예약' });
  await app.message({ type: 'QUEUE_ADD', videoId: '123456789ab', title: '선택 예약' });
  await app.message({ type: 'QUEUE_ADD', videoId: 'ABCDEFGHIJK', title: '셋째 예약' });
  const queue = (await app.message({ type: 'SESSION_GET' })).session.queue;
  const result = await app.message({ type: 'QUEUE_PLAY', id: queue[1].id });
  assert.equal(result.next.title, '선택 예약');
  assert.match(app.navigations[0].url, /123456789ab/);
  assert.deepEqual(Array.from((await app.message({ type: 'SESSION_GET' })).session.queue, item => item.title), ['첫 예약', '셋째 예약']);
});

test('툴바 아이콘을 누르면 영상 소리를 먼저 연결해 키 버튼이 재캡처를 요구하지 않는다', async () => {
  const app = extension();
  await app.actionClick({ id: 7, windowId: 1, url: 'https://www.youtube.com/watch?v=abcdefghijk' });
  assert.equal(app.captures.length, 1);
  assert.equal((await app.message({ type: 'PITCH_SET', key: 1 })).key, 1);
  assert.equal(app.captures.length, 1);
});

test('키는 반음씩 ±5 범위에서 탭 오디오를 연결하고 원키로 복구한다', async () => {
  const app = extension();
  await app.message({ type: 'BIND_TAB', tabId: 7, videoId: 'abcdefghijk' });
  assert.equal((await app.message({ type: 'PITCH_SET', key: 1 })).key, 1);
  assert.equal(app.captures.length, 1);
  assert.equal(app.captures[0].targetTabId, 7);
  assert.equal((await app.message({ type: 'PITCH_SET', key: 2 })).key, 2);
  assert.equal(app.captures.length, 1);
  const [step1, step2] = await Promise.all([
    app.message({ type: 'PITCH_STEP', delta: 1 }),
    app.message({ type: 'PITCH_STEP', delta: 1 })
  ]);
  assert.equal(step1.key, 3);
  assert.equal(step2.key, 4);
  assert.equal((await app.message({ type: 'PITCH_SET', key: 6 })).ok, false);
  assert.equal((await app.message({ type: 'SESSION_GET' })).session.key, 4);
  assert.equal((await app.message({ type: 'PITCH_SET', key: 0 })).key, 0);
  assert.equal((await app.message({ type: 'SESSION_GET' })).session.key, 0);
});

test('다음 곡으로 넘어가면 키가 원곡으로 돌아간다', async () => {
  const app = extension();
  await app.message({ type: 'BIND_TAB', tabId: 7, videoId: 'abcdefghijk' });
  await app.message({ type: 'PITCH_SET', key: -3 });
  await app.message({ type: 'QUEUE_ADD', videoId: 'lmnopqrstuv', title: '다음 곡' });
  await app.message({ type: 'QUEUE_NEXT' });
  assert.equal((await app.message({ type: 'SESSION_GET' })).session.key, 0);
  assert.equal(app.navigations.length, 1);
});

test('예약곡 삭제와 현재 곡 취소는 서로 다른 동작이다', async () => {
  const app = extension();
  await app.message({ type: 'BIND_TAB', tabId: 7 });
  await app.message({ type: 'QUEUE_ADD', videoId: 'abcdefghijk', title: '예약곡' });
  const session = (await app.message({ type: 'SESSION_GET' })).session;
  await app.message({ type: 'QUEUE_REMOVE', id: session.queue[0].id });
  assert.equal((await app.message({ type: 'SESSION_GET' })).session.queue.length, 0);

  await app.message({ type: 'CURRENT_CANCEL' });
  assert.equal((await app.message({ type: 'SESSION_GET' })).session.stopped, true);
  assert.equal(app.commands[0].type, 'STOP');
});
