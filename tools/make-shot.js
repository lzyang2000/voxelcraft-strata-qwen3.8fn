/* Dev tool: builds tools/shot.html from index.html so a headless-Chrome
 * screenshot does not depend on requestAnimationFrame advancing.
 * Run `node tools/make-shot.js`, then screenshot shot.html. */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');

const harness = fs.readFileSync(path.join(__dirname, 'shot-harness.js'), 'utf8');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* rebase asset paths for the tools/ subfolder */
html = html.replace(/href="styles\.css"/, 'href="../styles.css"');
html = html.replace(/src="src\//g, 'src="../src/');
html = html.replace(/src="\/src\//g, 'src="../src/');

html = html.replace('</body>',
  '<pre id="out" style="position:fixed;left:0;top:0;z-index:999;margin:0;padding:6px;' +
  'background:#000;color:#0f0;font:11px/1.4 monospace;max-height:100vh;max-width:100vw"></pre>\n' +
  '<script>\n' + harness + '\n</script>\n</body>');

fs.writeFileSync(path.join(__dirname, 'shot.html'), html);
console.log('wrote tools/shot.html (' + html.length + ' bytes)');
