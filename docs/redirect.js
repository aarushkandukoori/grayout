/* install.html moved to download.html. Keep old deep links working. */
(function () {
  var map = {
    brew: 'homebrew', drag: 'step-drag', 'first-launch': 'first-run', allow: 'step-allow',
    'screen-recording': 'step-screen', start: 'step-setup', done: 'step-preview',
    'stuck-gray': 'stuck', verify: 'verify', source: 'source', updating: 'updating', stuck: 'stuck'
  };
  var h = (location.hash || '').slice(1);
  location.replace('download.html' + (map[h] ? '#' + map[h] : (h ? '#' + encodeURIComponent(h) : '')));
})();
