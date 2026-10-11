let observedVideo = null;
let observedId = null;

function videoIdFromUrl(url) {
  try { return new URL(url, location.origin).searchParams.get('v'); }
  catch { return null; }
}

function currentVideo() {
  return document.querySelector('video.html5-main-video') || document.querySelector('video');
}

function snapshot() {
  const video = currentVideo();
  const videoId = videoIdFromUrl(location.href);
  const owner = document.querySelector('ytd-video-owner-renderer #channel-name a, ytd-watch-metadata #owner a, #upload-info ytd-channel-name a');
  const title = document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata')?.textContent?.trim()
    || document.title.replace(/\s*-\s*YouTube$/, '').trim();
  return {
    url: location.href,
    videoId,
    title,
    owner: owner?.textContent?.trim() || '',
    isTjVideo: !!videoId && /TJ노래방|TJ\s*Karaoke/i.test(`${owner?.textContent || ''} ${owner?.href || ''}`),
    playing: !!video && !video.paused && !video.ended,
    currentTime: video?.currentTime || 0,
    duration: Number.isFinite(video?.duration) ? video.duration : 0,
    tempo: video?.playbackRate || 1
  };
}

function onEnded() {
  const videoId = videoIdFromUrl(location.href);
  if (videoId) chrome.runtime.sendMessage({ type: 'VIDEO_ENDED', videoId }).catch(() => {});
}

function observe() {
  const video = currentVideo();
  if (video !== observedVideo) {
    observedVideo?.removeEventListener('ended', onEnded);
    observedVideo = video;
    observedVideo?.addEventListener('ended', onEnded);
  }
  const videoId = videoIdFromUrl(location.href);
  if (videoId && videoId !== observedId) {
    observedId = videoId;
    chrome.runtime.sendMessage({ type: 'VIDEO_CHANGED', videoId }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const video = currentVideo();
    switch (message.type) {
      case 'GET_PAGE_STATE': return { ok: true, state: snapshot() };
      case 'SET_TEMPO':
        if (!video) throw new Error('재생 중인 YouTube 영상이 없습니다.');
        video.preservesPitch = true;
        video.playbackRate = Math.max(0.5, Math.min(1.5, Number(message.tempo)));
        await new Promise(resolve => setTimeout(resolve, 120));
        return { ok: true, state: snapshot() };
      case 'PLAY_PAUSE':
        if (!video) throw new Error('재생 중인 YouTube 영상이 없습니다.');
        if (video.paused) await video.play(); else video.pause();
        return { ok: true, state: snapshot() };
      case 'STOP':
        if (video) { video.pause(); video.currentTime = 0; }
        return { ok: true, state: snapshot() };
      default: return { ok: false, error: '알 수 없는 명령입니다.' };
    }
  })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});

document.addEventListener('yt-navigate-finish', observe);
window.addEventListener('popstate', observe);
setInterval(observe, 1000);
observe();
