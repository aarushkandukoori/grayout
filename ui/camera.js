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
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
  window.grayout.sendFrame(dataUrl.split(',')[1]);
});
