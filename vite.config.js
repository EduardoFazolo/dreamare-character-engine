export default {
  build: { target: 'esnext', rollupOptions: { input: { main: 'index.html', scenario: 'scenario.html', names: 'names.html', editor: 'editor.html' } } },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
};
