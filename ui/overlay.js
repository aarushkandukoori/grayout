'use strict';
const frame = document.getElementById('frame');
window.grayout.onMode(({ alert }) => { frame.classList.toggle('alert', !!alert); });
