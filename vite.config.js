import fs from 'fs';
import path from 'path';

// Items are files in ./items (one JSON per item), so they can be written both from the Items tab and by hand
// (or by Claude from a prompt). In dev, this plugin serves and saves them, and tells open pages when a file
// changes so the Items tab refreshes live.
const ITEMS = path.resolve('items');
const safeId = (id) => /^[a-z0-9][a-z0-9-]{0,80}$/.test(id);
function itemsPlugin() {
  return {
    name: 'dreamare-items',
    configureServer(server) {
      fs.mkdirSync(ITEMS, { recursive: true });
      server.watcher.add(ITEMS);
      const ping = (file) => { if (file.startsWith(ITEMS)) server.ws.send({ type: 'custom', event: 'items:changed', data: { file: path.basename(file) } }); };
      server.watcher.on('add', ping); server.watcher.on('change', ping); server.watcher.on('unlink', ping);
      server.middlewares.use('/__items', (req, res) => {
        const send = (code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
        const id = decodeURIComponent((req.url || '/').slice(1).split('?')[0]);
        if (req.method === 'GET' && !id) { // every item
          const list = fs.readdirSync(ITEMS).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(ITEMS, f), 'utf8')); } catch (err) { return { id: f.replace(/\.json$/, ''), name: f, error: String(err.message) }; } });
          return send(200, list);
        }
        if (!safeId(id)) return send(400, { error: 'bad item id' });
        const file = path.join(ITEMS, `${id}.json`);
        if (req.method === 'PUT') {
          let body = ''; req.on('data', (c) => { body += c; });
          req.on('end', () => { try { const item = JSON.parse(body); item.id = id; fs.writeFileSync(file, JSON.stringify(item, null, 2) + '\n'); send(200, { ok: true }); } catch (err) { send(400, { error: err.message }); } });
          return;
        }
        if (req.method === 'DELETE') { if (fs.existsSync(file)) fs.unlinkSync(file); return send(200, { ok: true }); }
        send(405, { error: 'method' });
      });
    },
  };
}

export default {
  plugins: [itemsPlugin()],
  build: { target: 'esnext', rollupOptions: { input: { main: 'index.html', scenario: 'scenario.html', names: 'names.html', editor: 'editor.html', slides: 'slides.html', items: 'items.html' } } },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
};
