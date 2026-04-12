import { runTimelineRegressionSuite } from './regressionSuite';

declare const process: { exitCode?: number };

const main = async () => {
  const results = await runTimelineRegressionSuite();
  const failed = results.filter((item) => !item.ok);

  for (const result of results) {
    if (result.ok) {
      console.log(`PASS ${result.name}`);
    } else {
      console.error(`FAIL ${result.name}: ${result.message ?? 'unknown error'}`);
    }
  }

  if (failed.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(`Timeline regression suite passed (${results.length} cases).`);
  }
};

void main();
