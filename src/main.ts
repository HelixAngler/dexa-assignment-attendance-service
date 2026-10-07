import { createApp } from './app';
import { config } from './config';

export const main = async (): Promise<void> => {
  const app = await createApp();
  await app.listen(config.port);
};

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
