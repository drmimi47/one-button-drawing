import { useEffect, useState } from 'react';

export interface Size {
  width: number;
  height: number;
}

/** Tracks the viewport size, updating on resize (debounced to a frame). */
export function useWindowSize(): Size {
  const [size, setSize] = useState<Size>(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
  }));

  useEffect(() => {
    let frame = 0;
    const handleResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setSize({ width: window.innerWidth, height: window.innerHeight });
      });
    };

    window.addEventListener('resize', handleResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return size;
}
