// A stand-in for "the customer's service" that the monitoring E2E test watches.
//   GET /health          -> responds with the current status code (default 200)
//   GET /__set?status=NNN -> changes that status code (used by the test to start/end an outage)
//   GET /__ready          -> readiness probe for Playwright
import http from 'node:http';

let status = 200;

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/__ready') return res.writeHead(200).end('ready');
    if (url.pathname === '/__set') {
      const next = Number(url.searchParams.get('status'));
      if (!Number.isInteger(next) || next < 100 || next > 599)
        return res.writeHead(400).end('bad status');
      status = next;
      return res.writeHead(200).end(String(status));
    }
    res.writeHead(status).end();
  })
  .listen(4100, '127.0.0.1', () =>
    process.stdout.write('target server on http://127.0.0.1:4100\n'),
  );
