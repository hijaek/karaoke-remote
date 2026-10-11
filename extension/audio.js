import { SoundTouchNode } from './vendor/soundtouch/SoundTouchNode.js';

let stream = null;
let context = null;
let source = null;
let effect = null;
let capturedTabId = null;
let usingEffect = false;

function applyKey(key) {
  if (!source || !effect || !context) return;
  effect.pitchSemitones.value = key;
  if ((key !== 0) === usingEffect) return;
  source.disconnect();
  source.connect(key === 0 ? context.destination : effect);
  usingEffect = key !== 0;
}

async function stop() {
  const oldStream = stream;
  stream = null;
  capturedTabId = null;
  oldStream?.getTracks().forEach(track => track.stop());
  source?.disconnect();
  effect?.disconnect();
  source = null;
  effect = null;
  usingEffect = false;
  const oldContext = context;
  context = null;
  if (oldContext) await oldContext.close();
}

async function start({ tabId, streamId, key }) {
  await stop();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false
    });
    capturedTabId = tabId;
    const currentStream = stream;
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      if (stream !== currentStream) return;
      stop().then(() => chrome.runtime.sendMessage({ type: 'AUDIO_STOPPED', tabId }).catch(() => {}));
    });
    context = new AudioContext();
    source = context.createMediaStreamSource(stream);
    source.connect(context.destination);
    await SoundTouchNode.register(context, chrome.runtime.getURL('vendor/soundtouch/soundtouch-processor.js'));
    effect = new SoundTouchNode({ context });
    effect.playbackRate.value = 1;
    effect.connect(context.destination);
    applyKey(key);
    await context.resume();
  } catch (error) {
    await stop();
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'audio') return false;
  (async () => {
    switch (message.type) {
      case 'AUDIO_SET':
        if (!effect || (message.tabId != null && capturedTabId !== message.tabId)) return { ok: true, started: false };
        applyKey(message.key);
        return { ok: true, started: true };
      case 'AUDIO_START':
        await start(message);
        return { ok: true, started: true };
      case 'AUDIO_STOP':
        await stop();
        return { ok: true };
      default:
        return { ok: false, error: '알 수 없는 오디오 명령입니다.' };
    }
  })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});
