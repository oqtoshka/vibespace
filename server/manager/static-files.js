import express from 'express';
import fs from 'fs';
import path from 'path';

/**
 * Serves the built SPA from the manager.
 *
 * Mirrors the cache policy of the single-user server (server/index.js): hashed
 * assets are immutable for a year, HTML revalidates every request so a deploy
 * isn't masked by a stale shell.
 */
export function installStaticHandlers(app, appRoot) {
  app.use(express.static(path.join(appRoot, 'public')));

  app.use(
    express.static(path.join(appRoot, 'dist'), {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        } else if (filePath.match(/\.(js|css|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|ico)$/)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );

  // SPA fallback. Paths with an extension are real assets: if express.static
  // didn't serve one, it doesn't exist, and answering with index.html would
  // turn a missing script into a confusing HTML parse error.
  app.get('*', (req, res, next) => {
    if (path.extname(req.path)) return next();

    const indexPath = path.join(appRoot, 'dist', 'index.html');
    if (!fs.existsSync(indexPath)) {
      return res.status(503).send('VibeSpace client build not found. Run `npm run build` first.');
    }

    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(indexPath);
  });
}
