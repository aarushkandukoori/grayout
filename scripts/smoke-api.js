#!/usr/bin/env node
// Production test of the SELF-HOSTED provider path — the escape hatch, not the
// product. The subscription path (api.grayout.app) is covered by the Worker's
// own suite: `npm --prefix server test`.
//
// Usage (BUILD-SPEC §24 step 3):
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/smoke-api.js
// Runs analyzer.testApiKey() — the exact code the watch loop uses — on a synthetic
// 1366x768 "code editor" frame and prints the verdict, token usage and cost.
// Exit 0 only on a successful verdict; 1 when the API path fails (no key, key
// rejected, no credit, network, ...); 2 when the frame cannot be produced.
//
// No Electron involved. The frame ships as scripts/smoke-frame.jpg; if that file is
// missing it is redrawn with Python Pillow (`node scripts/smoke-api.js --regen`
// rewrites it in place). GRAYOUT_MODEL overrides the model (default claude-haiku-4-5).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FRAME_PATH = path.join(__dirname, 'smoke-frame.jpg');
const DEFAULT_MODEL = 'claude-haiku-4-5';

// Pillow drawing of a fake editor: dark background, a tab bar with a filename,
// line-numbered monospace code and a terminal pane. Nothing real is on it.
const FRAME_PY = String.raw`
import sys
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]
W, H = 1366, 768
def font(size, mono=True):
    paths = (['/System/Library/Fonts/SFNSMono.ttf', '/System/Library/Fonts/Menlo.ttc', '/System/Library/Fonts/Monaco.ttf']
             if mono else ['/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc'])
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            pass
    return ImageFont.load_default()
BG, PANEL, BAR = (30, 30, 30), (37, 37, 38), (50, 50, 52)
FG, DIM, KW, STR, FN, CM, NUM = (212, 212, 212), (110, 110, 110), (86, 156, 214), (206, 145, 120), (220, 220, 170), (106, 153, 85), (181, 206, 168)
im = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(im)
ui, mono, small = font(13, False), font(14), font(12)
# title bar + tabs
d.rectangle((0, 0, W, 36), fill=BAR)
for i, c in enumerate([(255, 95, 87), (255, 189, 46), (40, 201, 64)]):
    d.ellipse((14 + i * 20, 12, 26 + i * 20, 24), fill=c)
d.rectangle((220, 0, 372, 36), fill=BG)
d.text((236, 10), 'analyzer.js', font=ui, fill=FG)
d.text((392, 10), 'loop.js', font=ui, fill=DIM)
d.text((462, 10), 'stats.test.js', font=ui, fill=DIM)
# sidebar
d.rectangle((0, 36, 220, H), fill=PANEL)
d.text((16, 48), 'GRAYOUT', font=small, fill=DIM)
tree = ['src', '  analyzer.js', '  capture.js', '  config.js', '  loop.js', '  pricing.js', '  stats.js', 'tests', '  loop.test.js', '  stats.test.js', 'package.json', 'README.md']
for i, t in enumerate(tree):
    d.text((24, 72 + i * 22), t, font=ui, fill=FG if t.strip().endswith('analyzer.js') else (170, 170, 170))
# code
code = [
    [("'use strict';", STR)],
    [('const ', KW), ('fs', FG), (' = ', FG), ('require', FN), ("('fs');", STR)],
    [('const ', KW), ('{ costUsd }', FG), (' = ', FG), ('require', FN), ("('./pricing');", STR)],
    [],
    [('// Anything not exactly true is on-task.', CM)],
    [('function ', KW), ('coerceVerdict', FN), ('(raw) {', FG)],
    [('  ', FG), ('if ', KW), ('(!raw || ', FG), ('typeof ', KW), ("raw !== 'object') ", FG), ('throw new ', KW), ('Error', FN), ("('verdict is not an object');", STR)],
    [('  ', FG), ('return ', KW), ('{', FG)],
    [('    off_task: raw.off_task === ', FG), ('true', KW), (',', FG)],
    [('    activity: ', FG), ('String', FN), ('(raw.activity || ', FG), ("''", STR), (').slice(', FG), ('0', NUM), (', ', FG), ('120', NUM), ('),', FG)],
    [("    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low'", FG)],
    [('  };', FG)],
    [('}', FG)],
    [],
    [('async function ', KW), ('analyzeViaApi', FN), ('(ctx, config, apiKey) {', FG)],
    [('  ', FG), ('if ', KW), ('(!apiKey) ', FG), ('throw new ', KW), ('NoKeyError', FN), ('();', FG)],
    [('  ', FG), ('const ', KW), ('client = ', FG), ('new ', KW), ('Anthropic', FN), ('({ apiKey, timeout: ', FG), ('60000', NUM), (', maxRetries: ', FG), ('1', NUM), (' });', FG)],
    [('  ', FG), ('const ', KW), ('response = ', FG), ('await ', KW), ('client.messages.create({', FG)],
    [('    model: config.model,', FG)],
    [('    max_tokens: ', FG), ('200', NUM), (',', FG)],
    [("    messages: [{ role: 'user', content: buildApiContent(ctx) }]", FG)],
    [('  });', FG)],
    [('  ', FG), ('return ', KW), ('{ verdict: coerceVerdict(extractJson(text)), usage, model };', FG)],
    [('}', FG)],
    [],
    [('module.exports = { analyze, analyzeViaApi, coerceVerdict, testApiKey };', FG)],
]
y = 50
for i, line in enumerate(code):
    d.text((236, y), str(i + 1).rjust(3), font=mono, fill=DIM)
    x = 280
    for text, color in line:
        d.text((x, y), text, font=mono, fill=color)
        x += d.textlength(text, font=mono)
    y += 21
# terminal pane
d.rectangle((220, 596, W, H - 24), fill=PANEL)
d.rectangle((220, 596, W, 620), fill=BAR)
d.text((236, 600), 'TERMINAL', font=small, fill=FG)
d.text((320, 600), 'PROBLEMS', font=small, fill=DIM)
term = ['$ npm test', '> grayout@1.0.0 test', '> node --test tests/', '', '# tests 41', '# pass 41', '# fail 0', '$ ']
for i, t in enumerate(term):
    d.text((236, 628 + i * 15), t, font=small, fill=FG if not t.startswith('#') else NUM)
# status bar
d.rectangle((0, H - 24, W, H), fill=(0, 122, 204))
d.text((12, H - 19), 'main*', font=small, fill=(255, 255, 255))
d.text((W - 260, H - 19), 'Ln 16, Col 41   Spaces: 2   UTF-8   JavaScript', font=small, fill=(255, 255, 255))
im.save(out, 'JPEG', quality=60, optimize=True)
`;

