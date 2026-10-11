const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('TJ 채널 검색 HTML에서 영상만 추출하고 중복을 제거한다', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync('extension/channel-search.js', 'utf8'), context);
  const html = `<script>var ytInitialData = ${JSON.stringify({
    contents: [
      { videoRenderer: { videoId: 'abcdefghijk', title: { runs: [{ text: '첫 곡' }] } } },
      { videoRenderer: { videoId: 'abcdefghijk', title: { runs: [{ text: '첫 곡' }] } } },
      { videoRenderer: { videoId: 'lmnopqrstuv', title: { simpleText: '둘째 곡' } } }
    ]
  })};</script>`;
  const songs = context.parseChannelSearch(html);
  assert.deepEqual(Array.from(songs, song => song.title), ['첫 곡', '둘째 곡']);
});
