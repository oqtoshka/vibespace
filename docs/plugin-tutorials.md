# Deployment tutorials

Client plugins receive `api.startTour(tour)`, which returns an idempotent close
function. The host also closes the tour when its plugin view is unmounted.
The neutral example is in `examples/tutorial-plugin/`; package that directory
as a normal VibeSpace plugin repository with `manifest.json` at its root.
Installation-specific copy and examples belong in the deployment's own plugin.

```js
const close = api.startTour({
  id: 'first-report',
  version: 1,
  labels: { back: 'Back', next: 'Next', finish: 'Finish', close: 'Close' },
  steps: [
    { title: 'Welcome', body: 'An introductory slide.' },
    { target: 'workspace-files', title: 'Files', body: 'Inspect your results here.' }
  ]
});
```

Titles and bodies are plain text. A target names a stable `data-tour` anchor,
not a CSS selector. Omit it for a centered slide. Missing, hidden or off-screen
anchors produce a centered slide with an explanation; they never block progress.
Currently the host provides `workspace-files` on the file browser toolbar.
Plugins can add anchors to their own elements using the same attribute.

The overlay follows layout changes, blocks background interaction, traps Tab,
closes with Escape, and restores focus. This first API is a guided slideshow:
it does not click controls, execute prompts or switch project/session views.
Plugins must not pretend that a demonstrated action has actually been performed.

Progress is local to the current browser profile and namespaced by plugin, tour
ID and version. Closing resumes the last slide next time; completing restarts
from the beginning next time. Increment the version when changing the sequence.
No prompts, project data or transcript content are stored as tutorial progress.
Cross-device/account progress is not implemented.
