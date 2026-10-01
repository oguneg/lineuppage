// Runs the Instagram profile check from this computer and publishes the results.
// Instagram sends lookups from GitHub's servers to its login page, so this can't run as an Action.
//
//   npm run sync-profiles            pull, check new/changed handles, commit + push profiles.json
//   npm run sync-profiles -- --all   same, re-checking every handle

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
const quiet = (cmd, args) => execFileSync(cmd, args, { cwd: root }).toString().trim();

run('git', ['pull', '--rebase', '--autostash', '--quiet', 'origin', 'main']); // latest handles from the site
run(process.execPath, ['scripts/check-profiles.mjs', ...process.argv.slice(2)]);

if (!quiet('git', ['status', '--porcelain', '--', 'public/profiles.json'])) {
  console.log('No changes to publish.');
} else {
  run('git', ['commit', '--quiet', '-m', 'Instagram profile check', '--', 'public/profiles.json']);
  run('git', ['push', '--quiet', 'origin', 'main']);
  console.log('Published profiles.json.');
}
