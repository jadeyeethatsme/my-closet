/* Clothing-segmentation worker: keeps model download + inference off the main
   thread so the app stays responsive (iOS kills pages that block too long). */
import { pipeline, RawImage } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

let loader = null;
function load(post) {
  if (!loader) {
    loader = pipeline('image-segmentation', 'Xenova/segformer_b2_clothes', {
      // wasm on purpose: the q8 weights produce garbage output on webgpu
      dtype: 'q8',
      device: 'wasm',
      progress_callback: p => {
        if (p.status === 'progress' && p.file && p.file.endsWith('.onnx')) {
          post({ type: 'progress', pct: Math.round(p.progress || 0) });
        }
      },
    });
    loader.catch(() => { loader = null; });  // allow retry after a failed load
  }
  return loader;
}

self.onmessage = async e => {
  const { id, imageData, width, height } = e.data;
  const post = m => self.postMessage({ id, ...m });
  try {
    const seg = await load(post);
    post({ type: 'status', text: 'analyzing' });
    const img = new RawImage(new Uint8ClampedArray(imageData), width, height, 4);
    const segments = await seg(img);
    post({
      type: 'result',
      segments: segments.map(s => ({
        label: s.label,
        width: s.mask.width,
        height: s.mask.height,
        data: s.mask.data,
      })),
    });
  } catch (err) {
    post({ type: 'error', message: String((err && err.message) || err) });
  }
};
