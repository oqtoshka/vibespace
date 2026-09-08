import spawn from 'cross-spawn';

import { userDb } from '@/modules/database/index.js';

function systemGit(field: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['config', '--system', '--get', field], { shell: false });
    let output = '';
    child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error('Managed Git identity is unavailable.')));
  });
}

/** The controller supplies Authentik identity outside the tenant workspace.
 * Managed accounts enter their provisioned project without credential/Git prompts.
 */
export async function bootstrapManagedProfile(userId: number): Promise<void> {
  if (process.env.VS_OPENCODE_MANAGED !== 'true') return;
  const [name, email] = await Promise.all([systemGit('user.name'), systemGit('user.email')]);
  if (!name || !email) throw new Error('Managed Git identity is incomplete.');
  userDb.updateGitConfig(userId, name, email);
  userDb.completeOnboarding(userId);
}
