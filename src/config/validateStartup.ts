import { checkStartupConfig, type StartupConfig } from './startupConfig';

/**
 * Imported by `server.ts` straight after `dotenv/config`, before any module that
 * reads the environment while it loads: a configuration problem stops the process
 * here, with every problem listed, and nothing else has started.
 */
function loadStartupConfig(): StartupConfig {
  const { config, problems } = checkStartupConfig(process.env);
  if (!config) {
    console.error(`[Config] The server cannot start (NODE_ENV=${process.env.NODE_ENV || 'unset'}). Fix the following and start it again:`);
    for (const problem of problems) console.error(`[Config] ${problem}`);
    process.exit(1);
  }
  return config;
}

export const startupConfig: StartupConfig = loadStartupConfig();
