import { useEffect, useRef, useState } from 'react';
import { modelUrl, imageUrl } from '../lib/media.js';

/**
 * The agent's 3D asset is rendered with <model-viewer>. The viewer uses a
 * conservative configuration for wallet-extension compatibility:
 *
 *   - v3.5, never v4: v4's WebGPU path dies under MetaMask's SES lockdown,
 *     and this page can be open next to a wallet extension.
 *   - environment-image="neutral" or PBR materials render invisible.
 *   - exposure 2 + tone-mapping commerce for legible brightness on dark bg.
 *
 * The library (~700KB with its bundled three.js) is imported dynamically on
 * mount, so pages without a 3D asset never pay for it.
 *
 * The caller decides who may render this: the page gates it on the
 * verdict's ownership check, because the asset belongs to the TOKEN, and an
 * agent whose claim to that token could not be attributed must not wear it.
 */
export default function AgentModel({ media, alt = '' }) {
  const src = modelUrl(media?.animationUrl);
  const poster = imageUrl(media?.image);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    let cancelled = false;
    import('@google/model-viewer')
      .then(() => { if (!cancelled) setReady(true); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onError = () => setFailed(true);
    el.addEventListener('error', onError);
    return () => el.removeEventListener('error', onError);
  }, [ready]);

  if (!src) return null;
  if (failed || !ready) {
    // Poster while loading, poster forever on failure: a broken scene never
    // renders as a broken page.
    return poster
      ? <img className="agent-model agent-model-fallback" src={poster} alt={alt} />
      : (failed ? null : <div className="agent-model agent-model-loading" aria-hidden="true" />);
  }

  return (
    <model-viewer
      ref={ref}
      class="agent-model"
      src={src}
      poster={poster ?? undefined}
      alt={alt}
      camera-controls=""
      auto-rotate=""
      autoplay=""
      environment-image="neutral"
      exposure="2"
      tone-mapping="commerce"
      shadow-intensity="1"
      shadow-softness="1"
      loading="lazy"
    />
  );
}
