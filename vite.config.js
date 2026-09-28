import fs from 'fs';
import path from 'path';

// Data that lives as readable files in the repo, so it can be edited both in the app and by hand (or by Claude
// from a prompt): items/, scenes/, library/. In dev, this plugin serves and saves them (GET list, GET/PUT/DELETE
// one) at /__<kind>, and tells open pages when a file changes ("<kind>:changed") so they refresh live.
const KINDS = ['items', 'scenes', 'library'];
const safeId = (id) => /^[a-z0-9][a-z0-9-]{0,80}$/.test(id);
function dataPlugin() {
  return {
    name: 'dreamare-data',
    configureServer(server) {
      for (const kind of KINDS) {
        const dir = path.resolve(kind);
        fs.mkdirSync(dir, { recursive: true });
        server.watcher.add(dir);
        const ping = (file) => { if (file.startsWith(dir + path.sep) && file.endsWith('.json')) server.ws.send({ type: 'custom', event: `${kind}:changed`, data: { file: path.basename(file) } }); };
        server.watcher.on('add', ping); server.watcher.on('change', ping); server.watcher.on('unlink', ping);
        server.middlewares.use(`/__${kind}`, (req, res) => {
          const send = (code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
          const id = decodeURIComponent((req.url || '/').slice(1).split('?')[0]);
          if (req.method === 'GET' && !id) {
            const list = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (err) { return { id: f.replace(/\.json$/, ''), name: f, error: String(err.message) }; } });
            return send(200, list);
          }
          if (!safeId(id)) return send(400, { error: 'bad id' });
          const file = path.join(dir, `${id}.json`);
          if (req.method === 'GET') { if (!fs.existsSync(file)) return send(404, { error: 'not found' }); try { return send(200, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (err) { return send(422, { error: `${kind}/${id}.json is not valid JSON: ${err.message}` }); } }
          if (req.method === 'PUT') {
            let body = ''; req.on('data', (c) => { body += c; });
            req.on('end', () => { try { const data = JSON.parse(body); if (data && typeof data === 'object' && !Array.isArray(data)) data.id = id; fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); send(200, { ok: true }); } catch (err) { send(400, { error: err.message }); } });
            return;
          }
          if (req.method === 'DELETE') { if (fs.existsSync(file)) fs.unlinkSync(file); return send(200, { ok: true }); }
          send(405, { error: 'method' });
        });
      }
    },
  };
}

export default {
  plugins: [dataPlugin()],
  build: { target: 'esnext', rollupOptions: { input: { main: 'index.html', scenario: 'scenario.html', names: 'names.html', editor: 'editor.html', slides: 'slides.html', items: 'items.html' } } },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
};
