function parseChannelSearch(html) {
  const marker = 'var ytInitialData = ';
  const start = html.indexOf(marker);
  const begin = start < 0 ? -1 : start + marker.length;
  const end = begin < 0 ? -1 : html.indexOf(';</script>', begin);
  if (end < 0) throw new Error('YouTube 검색 결과 형식이 변경되었습니다.');
  const data = JSON.parse(html.slice(begin, end));
  const results = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value.videoRenderer) {
      const video = value.videoRenderer;
      const title = video.title?.runs?.map(run => run.text).join('') || video.title?.simpleText || '';
      if (/^[\w-]{11}$/.test(video.videoId || '') && title) {
        results.push({ videoId: video.videoId, title, artist: 'TJ노래방' });
      }
    }
    Object.values(value).forEach(visit);
  }
  visit(data);
  return results.filter((item, index) => results.findIndex(other => other.videoId === item.videoId) === index).slice(0, 30);
}
