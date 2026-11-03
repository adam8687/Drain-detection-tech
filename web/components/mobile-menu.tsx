'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import styles from './mobile-menu.module.css';

export default function MobileMenu({ children }: { children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    }
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  return <details ref={menu} className={styles.menu} onKeyDown={event => {
    if (event.key === 'Escape' && menu.current?.open) {
      menu.current.open = false;
      menu.current.querySelector('summary')?.focus();
    }
  }}>
    <summary aria-label="Navigation menu">
      <span className={styles.icon} aria-hidden="true"><span /><span /><span /></span>
    </summary>
    <nav aria-label="Mobile navigation" onClick={event => {
      if ((event.target as HTMLElement).closest('a') && menu.current) menu.current.open = false;
    }}>{children}</nav>
  </details>;
}
