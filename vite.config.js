export default {
  build: { target: 'esnext', rollupOptions: { input: { main: 'index.html', scenario: 'scenario.html', names: 'names.html' } } },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
};
