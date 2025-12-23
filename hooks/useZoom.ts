
import { useState, useCallback } from 'react';

export const useZoom = (initial = 1, min = 0.5, max = 2.0, step = 0.25) => {
  const [zoom, setZoom] = useState(initial);

  const zoomIn = useCallback(() => setZoom(z => Math.min(max, z + step)), [max, step]);
  const zoomOut = useCallback(() => setZoom(z => Math.max(min, z - step)), [min, step]);
  const resetZoom = useCallback(() => setZoom(initial), [initial]);
  const setExactZoom = useCallback((z: number) => setZoom(Math.max(min, Math.min(max, z))), [min, max]);

  return { zoom, zoomIn, zoomOut, resetZoom, setExactZoom };
};
