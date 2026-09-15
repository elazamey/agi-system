import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const workspace = resolve(root, 'apps', 'workspace');

console.log('Building packages...');
execSync('pnpm --filter @agi-os/agent-os build', { cwd: root, stdio: 'inherit' });
execSync('pnpm --filter @agi-os/workspace build', { cwd: root, stdio: 'inherit' });

if (!existsSync(resolve(workspace, 'dist'))) {
  console.error('Build failed: dist/ not found');
  process.exit(1);
}

const projectName = process.argv[2] || 'agi-os';
console.log(`Deploying to Cloudflare Pages (project: ${projectName})...`);
execSync(`npx wrangler pages deploy dist --project-name ${projectName}`, {
  cwd: workspace,
  stdio: 'inherit',
});
