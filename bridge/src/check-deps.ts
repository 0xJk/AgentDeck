import { execSync } from 'child_process';

interface DepCheck {
  name: string;
  command: string;
  required: boolean;
  installHint: string;
}

const DEPS: DepCheck[] = [
  {
    name: 'claude',
    command: 'claude --version',
    required: true,
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    name: 'sox (rec)',
    command: 'which rec',
    required: false,
    installHint: 'brew install sox',
  },
  {
    name: 'whisper-cli',
    command: 'which whisper-cli',
    required: false,
    installHint: 'brew install whisper-cpp && whisper-cli --download-model large-v3-turbo',
  },
  {
    name: 'whisper-server',
    command: 'which whisper-server',
    required: false,
    installHint: 'brew install whisper-cpp (includes whisper-server)',
  },
];

export function checkDependencies(): { ok: boolean; warnings: string[]; claudeCodeVersion?: string } {
  const warnings: string[] = [];
  let ok = true;
  let claudeCodeVersion: string | undefined;

  for (const dep of DEPS) {
    try {
      if (dep.name === 'claude') {
        const output = execSync(dep.command, { encoding: 'utf-8', timeout: 5000 }).trim();
        claudeCodeVersion = output.match(/^([\d.]+)/)?.[1] ?? undefined;
      } else {
        execSync(dep.command, { stdio: 'ignore' });
      }
    } catch {
      if (dep.required) {
        process.stderr.write(`[agentdeck] ERROR: ${dep.name} not found. Install: ${dep.installHint}\n`);
        ok = false;
      } else {
        warnings.push(`${dep.name} not found — ${dep.installHint}`);
      }
    }
  }

  return { ok, warnings, claudeCodeVersion };
}
