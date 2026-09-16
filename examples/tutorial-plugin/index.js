export function mount(container, api) {
  const title = document.createElement('h2');
  title.textContent = 'Getting started';
  const button = document.createElement('button');
  button.textContent = 'Explore your workspace';
  button.style.cssText = 'padding:12px;border:1px solid currentColor;border-radius:8px;cursor:pointer';
  button.onclick = () => api.startTour({
    id: 'workspace-basics',
    version: 1,
    steps: [
      { title: 'Your workspace', body: 'Create a project, ask your agent to produce a small report, then inspect the result in Files.' },
      { target: 'workspace-files', title: 'Files', body: 'Browse the files in your project. Open a generated document to preview it.' },
      { title: 'Try it', body: 'Ask your agent: “Create a self-contained HTML dashboard from sample campaign data. Include spend, clicks and conversions, and clearly mark the data as fictional.”' },
    ],
  });
  container.style.padding = '24px';
  container.replaceChildren(title, button);
}

export function unmount(container) {
  container.replaceChildren();
}