function drawFrame(outPath) {
  const r = spawnSync('python3', ['-', outPath], { input: FRAME_PY, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`could not draw the synthetic frame with python3/Pillow (pip3 install --user pillow):\n${r.stderr || r.stdout}`);
  }
}

function loadFrame(regen) {
  if (regen || !fs.existsSync(FRAME_PATH)) {
    const tmpDir = regen ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'grayout-smoke-'));
    const target = regen ? FRAME_PATH : path.join(tmpDir, 'smoke-frame.jpg');
    try {
      drawFrame(target);
      console.log(`${regen ? 'wrote' : 'drew'} synthetic frame: ${target} (${fs.statSync(target).size} bytes)`);
      return fs.readFileSync(target);
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  return fs.readFileSync(FRAME_PATH);
}

async function main() {
  const regen = process.argv.includes('--regen');
  let frame;
  try {
    frame = loadFrame(regen);
  } catch (e) {
    console.error(`smoke-api: ${e.message}`);
    return 2;
  }
  if (regen && !(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)) return 0;

  const b64 = frame.toString('base64');
  const model = process.env.GRAYOUT_MODEL || DEFAULT_MODEL;
  const key = (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) || '';
  console.log(`frame: ${path.basename(FRAME_PATH)} ${frame.length} bytes (1366x768 JPEG, ${b64.length} base64 chars)`);
  console.log(`model: ${model}`);

  const { testApiKey } = require('../src/analyzer');
  const t0 = Date.now();
  const r = await testApiKey(key, b64, model);
  const ms = Date.now() - t0;

  if (!r.ok) {
    console.error(`smoke-api: FAILED (${r.kind}) after ${ms} ms: ${r.message}`);
    if (r.kind === 'no_key') console.error('set ANTHROPIC_API_KEY in the environment (console.anthropic.com → API keys)');
    return 1;
  }
  console.log(`verdict: ${JSON.stringify(r.verdict)}`);
  console.log(`usage:   ${JSON.stringify(r.usage)}`);
  console.log(`cost:    ${r.costUsd === null ? 'unknown (model not in pricing table)' : '$' + r.costUsd.toFixed(6)} (${r.model}, ${ms} ms)`);
  if (r.verdict.off_task) {
    console.error('smoke-api: the synthetic code editor came back off_task — the prompt or model is wrong');
    return 1;
  }
  return 0;
}

main().then(code => process.exit(code), err => {
  console.error(`smoke-api: unexpected error: ${err && err.stack || err}`);
  process.exit(1);
});
