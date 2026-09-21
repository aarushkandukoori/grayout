'use strict';
// Optional context: Canvas LMS to-do items and a markdown task file. Both are
// third-party text and are fenced as untrusted data by the analyzer.
const fs = require('fs');

let canvasCache = { at: 0, items: [], error: null };
const CANVAS_TTL_MS = 10 * 60 * 1000;

async function canvasGet(baseUrl, token, route) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/v1${route}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`Canvas ${res.status} on ${route}`);
  return res.json();
}

function fmtDue(dueAt) {
  if (!dueAt) return '';
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return '';
  return ` (due ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })})`;
}

async function fetchCanvasTasks(canvasCfg, token) {
  if (!canvasCfg || !token) return { items: [], error: null };
  if (Date.now() - canvasCache.at < CANVAS_TTL_MS) return canvasCache;

  const items = [];
  let error = null;
  try {
    const todo = await canvasGet(canvasCfg.baseUrl, token, '/users/self/todo?per_page=25');
    for (const t of todo) {
      const a = t.assignment || {};
      const name = a.name || t.title;
      if (name) items.push(`${name}${fmtDue(a.due_at)}`);
    }
    const start = new Date().toISOString().slice(0, 10);
    const planner = await canvasGet(canvasCfg.baseUrl, token, `/planner/items?start_date=${start}&per_page=25`);
    for (const p of planner) {
      const name = p.plannable && (p.plannable.title || p.plannable.name);
      if (name && !items.some(i => i.startsWith(name))) {
        items.push(`${name}${fmtDue(p.plannable.due_at || p.plannable_date)}`);
      }
    }
  } catch (e) {
    error = e.message;
  }
  canvasCache = { at: Date.now(), items: items.slice(0, 20), error };
  return canvasCache;
}

function readTasksFile(tasksFile) {
  if (!tasksFile) return [];
  try {
    const text = fs.readFileSync(tasksFile, 'utf8');
    return text
      .split('\n')
      .map(l => l.match(/^\s*[-*]\s*\[\s\]\s+(.+)/))
      .filter(Boolean)
      .map(m => m[1].trim())
      .slice(0, 20);
  } catch {
    return [];
  }
}

// Returns {canvas: [...], file: [...], canvasError}
async function gatherTasks(config, canvasToken) {
  const canvas = await fetchCanvasTasks(config.canvas, canvasToken);
  return {
    canvas: canvas.items,
    canvasError: canvas.error,
    file: readTasksFile(config.tasksFile)
  };
}

module.exports = { gatherTasks, readTasksFile };
