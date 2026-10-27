import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { App } from '@capacitor/app';
import { IS_NATIVE } from '../lib/native';

export default function NativeBackButton() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!IS_NATIVE) return;
    let listener: { remove: () => Promise<void> } | null = null;

    void App.addListener('backButton', () => {
      const path = window.location.hash.replace(/^#/, '').split('?')[0] || '/';
      if (
        path.startsWith('/read/') ||
        path.startsWith('/book/') ||
        path.startsWith('/comic/') ||
        path.startsWith('/local/')
      ) {
        navigate(-1);
        return;
      }
      if (path === '/settings' || path === '/library') {
        navigate('/home', { replace: true });
        return;
      }
      void App.minimizeApp();
    }).then((handle) => {
      listener = handle;
    });

    return () => {
      void listener?.remove();
    };
  }, [navigate]);

  return null;
}
