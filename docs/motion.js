/*
 * Grayout home page motion: the hero mock storyboard, card internals, the
 * color/gray slider, and scroll-linked touches. Decoration only: no network,
 * no state that matters. Every loop stops when it is off screen, when the tab
 * is hidden, or when someone presses "Pause animations" (app.js keeps that
 * switch), and nothing loops under prefers-reduced-motion.
 */
(function () {
  'use strict';

  var G = window.Grayout || {
    reduced: function () { return false; },
    isStill: function () { return false; },
    onStill: function () {}
  };
  var REDUCED = G.reduced();
  function $(s, c) { return (c || document).querySelector(s); }
  function $$(s, c) { return Array.prototype.slice.call((c || document).querySelectorAll(s)); }
  var hasIO = 'IntersectionObserver' in window;

  /* A repeating storyboard: [ms, fn] steps, restarted every `period` ms. */
  function storyboard(steps, period, reset) {
    var timers = [], running = false;
    function clear() { timers.forEach(clearTimeout); timers = []; }
    function run() {
      clear();
      if (reset) reset();
      steps.forEach(function (s) { timers.push(setTimeout(s[1], s[0])); });
      timers.push(setTimeout(run, period));
    }
    return {
      start: function (delay) {
        if (running) return;
        running = true;
        if (delay) timers.push(setTimeout(run, delay)); else run();
      },
      stop: function () { if (!running) return; running = false; clear(); if (reset) reset(); }
    };
  }

  /* Start a loop while `el` is at least `threshold` visible and the tab is shown. */
  var watched = [];
  function whileVisible(el, loop, threshold, firstDelay) {
    if (!el) return;
    var item = { el: el, loop: loop, visible: false, started: false };
    watched.push(item);
    if (!hasIO) { item.visible = true; if (!G.isStill()) loop.start(firstDelay || 0); return; }
    new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        item.visible = e.isIntersecting;
        if (item.visible && !document.hidden && !G.isStill()) { loop.start(item.started ? 0 : (firstDelay || 0)); item.started = true; }
        else loop.stop();
      });
    }, { threshold: threshold || 0.4 }).observe(el);
  }
  function resumeAll() {
    watched.forEach(function (w) {
      if (document.hidden || G.isStill()) w.loop.stop();
      else if (w.visible) { w.loop.start(w.started ? 0 : 600); w.started = true; }
    });
  }
  document.addEventListener('visibilitychange', resumeAll);
  G.onStill(resumeAll);

  function once(el, threshold, fn) {
    if (!el) return;
    if (!hasIO) { fn(); return; }
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { io.disconnect(); fn(); } });
    }, { threshold: threshold || 0.3 });
    io.observe(el);
  }

  function retrigger(node, cls, ms) {
    node.classList.remove(cls);
    void node.offsetWidth; // restart the CSS animation
    node.classList.add(cls);
    setTimeout(function () { node.classList.remove(cls); }, ms);
  }

  // D9: word-by-word "streamed" text.
  function stream(node, text) {
    node.textContent = '';
    var words = text.split(' ');
    words.forEach(function (w, i) {
      var s = document.createElement('span');
      s.className = 'sw';
      s.textContent = w;
      s.style.setProperty('animation-delay', (i * 35) + 'ms');
      node.appendChild(s);
      if (i < words.length - 1) node.appendChild(document.createTextNode(' '));
    });
  }

  /* ---------------- hero mock (storyboard B, 14 s) ---------------- */
  function heroMock() {
    var mock = $('[data-mock]');
    if (!mock) return;
    var status = $('[data-gm-status]', mock);
    var line = $('[data-gm-line]', mock);
    var TRANSIENT = ['is-feed', 'is-feed-out', 'is-gray', 'is-return', 'is-menu', 'is-menu-out', 'is-hover', 'is-sweep', 'is-pop', 'is-ripple'];

    if (REDUCED) {
      mock.setAttribute('data-state', 'off');
      status.textContent = 'Off task';
      line.textContent = 'social media feed';
      return;
    }

    function reset() {
      mock.classList.add('no-tr');
      TRANSIENT.forEach(function (c) { mock.classList.remove(c); });
      mock.setAttribute('data-state', 'watch');
      status.textContent = 'Watching';
      line.textContent = 'code editor and terminal';
      void mock.offsetWidth;
      mock.classList.remove('no-tr');
    }
    function sweep() { retrigger(mock, 'is-sweep', 950); setTimeout(function () { retrigger(mock, 'is-pop', 320); }, 250); }
    function strike(n) { mock.setAttribute('data-state', n === 1 ? 's1' : 's2'); retrigger(mock, 'is-ripple', 520); }

    var loop = storyboard([
      [2000, function () { mock.classList.add('is-feed'); }],
      [3500, sweep],
      [4400, function () { strike(1); }],
      [5600, sweep],
      [6500, function () { strike(2); }],
      [6900, function () { mock.classList.add('is-gray'); mock.setAttribute('data-state', 'off'); }],
      [7600, function () { stream(status, 'Off task'); stream(line, 'social media feed'); mock.classList.add('is-menu'); }],
      [8600, function () { mock.classList.add('is-hover'); }],
      [9400, function () { mock.classList.remove('is-menu', 'is-hover'); mock.classList.add('is-menu-out', 'is-feed-out'); }],
      [10200, function () { mock.classList.add('is-return'); mock.setAttribute('data-state', 'watch'); }],
      [11200, function () {
        mock.classList.add('no-tr');
        mock.classList.remove('is-gray', 'is-return', 'is-feed', 'is-feed-out', 'is-menu-out');
        status.textContent = 'Watching';
        line.textContent = 'code editor and terminal';
        void mock.offsetWidth;
        mock.classList.remove('no-tr');
      }]
    ], 14000, reset);
    whileVisible(mock, loop, 0.25, 2600);
  }

  /* ---------------- scroll-linked hero (G1, G2) ---------------- */
  function scrollHero() {
    if (REDUCED || !window.matchMedia('(min-width: 1024px)').matches) return;
    var hero = $('.hero'), sky = $('.hero__sky'), sun = $('.hero__sun'), mock = $('[data-mock]');
    if (!hero || !sky) return;
    sky.style.setProperty('will-change', 'filter');
    var ticking = false, last = -1;
    function update() {
      ticking = false;
      var p = Math.min(1, Math.max(0, window.scrollY / (hero.offsetHeight * 0.7)));
      if (Math.abs(p - last) < 0.002) return;
      last = p;
      sky.style.setProperty('filter', p > 0 ? 'saturate(' + (1 - 0.85 * p).toFixed(3) + ')' : 'none');
      if (sun) sun.style.setProperty('opacity', (1 - 0.7 * p).toFixed(3));
      if (mock) mock.style.setProperty('transform', p > 0 ? 'rotateX(' + (6 * p).toFixed(2) + 'deg) scale(' + (1 - 0.04 * p).toFixed(4) + ')' : 'none');
    }
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  }

  /* ---------------- card 1: countdown + day strip (D1, D2, D3) ---------------- */
  function timerCard() {
    var box = $('[data-timer]');
    if (!box) return;
    var num = $('[data-timer-num]', box), strip = $('[data-strip]', box), phrase = $('[data-timer-phrase]', box);
    var N = 28, OFF = { 16: 1, 17: 1 };
    var WORK = ['code editor and terminal', 'docs and outline', 'research paper PDF', 'spreadsheet', 'code editor and terminal'];
    var blocks = [];
    for (var i = 0; i < N; i++) { var b = document.createElement('i'); strip.appendChild(b); blocks.push(b); }

    function fill(k, animate) {
      var b = blocks[k];
      b.className = OFF[k] ? 'off line' : 'ok';
      if (animate) { b.classList.add('pop'); }
      phrase.textContent = OFF[k] ? 'social media feed' : WORK[k % WORK.length];
    }
    if (REDUCED) { for (var j = 0; j < N; j++) fill(j, false); num.textContent = '00:45'; phrase.textContent = 'code editor and terminal'; return; }

    // The countdown runs about 16x real speed (one "second" every 60 ms), so a
    // new block lands every 2.7 s. Half the day is already filled in when the
    // card first appears, so the two red blocks arrive while someone is looking.
    var PREFILL = 14;
    var t = null, sec = 45, k = 0;
    function restart() {
      blocks.forEach(function (b) { b.className = ''; });
      for (k = 0; k < PREFILL; k++) fill(k, false);
    }
    restart();
    function tick() {
      sec--;
      if (sec < 0) {
        if (k >= N) restart();
        fill(k, true); k++;
        sec = 45;
      }
      num.textContent = '00:' + (sec < 10 ? '0' : '') + sec;
    }
    whileVisible(box, {
      start: function () { if (!t) t = setInterval(tick, 60); },
      stop: function () { clearInterval(t); t = null; }
    }, 0.4);
  }

  /* ---------------- card 2: strike pips, then gray (D6, D7; 7 s) ---------------- */
  function strikesCard() {
    var box = $('[data-strikes]');
    if (!box) return;
    var pips = $$('.pip', box), wrap = $('.miniwrap', box);
    if (REDUCED) { pips.forEach(function (p) { p.classList.add('is-on'); }); wrap.classList.add('is-gray'); return; }
    function reset() { pips.forEach(function (p) { p.classList.remove('is-on', 'is-ripple'); }); wrap.classList.remove('is-gray'); }
    function hit(i) { pips[i].classList.add('is-on'); retrigger(pips[i], 'is-ripple', 520); }
    whileVisible(box, storyboard([
      [600, function () { hit(0); }],
      [1800, function () { hit(1); }],
      [2300, function () { wrap.classList.add('is-gray'); }],
      [5300, reset]
    ], 7000, reset), 0.4);
  }

  /* ---------------- dashboard day strip (D3) ---------------- */
  function dayBar() {
    var bar = $('[data-daybar]');
    if (!bar) return;
    var OFF = { 5: 1, 11: 1, 12: 1, 20: 1, 21: 1 }, LINE = { 11: 1, 12: 'end', 20: 1, 21: 'end' };
    for (var i = 0; i < 28; i++) {
      var b = document.createElement('i');
      if (OFF[i]) b.classList.add('off');
      if (LINE[i]) { b.classList.add('line'); if (LINE[i] === 'end') b.classList.add('end'); }
      b.style.setProperty('transition-delay', (i * 40) + 'ms');
      bar.appendChild(b);
    }
    if (REDUCED) return;
    bar.classList.add('is-anim');
    once(bar, 0.5, function () { bar.classList.add('is-in'); });
  }

  /* ---------------- verdict rows ---------------- */
  function verdicts() {
    var v = $('.vis-verdicts');
    if (!v) return;
    if (REDUCED) { v.classList.add('is-in'); return; }
    once(v, 0.4, function () { v.classList.add('is-in'); });
  }

  /* ---------------- color/gray slider (D4, D5) ---------------- */
  function compare() {
    var box = $('[data-compare]');
    if (!box) return;
    var cmp = $('.cmp', box), range = $('[data-compare-range]', box);
    var touched = false;
    function set(v) { cmp.style.setProperty('--pos', v + '%'); }
    set(range.value);
    range.addEventListener('input', function () { touched = true; set(range.value); });
    range.addEventListener('pointerdown', function () { touched = true; box.classList.add('is-drag'); });
    window.addEventListener('pointerup', function () { box.classList.remove('is-drag'); });
    if (REDUCED) return;
    // cubic-bezier(.4,0,0,1), sampled numerically
    function ease(x) {
      var lo = 0, hi = 1, t = x;
      for (var i = 0; i < 20; i++) {
        t = (lo + hi) / 2;
        var bx = 3 * (1 - t) * (1 - t) * t * 0.4 + t * t * t;
        if (bx < x) lo = t; else hi = t;
      }
      return 3 * (1 - t) * t * t + t * t * t;
    }
    once(box, 0.5, function () {
      var keys = [50, 70, 30, 50], seg = 1600 / 3, start = null;
      setTimeout(function () {
        function frame(ts) {
          if (touched) return;
          if (start === null) start = ts;
          var e = ts - start, i = Math.min(2, Math.floor(e / seg));
          var local = Math.min(1, (e - i * seg) / seg);
          var v = keys[i] + (keys[i + 1] - keys[i]) * ease(local);
          set(v.toFixed(2)); range.value = Math.round(v);
          if (e < 1600) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      }, 200);
    });
  }

  /* ---------------- menu cycle + keycaps (D8) ---------------- */
  function menuCycle() {
    var box = $('[data-menucycle]');
    if (!box) return;
    var main = $$('[data-mc]', box), sub = $$('[data-ms]', box), keys = $$('[data-kc]', box);
    if (REDUCED) return;
    box.classList.add('is-anim');
    var STEPS = [
      { m: 0, s: 0 }, { m: 0, s: 1 }, { m: 0, s: 2 }, { m: 0, s: 3 },
      { m: 1 }, { m: 2, k: [0, 1] }, { m: 3 }, { m: 4, k: [2, 3] }
    ];
    var i = 0, t = null;
    function show(step) {
      main.forEach(function (r, j) { r.classList.toggle('is-sel', j === step.m); });
      sub.forEach(function (r, j) { r.classList.toggle('is-sel', step.s === j); });
      box.classList.toggle('is-sub', step.s !== undefined);
      if (step.k) {
        step.k.forEach(function (n) { keys[n].classList.add('is-down'); });
        setTimeout(function () { keys.forEach(function (n) { n.classList.remove('is-down'); }); }, 260);
      }
    }
    whileVisible(box, {
      start: function () { if (t) return; show(STEPS[i % STEPS.length]); t = setInterval(function () { i++; show(STEPS[i % STEPS.length]); }, 1600); },
      // Stopped (off screen or paused): rest on the first step, with the
      // Pause submenu open, so a paused card still shows what it is about.
      stop: function () { clearInterval(t); t = null; i = 0; show(STEPS[0]); }
    }, 0.4);
  }

  /* ---------------- marquee pauses off screen ---------------- */
  function marquee() {
    var m = $('.marquee');
    if (!m || !hasIO) return;
    new IntersectionObserver(function (es) {
      es.forEach(function (e) { m.classList.toggle('is-paused', !e.isIntersecting); });
    }).observe(m);
  }

  /* ---------------- screenshot pipeline (D10, 6 s) ---------------- */
  function pipeline() {
    var host = $('[data-pipe]');
    if (!host || REDUCED) return;
    var pipe = $('.pipe', host);
    function reset() { pipe.classList.remove('s1', 's2', 's3', 's4', 's5'); }
    pipe.classList.add('is-anim');
    whileVisible(host, storyboard([
      [300, function () { pipe.classList.add('s1'); }],
      [900, function () { pipe.classList.add('s2'); }],
      [1500, function () { pipe.classList.remove('s1'); pipe.classList.add('s3'); }],
      [2100, function () { pipe.classList.remove('s2', 's3'); pipe.classList.add('s4'); }],
      [3000, function () { pipe.classList.add('s5'); }],
      [5400, reset]
    ], 6000, reset), 0.35);
  }

  /* ---------------- "Preview the gray" attention pulse (F4) ---------------- */
  function nudge() {
    var chip = $('.preview-chip');
    if (!chip || REDUCED) return;
    once(chip, 0.8, function () { setTimeout(function () { if (!G.isStill()) chip.classList.add('is-nudge'); }, 2600); });
  }

  [heroMock, scrollHero, timerCard, strikesCard, dayBar, verdicts, compare, menuCycle, marquee, pipeline, nudge]
    .forEach(function (fn) { try { fn(); } catch (e) { if (window.console) console.error('grayout motion:', e); } });
})();
