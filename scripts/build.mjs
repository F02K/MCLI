import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/mcli.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: false,
  legalComments: 'none',
  define: { __MCLI_VERSION__: JSON.stringify(process.env.MCLI_VERSION ?? 'dev') },
});
console.log('Build finished: dist/mcli.js');
