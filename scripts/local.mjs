import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import worker from '../worker.mjs';

const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/mark.svg', ['mark.svg', 'image/svg+xml']]
]);
const migrations = new URL('../migrations/', import.meta.url);
const migration = (await Promise.all((await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()
  .map(file => readFile(new URL(file, migrations), 'utf8')))).join('\n');
const security = Object.fromEntries((await readFile(new URL('../public/_headers', import.meta.url), 'utf8'))
  .trim().split('\n').slice(1).map(line => line.trim().split(/: (.*)/).slice(0, 2)));

export function createDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(migration);
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      return { bind: (...values) => ({
        first: () => statement.get(...values) ?? null,
        all: () => ({ results: statement.all(...values) }),
        run: () => statement.run(...values)
      }) };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.all());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close()
  };
}

export async function startLocal(bindings = {}, port = 0) {
  const db = createDatabase();
  const env = {
    DB: db,
    ASSETS: {
      async fetch(request) {
        const file = publicFiles.get(new URL(request.url).pathname);
        if (!file) return new Response('Not found', { status: 404 });
        return new Response(Readable.toWeb(createReadStream(new URL('../public/' + file[0], import.meta.url))), {
          headers: { ...security, 'Content-Type': file[1] }
        });
      }
    },
    ...bindings
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = new Request('http://localhost:' + server.address().port + incoming.url, {
        method: incoming.method, headers: incoming.headers,
        ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Readable.toWeb(incoming), duplex: 'half' })
      });
      const result = await worker.fetch(request, env);
      for (const [name, value] of result.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
      if (result.headers.has('set-cookie')) outgoing.setHeader('Set-Cookie', result.headers.getSetCookie());
      outgoing.writeHead(result.status);
      if (result.body) Readable.fromWeb(result.body).pipe(outgoing);
      else outgoing.end();
    } catch {
      outgoing.writeHead(500).end();
    }
  });
  server.once('close', () => db.close());
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, 'localhost', resolve));
  return { server, origin: 'http://localhost:' + server.address().port };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { origin } = await startLocal({}, Number(process.env.PORT || 8787));
  console.log(origin);
}
