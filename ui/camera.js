'use strict';
const video = document.getElementById('v');
const canvas = document.getElementById('c');
let ready = false;

async function start() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    video.srcObject = stream;
    await video.play();
    ready = true;
    window.grayout.sendStatus('ok');
  } catch (e) {
    window.grayout.sendStatus('denied: ' + (e && e.message ? e.message : 'camera unavailable'));
  }
}
start();

window.grayout.onRequestFrame(() => {
  if (!ready || video.videoWidth === 0) { window.grayout.sendFrame(null); return; }
  // The camera was asked for 640x480, but that is only a wish: some cameras
  // answer bigger. The Grayout service refuses any image wider than 1366 px or
  // taller than 2732 px (API contract 6.11), so shrink a big frame to fit.
  const scale = Math.min(1, 1366 / video.videoWidth, 2732 / video.videoHeight);
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
  window.grayout.sendFrame(dataUrl.split(',')[1]);
});
