import React, { useEffect, useRef } from 'react';
import { initScene } from '../engine/scene.js';

/**
 * RuinedPalaceViewer component
 * Binds to canvas ref, mounts the Three.js Shahi Mahal engine scene,
 * manages loading screen overlay (#ld), sound HUD pill (#snd), and title overlay (#cr).
 * Ensures clean unmount and resource disposal.
 */
export default function RuinedPalaceViewer() {
  const canvasRef = useRef(null);
  const ldRef = useRef(null);
  const barBoxRef = useRef(null);
  const barRef = useRef(null);
  const stRef = useRef(null);
  const sndRef = useRef(null);
  const crRef = useRef(null);

  useEffect(() => {
    let engine = null;
    let disposed = false;

    if (canvasRef.current) {
      initScene({
        canvas: canvasRef.current,
        ld: ldRef.current,
        barBox: barBoxRef.current,
        bar: barRef.current,
        st: stRef.current,
        snd: sndRef.current,
        cr: crRef.current,
      })
        .then((res) => {
          if (disposed) {
            if (res && typeof res.dispose === 'function') {
              res.dispose();
            }
          } else {
            engine = res;
          }
        })
        .catch((err) => {
          console.error('Error initializing scene:', err);
        });
    }

    return () => {
      disposed = true;
      if (engine && typeof engine.dispose === 'function') {
        engine.dispose();
      }
    };
  }, []);

  return (
    <>
      <canvas id="c" ref={canvasRef}></canvas>
      <div id="ld" ref={ldRef}>
        <b>শাহী মহল</b>
        <i>Ruined Mughal-Sultani Fortress Palace · Royal King Cobra (রাজগোখরা) vs. Dragons</i>
        <div id="bar" ref={barBoxRef}>
          <s ref={barRef}></s>
        </div>
        <div id="st" ref={stRef}>
          waking
        </div>
      </div>
      <div id="snd" ref={sndRef}>
        click for sound
      </div>
      <div id="cr" ref={crRef}>
        pure three.js · single-headed royal king cobra (ophiophagus hannah · ফণা তোলা রাজগোখরা) vs. crimson &amp; white dragons · bengali-indian hill tracts, ghats &amp; ruined mughal-sultani palace
      </div>
    </>
  );
}
