const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('YouTube 페이지 제어가 실제 재생속도와 정지 상태를 반환한다', async () => {
  let listener;
  const events = {};
  const video = {
    playbackRate: 1, currentTime: 37, duration: 180, paused: false, ended: false,
    addEventListener(name, callback) { events[name] = callback; },
    removeEventListener() {},
    pause() { this.paused = true; },
    async play() { this.paused = false; }
  };
  const sent = [];
  const chrome = { runtime: {
    onMessage: { addListener(callback) { listener = callback; } },
    async sendMessage(message) { sent.push(message); }
  } };
  const document = {
    title: '테스트 영상 - YouTube',
    querySelector(selector) {
      if (selector.includes('#channel-name')) return { textContent: 'TJ노래방 TJKaraoke', href: '/@TJ노래방TJKaraoke' };
      if (selector.includes('h1')) return { textContent: '테스트 영상' };
      if (selector.includes('video')) return video;
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener() {}
  };
  const location = { href: 'https://www.youtube.com/watch?v=abcdefghijk', origin: 'https://www.youtube.com', pathname: '/watch' };
  vm.runInNewContext(fs.readFileSync('extension/youtube.js', 'utf8'), {
    chrome, document, location, window: { addEventListener() {} }, URL,
    setInterval() {}, setTimeout
  });
  const message = payload => new Promise(resolve => listener(payload, {}, resolve));

  const tempo = await message({ type: 'SET_TEMPO', tempo: 1.1 });
  assert.equal(tempo.state.tempo, 1.1);
  assert.equal(tempo.state.isTjVideo, true);
  assert.equal(video.playbackRate, 1.1);

  const stopped = await message({ type: 'STOP' });
  assert.equal(stopped.state.playing, false);
  assert.equal(video.currentTime, 0);

  events.ended();
  assert.equal(sent.at(-1).type, 'VIDEO_ENDED');
});
