import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router.tsx';
import './global.css';

// Spec 14: the app shell works offline (the service worker never caches /v1 responses).
if ('serviceWorker' in navigator)
  void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
