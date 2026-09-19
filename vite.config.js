import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const base = process.env.VERCEL ? '/' : './';

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        home: 'home.html',
        connect: 'connect.html',
      },
    },
  },
  server: {
    port: 5173,
    open: true,
  },
});

