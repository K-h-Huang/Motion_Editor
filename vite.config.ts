import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Use relative asset paths so dist/ can be hosted under any sub-path.
  base: './',
  server: {
    host: true,
    port: 5173,
    watch: {
      // Avoid Linux inotify ENOSPC failures on machines that also keep large
      // model, motion, or reference datasets open in the workspace.
      usePolling: true,
      interval: 500,
      ignored: [
        // Large asset trees are loaded at runtime or via drag-and-drop, not via Vite HMR.
        '**/ref/**',
        '**/motions/**',
        '**/models/**',
        '**/.cache/**',
        '**/*.lock',
        '**/.venv/**',
        '**/site-packages/**',
      ],
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
