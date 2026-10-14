'use strict';
// A stand-in for the `claude` binary, used by tests/cli.test.js through a
// tiny shell shim. It records what it was given (argv, cwd, stdin and its
// environment) to FAKE_CLAUDE_RECORD, then answers the way Claude Code does
// with --output-format stream-json, per FAKE_CLAUDE_MODE. Grayout passes the
// child only an allowlist of variables, so the shim sets those two itself.
const fs = require('fs');
const { spawn } = require('child_process');

const mode = process.env.FAKE_CLAUDE_MODE || 'ok';
const print = o => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const record = {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin: input,
    pid: process.pid,
    env: { ...process.env }
  };
  delete record.env.FAKE_CLAUDE_MODE;
  delete record.env.FAKE_CLAUDE_RECORD;
  if (mode === 'hang') {
    // A grandchild in the same process group, which the hard kill must take down too.
    const grand = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    record.grandchildPid = grand.pid;
  }
  if (process.env.FAKE_CLAUDE_RECORD) fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify(record));

  const images = (() => {
    try { return JSON.parse(input.trim()).message.content.filter(b => b.type === 'image').length; } catch { return 0; }
  })();
  const usage = { input_tokens: 2086, cache_creation_input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 53 };

  print({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], model: 'claude-haiku-4-5' });
  if (mode === 'ok' || mode === 'overage') {
    print('some stray line that is not JSON');
    print({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1792011600, isUsingOverage: mode === 'overage' } });
    const verdict = { off_task: false, activity: `code editor (${images} images)`, confidence: 'high' };
    print({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(verdict) }] } });
    print({ type: 'result', subtype: 'success', is_error: false, result: '```json\n' + JSON.stringify(verdict) + '\n```', usage, total_cost_usd: 0.0024 });
    process.exit(0);
  }
  if (mode === 'limit') {
    print({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792011600 } });
    print({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm (America/New_York)", usage: { input_tokens: 0, output_tokens: 0 } });
    process.exit(1);
  }
  if (mode === 'auth') {
    print({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' });
    process.exit(1);
  }
  if (mode === 'garbage') {
    process.stderr.write('Error: something exploded before any result\n');
    process.exit(2);
  }
  if (mode === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'flood') {
    // More output than any real check: Grayout must cut it off.
    const line = 'x'.repeat(1024 * 1024) + '\n';
    const more = () => { while (process.stdout.write(line)) {} process.stdout.once('drain', more); };
    more();
    return;
  }
  process.exit(3);
});
