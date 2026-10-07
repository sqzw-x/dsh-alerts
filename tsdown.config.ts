import { defineConfig } from 'tsdown'

/**
 * Two artifacts, matching how the shipped `ui-*` bundles are produced:
 *
 *  - `lib/index.js`  — the host loader entry (plain ESM).
 *  - `lib/client.js` — the browser bundle, wrapped in the lazy-CJS factory the
 *    Harness page's module table calls (`window.__ModuleLoader__.load`). The
 *    wrapper is a banner/footer pair because the factory body *is* the module:
 *    it receives `require`, owns `module`/`exports`, and returns its exports.
 *  - `lib/engine.js` — the rules as a standalone ESM module, so they can be
 *    unit-tested (and reused) without a browser.
 */
const ID = 'dsh-alerts'

const banner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;`

const footer = `\t\treturn module.exports;
\t}
});`

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: true,
    clean: true,
    // Harness types are consumed from the registry, never inlined into the
    // published .d.ts.
    deps: { neverBundle: [/^@deepseek-ai\//] },
    // Same `.js` naming the shipped packages use, so `exports` stays truthful.
    outExtensions: () => ({ js: '.js' })
  },
  {
    entry: { engine: 'src/engine.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'neutral',
    dts: true,
    deps: { neverBundle: [/^@deepseek-ai\//] }
  },
  {
    entry: { client: 'src/client.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    // The bundle is loaded by the page's module table, never by Node, so the
    // CJS body is emitted as a plain `.js` that the wrapper above owns.
    outExtensions: () => ({ js: '.js' }),
    outputOptions: { banner, footer }
  }
])
