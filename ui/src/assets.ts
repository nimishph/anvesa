// Each import gives the path of the file, and `bun build --compile` bundles the file into the
// program, so the dashboard is served the same way from a checkout and from a release binary.
import graphCss from '../public/css/graph.css' with { type: 'file' };
import mainCss from '../public/css/main.css' with { type: 'file' };
import searchCss from '../public/css/search.css' with { type: 'file' };
import statusCss from '../public/css/status.css' with { type: 'file' };
import indexHtml from '../public/index.html' with { type: 'file' };
// @ts-expect-error a browser script, imported only for its path
import appJs from '../public/js/app.js' with { type: 'file' };
// @ts-expect-error a browser script, imported only for its path
import graphJs from '../public/js/graph.js' with { type: 'file' };
// @ts-expect-error a browser script, imported only for its path
import mockDataJs from '../public/js/mock-data.js' with { type: 'file' };
// @ts-expect-error a browser script, imported only for its path
import searchJs from '../public/js/search.js' with { type: 'file' };
// @ts-expect-error a browser script, imported only for its path
import statusJs from '../public/js/status.js' with { type: 'file' };

/**
 * Every file the dashboard serves, by URL path. Nothing outside this table is ever read, so a
 * request cannot reach any other file whatever its path says.
 */
export const ASSETS: ReadonlyMap<string, string> = new Map([
  ['/index.html', indexHtml],
  ['/css/graph.css', graphCss],
  ['/css/main.css', mainCss],
  ['/css/search.css', searchCss],
  ['/css/status.css', statusCss],
  ['/js/app.js', appJs],
  ['/js/graph.js', graphJs],
  ['/js/mock-data.js', mockDataJs],
  ['/js/search.js', searchJs],
  ['/js/status.js', statusJs],
]);
