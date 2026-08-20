import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/gan-schedule/',
  test: {
    exclude: ['tests/**/*.spec.ts', '**/node_modules/**', '**/dist/**'],
  },
});
