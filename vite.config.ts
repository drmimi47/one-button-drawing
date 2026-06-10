import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev-only endpoint that receives perf beacons from the running app and prints
 * them to the dev server's stdout. This makes live FPS / draw-time observable
 * from the terminal while experimenting on localhost.
 */
function perfLogger(): Plugin {
  return {
    name: 'perf-logger',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__perf', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            const { fps, drawMs } = JSON.parse(body || '{}');
            const ts = new Date().toLocaleTimeString();
            console.log(`[perf ${ts}] ${fps} fps · ${drawMs} ms`);
          } catch {
            // ignore malformed beacons
          }
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), perfLogger()],
});
