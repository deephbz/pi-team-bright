import { FileDiff, parseDiffFromFile } from '@pierre/diffs';
import './style.css';

// Read-only projection: the server has no mutation endpoint.
const loading = document.querySelector('#loading');
try {
  const response = await fetch('./review.json');
  if (!response.ok) throw new Error(`Review data returned HTTP ${response.status}`);
  const data = await response.json();
  document.querySelector('#path').textContent = data.path;
  document.querySelector('#base').textContent = `Approved draft ${data.sha256.old.slice(0, 8)}`;
  document.querySelector('#stats').textContent = `+${data.added} / −${data.removed} lines · ${data.words.old} → ${data.words.new} words`;

  const fileDiff = parseDiffFromFile(
    { name: data.path, contents: data.old },
    { name: data.path, contents: data.new },
  );
  const options = {
    diffStyle: 'split', theme: 'pierre-light', themeType: 'light',
    overflow: 'wrap', expandUnchanged: true, lineDiffType: 'word',
    diffIndicators: 'classic', disableFileHeader: true,
    unsafeCSS: ':host { --diffs-font-size: 13px; --diffs-line-height: 22px; }',
  };
  const view = new FileDiff(options);
  view.render({ fileContainer: document.querySelector('#diff'), fileDiff });
  loading.hidden = true;
  document.documentElement.dataset.reviewReady = 'true';

  function update() {
    view.setOptions({ ...options });
    view.rerender();
  }
  for (const style of ['split', 'unified']) {
    document.querySelector(`#${style}`).addEventListener('click', () => {
      options.diffStyle = style;
      document.querySelector('#split').setAttribute('aria-pressed', String(style === 'split'));
      document.querySelector('#unified').setAttribute('aria-pressed', String(style === 'unified'));
      document.querySelector('#sides').hidden = style !== 'split';
      update();
    });
  }
  document.querySelector('#wrap').addEventListener('change', event => {
    options.overflow = event.target.checked ? 'wrap' : 'scroll';
    update();
  });
  document.querySelector('#context').addEventListener('change', event => {
    options.expandUnchanged = event.target.checked;
    update();
  });
  window.addEventListener('pagehide', () => view.cleanUp(), { once: true });
} catch (error) {
  loading.hidden = false;
  loading.textContent = `The diff could not load: ${error.message}`;
  loading.setAttribute('role', 'alert');
  console.error(error);
}
