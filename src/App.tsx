import { useRef } from 'react';
import { InfiniteCanvas, type CanvasHandle } from './components/InfiniteCanvas/InfiniteCanvas';
import { ActionButton } from './components/ActionButton/ActionButton';
import { FpsMeter } from './components/FpsMeter/FpsMeter';
import { DEFAULT_GRID_SIZE } from './constants';

export default function App() {
  // Imperative bridge: the button drives square placement on the canvas without
  // either component re-rendering during interaction.
  const canvasHandle = useRef<CanvasHandle>(null);

  return (
    <>
      <InfiniteCanvas ref={canvasHandle} gridSize={DEFAULT_GRID_SIZE} />
      <ActionButton canvasRef={canvasHandle} />
      {import.meta.env.DEV && <FpsMeter />}
    </>
  );
}
