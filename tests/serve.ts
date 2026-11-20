// Standalone forge server for the local test scripts (tests/interop.sh).
// Not part of the entry: main.ts remains the harness lifecycle. The token is
// set before app.ts is imported because the app reads it at module load.
//
//   FORGE_PORT=18799 FORGE_TOKEN=probe-token node tests/serve.ts
process.env.MAKEFUN_SHOP_TOKEN = process.env.FORGE_TOKEN ?? 'probe-token';
const { createApp } = await import('../app.ts');
const server = createApp();
const port = Number(process.env.FORGE_PORT ?? '18799');
await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
process.stdout.write(`forge on http://127.0.0.1:${port}\n`);
