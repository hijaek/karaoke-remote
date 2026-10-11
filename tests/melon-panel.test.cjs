const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function panel(videos) {
  class Element {
    constructor() {
      this.children = [];
      this.listeners = {};
      this.style = {};
      this.classList = { toggle() {} };
      this.hidden = false;
      this.scrollTop = 0;
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    get childElementCount() { return this.children.length; }
  }

  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get('melon-screen').hidden = false;
  get('melon-results').hidden = true;
  const queue = [];
  const chrome = {
    runtime: { async sendMessage(message) {
      if (message.type === 'SESSION_GET') return { ok: true, session: { queue, tabId: null, key: 0 } };
      if (message.type === 'QUEUE_ADD') queue.push(message);
      return { ok: true };
    } },
    tabs: { async query() { return []; } },
    storage: {
      local: { async get() { return {}; } },
      onChanged: { addListener() {} }
    }
  };
  const html = `<script>var ytInitialData = ${JSON.stringify({ contents: videos.map(video => ({
    videoRenderer: { videoId: video.id, title: { runs: [{ text: video.title }] } }
  })) })};</script>`;
  const context = vm.createContext({
    chrome, URL, URLSearchParams,
    document: {
      getElementById: get,
      createElement: () => new Element(),
      querySelectorAll: () => []
    },
    fetch: async () => ({ ok: true, async text() { return html; } }),
    setTimeout() {}, clearTimeout() {}, setInterval() {}
  });
  vm.runInContext(fs.readFileSync('extension/channel-search.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('extension/panel.js', 'utf8'), context);
  return { context, get, queue };
}

test('멜론 곡에 영상 후보가 하나여도 모달 안에 남고 선택 후 예약된다', async () => {
  const app = panel([{ id: 'abcdefghijk', title: '[TJ노래방] 소녀 - 이문세' }]);
  await vm.runInContext("matchMelon({ title: '소녀', artist: '이문세' })", app.context);
  assert.equal(app.get('melon-screen').hidden, false);
  assert.equal(app.get('melon-results').hidden, false);
  assert.equal(app.get('melon-list').hidden, true);
  assert.equal(app.get('melon-results-list').children.length, 1);
  assert.equal(app.get('melon-results-list').children[0].children[2].textContent, '+예약');
  assert.equal(app.queue.length, 0);

  await vm.runInContext('reserveMelonCandidate(candidates[0])', app.context);
  assert.equal(app.queue.length, 1);
  assert.match(app.get('melon-results-status').textContent, /예약 완료/);
  assert.equal(app.get('melon-results').hidden, false);
});

test('멜론 곡에 영상 후보가 여러 개면 같은 모달에서 모두 선택할 수 있다', async () => {
  const app = panel([
    { id: 'abcdefghijk', title: '[TJ노래방] 소녀 - 이문세' },
    { id: 'lmnopqrstuv', title: '[TJ노래방 / 여자키] 소녀 - 이문세' }
  ]);
  await vm.runInContext("matchMelon({ title: '소녀', artist: '이문세' })", app.context);
  assert.equal(app.get('melon-results-list').children.length, 2);
  assert.match(app.get('melon-results-status').textContent, /2개 영상/);
  assert.equal(app.get('melon-screen').hidden, false);
  assert.equal(app.queue.length, 0);
});
