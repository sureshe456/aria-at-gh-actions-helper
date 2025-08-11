import * as http from 'node:http';
import ngrok from 'ngrok';
import { githubClient } from './lib/octokit.mts';
import diff from './lib/diff.mts';
import wrap from 'word-wrap';
import pLimit from 'p-limit';
import isEqual from 'lodash.isequal';
import { readFile, writeFile } from 'node:fs/promises';
import { Command, InvalidArgumentError } from '@commander-js/extra-typings';
import { createWriteStream, WriteStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import formatDuration from './lib/formatDuration.mts';

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
const limitWorkflows = pLimit(8);
function parseIntOption(value: string, dummyPrevious: number) {
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new InvalidArgumentError('Not a number.');
  }
  return parsedValue;
}
const defaultTestPlans = [
  'tests/alert',
  'tests/command-button',
  'tests/disclosure-navigation',
  'tests/horizontal-slider',
  'tests/link-span-text',
  'tests/menu-button-actions-active-descendant',
  'tests/menu-button-navigation',
  'tests/modal-dialog',
  'tests/radiogroup-aria-activedescendant',
  'tests/rating-radio-group',
  'tests/toggle-button'
];
function parseTestPlanOption(value: string, previous: string[]) {
  if (!value.startsWith('tests/')) {
    throw new InvalidArgumentError(
      `Test plan specified without "tests/" directory: "${value}"`
    );
  }
  // When parsing a repeatable option, Commander supplies the default value as
  // the initial "previous" value. Without special handling like the one below
  // (which regrettably must rely on Array identity), user-specified values
  // would be appended to the set of defaults.
  if (previous === defaultTestPlans) {
    return [value];
  }
  return previous.concat(value);
}

const program = new Command()
  .requiredOption('-o, --owner <string>', 'repository owner')
  .requiredOption(
    '-r, --repo <string>',
    'repository name',
    'aria-at-gh-actions-helper'
  )
  .option('-b, --branch <string>', 'Git branch', 'main')
  .option(
    '-f, --results-from-file',
    'Load results from json file instead of live collection.'
  )
  .option(
    '-j, --json-output <file>',
    'Write/read results collection data to json file.',
    'stressor-run.json'
  )
  .option(
    '-m, --md-output <file>',
    "Write output in markdown format to file. A value of '-' indicates STDOUT.",
    '-'
  )
  .option(
    '-n, --num-runs <int>',
    'Number of times to run each test plan',
    parseIntOption,
    5
  )
  .option(
    '-p, --port <int>',
    'Port number on which to bind the local results-accepting server',
    parseIntOption,
    8888
  )
  .option(
    '-t, --test-plan <string>',
    'Test plan to run (repeatable)',
    parseTestPlanOption,
    defaultTestPlans
  );
program.parse();
const options = program.opts();
// Rename "options.testPlan" (named for coherence to the CLI user) to
// "testPlans" (named for accuracy of the value type it holds). (Commander
// conflates the name of CLI options with the JavaScript property where the
// corresponding values are stored. This creates tension for repeatable options
// because the final value is a collection composed of many individual input
// values.)
const testPlans = options.testPlan;

// ordered this way because voiceover usually finishes quicker, and when you only
// have 3 jobs left it matters... :)
const testingMatrix = [
  {
    workflowId: 'jaws-test.yml',
    browsers: ['chrome', 'firefox']
  },
  {
    workflowId: 'nvda-test.yml',
    browsers: ['chrome', 'firefox']
  },
  {
    workflowId: 'self-hosted-macos-15.yml',
    browsers: ['safari']
  }
];

const workflowHeaderKey = 'x-workflow-key';

interface WorkflowCallbackPayload {
  status: string;
  capabilities?: Capabilities;
  testCsvRow?: number;
  presentationNumber?: number;
  responses?: Array<string>;
  externalLogsUrl?: string;
}

interface TestCombination {
  workflowId: string;
  workflowBrowser: string;
  workflowTestPlan: string;
}

type WorkflowRunResults = Array<{
  screenreaderResponses: Array<string>;
  testCsvRow: number;
}>;

type Capabilities = {
  atName: string;
  atVersion: string;
  browserName: string;
  browserVersion: string;
  platformName: string;
};

type WorkflowRun = {
  runLogsUrl: string;
  capabilities: Capabilities;
  results: WorkflowRunResults;
};

type ComparisonTestRunDifference = {
  runId: number;
  responses: Array<string>;
};

type ComparisonTestRunResult = {
  testCsvRow: number;
  baselineResponses: Array<string>;
  differences: Array<ComparisonTestRunDifference>;
};

interface ComparisonRunResult {
  totalRows: number;
  equalRows: number;
  unequalRows: number;
  comparedResults: Array<ComparisonTestRunResult>;
}

type CompleteTestComboRunResult = ComparisonRunResult &
  TestCombination & {
    logUrls: Array<string>;
    capabilities: Capabilities;
  };

/**
 * Logs the message to the console if DEBUG is true
 */
const debugLog = (...args: Parameters<typeof console.debug>): void => {
  if (DEBUG) {
    // using console.error to print to STDERR
    console.error('[DEBUG]:', ...args);
  }
};

/*
 * Get a nice human readable string for the given GitHub workflow id
 */
function workflowIdAsLabel(workflowId: string): string {
  switch (workflowId) {
    case 'jaws-test.yml':
      return 'JAWS';
    case 'self-hosted-macos-15.yml':
    case 'voiceover-test.yml':
      return 'VoiceOver';

    case 'nvda-test.yml':
      return 'NVDA';

    default:
      return workflowId;
  }
}

/**
 * Creates a unique key for a workflow run, given the test combo and run index
 * The key is used to identify the callbacks for a given test combo run
 */
function getWorkflowRunKey(combination: TestCombination, runIndex: number) {
  const { workflowId, workflowBrowser, workflowTestPlan } = combination;
  return `${workflowTestPlan}-${workflowId}-${workflowBrowser}-${runIndex}`;
}

/**
 * Creates a string representation of a test combo, for logging and debugging
 */
function testComboToString(combination: TestCombination) {
  const { workflowId, workflowBrowser, workflowTestPlan } = combination;
  return `Test plan: ${workflowTestPlan}, workflow: ${workflowId}, browser: ${workflowBrowser}`;
}

/**
 * Creates a list of test combinations, given the testing matrix and test plans
 */
function enumerateTestCombinations(
  matrix: typeof testingMatrix,
  testPlans: string[]
): Array<TestCombination> {
  return matrix.flatMap(({ workflowId, browsers }) =>
    browsers.flatMap(browser =>
      testPlans.map(testPlan => ({
        workflowId,
        workflowBrowser: browser,
        workflowTestPlan: testPlan
      }))
    )
  );
}

/**
 * Sets up a listener on the node server for a single run of a test combo.
 * @returns a promise that resolves when the workflow run is complete.
 */
async function setUpTestComboCallbackListener(
  testCombination: TestCombination,
  runIndex: number
) {
  const promise = new Promise<WorkflowRun>(resolvePromise => {
    const uniqueWorkflowHeaderValue = `${getWorkflowRunKey(
      testCombination,
      runIndex
    )}`;
    const results: WorkflowRunResults = [];
    let capabilities: Capabilities;
    const requestListener = (
      req: http.IncomingMessage,
      res: http.ServerResponse
    ) => {
      let body = '';
      if (req.headers?.[workflowHeaderKey] === uniqueWorkflowHeaderValue) {
        req.on('data', chunk => {
          body += chunk.toString();
        });

        req.on('end', () => {
          const parsedBody: WorkflowCallbackPayload = JSON.parse(body);

          if (parsedBody.status === 'COMPLETED') {
            debugLog(
              `${getWorkflowRunKey(testCombination, runIndex)}: received\n${body}`
            );
            // if results are included, then we collect them
            // if not, then we assume this is a status update and the test plan is done
            if (parsedBody.capabilities !== undefined) {
              capabilities = parsedBody.capabilities;
            }
            if (parsedBody.responses !== undefined) {
              results.push({
                screenreaderResponses: parsedBody.responses,
                testCsvRow:
                  parsedBody.testCsvRow ?? parsedBody.presentationNumber ?? -1
              });
            } else {
              const runLogsUrl =
                parsedBody.externalLogsUrl ?? 'url not collected';
              debugLog(
                `Workflow run ${getWorkflowRunKey(
                  testCombination,
                  runIndex
                )} finished.`
              );
              resolvePromise({ results, runLogsUrl, capabilities });
              server.removeListener('request', requestListener);
            }
          } else if (parsedBody.status === 'ERROR') {
            // BELL in case the terminal supports it
            process.stderr.write('\u0007');
            console.error(
              '[ERROR]:',
              `${getWorkflowRunKey(testCombination, runIndex)}: received\n${body}`
            );
          }
          res.end();
        });
      }
    };
    server.on('request', requestListener);
    debugLog(
      `Workflow run ${getWorkflowRunKey(testCombination, runIndex)} listener started.`
    );
  });

  return promise;
}

/**
 * Dispatches a workflow run on GitHub Actions for a single test combo.
 * @returns true if successful, false otherwise.
 */
async function dispatchWorkflowForTestCombo(
  testCombo: TestCombination,
  runIndex: number
): Promise<boolean> {
  const { workflowId, workflowTestPlan, workflowBrowser } = testCombo;
  try {
    await githubClient.actions.createWorkflowDispatch({
      owner: options.owner,
      repo: options.repo,
      workflow_id: workflowId,
      ref: options.branch,
      inputs: {
        work_dir: workflowTestPlan,
        browser: workflowBrowser,
        callback_url: ngrokUrl,
        status_url: ngrokUrl,
        callback_header: `${workflowHeaderKey}:${getWorkflowRunKey(
          testCombo,
          runIndex
        )}`
      }
    });
    debugLog(`Dispatched ${testComboToString(testCombo)} Run #${runIndex}`);
    return true;
  } catch (e) {
    console.error(
      `Run ${runIndex} of ${testComboToString(testCombo)} failed to dispatch.`
    );
    console.error(e);
    return false;
  }
}

/**
 * Find the most common set of screenreader responses for each test in this set of runs
 * In other words, it finds the most for results of the same testCsv number
 * within this collection of run results.
 *
 * @returns a synthetic results array where each element is the mode for its csvRow
 */
function findMostCommonRunResults(
  runs: ReadonlyArray<WorkflowRun>
): WorkflowRunResults {
  // Group responses by testCsvRow
  const groupedResponses: Map<number, Array<Array<string>>> = new Map();

  runs.forEach(run => {
    run.results.forEach(row => {
      if (!groupedResponses.has(row.testCsvRow)) {
        groupedResponses.set(row.testCsvRow, []);
      }
      groupedResponses.get(row.testCsvRow)!.push(row.screenreaderResponses);
    });
  });

  // Find mode for each testCsvRow
  const modeResponses: WorkflowRunResults = Array.from(
    groupedResponses.entries()
  ).map(([testCsvRow, responses]) => {
    const mode = findMode(responses);
    return {
      testCsvRow,
      screenreaderResponses: mode
    };
  });

  return modeResponses;
}

function findMode(arr: Array<Array<string>>): Array<string> {
  const counts = new Map<string, number>();
  let maxCount = 0;
  let mode: Array<string> = [];

  arr.forEach(item => {
    const key = JSON.stringify(item);
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);

    if (count > maxCount) {
      maxCount = count;
      mode = item;
    }
  });

  return mode;
}

/**
 * Checks the results in a set of workflow runs for population and equality
 * @returns An object with percentages of populated and equal results
 */
function checkRunSetResults(runs: Array<WorkflowRun>): ComparisonRunResult {
  let totalRows = 0;
  let equalRows = 0;

  const comparisonWorkflowRunResults = findMostCommonRunResults(runs);
  const comparedResults: Array<ComparisonTestRunResult> = [];
  comparisonWorkflowRunResults.forEach(compTest => {
    const { testCsvRow, screenreaderResponses: baselineResponses } = compTest;
    const differences: Array<ComparisonTestRunDifference> = [];
    runs.forEach((run, i) => {
      totalRows++;
      const resultResponses =
        run.results.findLast(l => l.testCsvRow === compTest.testCsvRow)
          ?.screenreaderResponses ?? [];
      if (isEqual(resultResponses, baselineResponses)) {
        equalRows++;
      } else {
        differences.push({ runId: i, responses: resultResponses });
      }
    });
    comparedResults.push({ testCsvRow, baselineResponses, differences });
  });

  return {
    comparedResults,
    totalRows: totalRows,
    equalRows: equalRows,
    unequalRows: totalRows - equalRows
  };
}

const dispatchAndListen = async (
  testCombo: TestCombination,
  runIndex: number
): Promise<WorkflowRun> => {
  const dispatched = await dispatchWorkflowForTestCombo(testCombo, runIndex);
  if (dispatched) {
    return await setUpTestComboCallbackListener(testCombo, runIndex);
  } else {
    throw new Error('dispatch failed');
  }
};

const spawnAndCollectWorkflows = async (
  testCombo: TestCombination
): Promise<CompleteTestComboRunResult> => {
  const runPromises: Array<Promise<WorkflowRun>> = [];
  for (let runIndex = 0; runIndex < options.numRuns; runIndex++) {
    runPromises.push(
      limitWorkflows(() => dispatchAndListen(testCombo, runIndex))
    );
  }
  // Wait to get all results from parallel runs of the same test combo
  const runResults = await Promise.all(runPromises);
  // Check if all the results are good
  const runResultStats = checkRunSetResults(runResults);
  const comboResult: CompleteTestComboRunResult = {
    ...testCombo,
    ...runResultStats,
    logUrls: runResults.map(run => run.runLogsUrl),
    capabilities: runResults[0].capabilities
  };
  debugLog(`${testComboToString(testCombo)} done`, comboResult);
  allResults.set(testCombo, comboResult);
  return comboResult;
};

// Get all the test combos
const testCombinations = enumerateTestCombinations(testingMatrix, testPlans);
debugLog('Test Plans:\n', testPlans);
debugLog('Testing Matrix:\n', testingMatrix);
debugLog(
  `Will dispatch ${
    testCombinations.length
  } test combinations ${options.numRuns} times, for a total of ${
    testCombinations.length * options.numRuns
  } workflow runs.`
);

const server = http.createServer();
server.listen(options.port);
debugLog(`Local server started at port ${options.port}`);
server.setMaxListeners(50);

const ngrokUrl = await ngrok.connect({
  port: options.port
});
debugLog(`Ngrok tunnel started at ${ngrokUrl}`);

process.on('beforeExit', code => {
  server.close();
  ngrok.kill();
  console.error('Exiting with code: ', code);
});

const allResults: Map<TestCombination, CompleteTestComboRunResult> = new Map();

const fetchFailedRuns = async () => {
  const workflowIds = [
    ...new Set(testCombinations.map(combo => combo.workflowId))
  ];
  const failedRuns = await Promise.all(
    workflowIds.map(async workflow_id => {
      const response = await githubClient.actions.listWorkflowRuns({
        owner: options.owner,
        repo: options.repo,
        workflow_id,
        status: 'failure'
      });
      return response.data.workflow_runs;
    })
  );
  return failedRuns.flat();
};

if (options.resultsFromFile) {
  const data = JSON.parse(await readFile(options.jsonOutput, 'utf-8'));
  for (const [key, value] of data) {
    allResults.set(key, value);
  }
} else {
  const failedRunsAtStart = new Set(
    (await fetchFailedRuns()).map(run => run.id)
  );

  let logStatusTimeout: string | NodeJS.Timeout;
  const logStatus = async () => {
    // write direct to stderr to not get piped to markdown output.
    process.stderr.write(
      `Workflow queue status: ${limitWorkflows.activeCount} active, ${limitWorkflows.pendingCount} pending.\n`
    );
    const failed = (await fetchFailedRuns()).filter(
      run => !failedRunsAtStart.has(run.id)
    );
    for (var run of failed) {
      process.stderr.write(
        `Restarting failed run ${run.name}#${run.run_number}: ${run.html_url}\n`
      );
      await githubClient.actions.reRunWorkflow({
        owner: options.owner,
        repo: options.repo,
        workflow_id: run.workflow_id,
        run_id: run.id
      });
    }
    if (logStatusTimeout != 'stop') {
      logStatusTimeout = setTimeout(logStatus, 60000);
    }
  };
  logStatusTimeout = setTimeout(logStatus, 60000);

  try {
    // Step through testPlans, waiting for those CI runs to finish before the next begin
    await Promise.all(
      testPlans.flatMap(testPlan => {
        // Filter the list of test combos to only those for this test plan
        const testCombosForTestPlan = testCombinations.filter(
          testCombo => testCombo.workflowTestPlan === testPlan
        );
        // For each test plan, run each test combo in parallel
        return testCombosForTestPlan.map(spawnAndCollectWorkflows);
      })
    );
  } finally {
    clearTimeout(logStatusTimeout);
    logStatusTimeout = 'stop';
  }

  // Debug helper: write the needed "allResults" for this run to a json file
  await writeFile(
    options.jsonOutput,
    JSON.stringify([...allResults.entries()]),
    'utf-8'
  );
}

const outputStream = new PassThrough({ highWaterMark: 0 });
let fileStream;
if (options.mdOutput === '-') {
  outputStream.pipe(process.stdout);
} else {
  fileStream = createWriteStream(options.mdOutput, 'utf-8');
  outputStream.pipe(fileStream);
}

const output = async (text: string) => {
  let headRoomAvailable = outputStream.write(`${text}\n`);
  if (!headRoomAvailable) {
    await new Promise(resolve => outputStream.once('drain', resolve));
  }
};

const formatResultsForMD = async (
  results: Map<TestCombination, CompleteTestComboRunResult>
) => {
  const keys = [...results.keys()];
  const values = [...results.values()];

  const scoring = {
    workflowTestPlan: [
      ...new Set(keys.map(key => key.workflowTestPlan))
    ].sort(),
    workflowId: [...new Set(keys.map(key => key.workflowId))].sort(),
    workflowBrowser: [...new Set(keys.map(key => key.workflowBrowser))].sort()
  };
  // generate a distinct ordering score for keys
  // browser - least significant
  // workflow - next most
  // test plan - most significant
  const score = (key: TestCombination) =>
    scoring.workflowBrowser.indexOf(key.workflowBrowser) +
    scoring.workflowId.indexOf(key.workflowId) *
      scoring.workflowBrowser.length +
    scoring.workflowTestPlan.indexOf(key.workflowTestPlan) *
      scoring.workflowId.length *
      scoring.workflowBrowser.length;
  keys.sort((a, b) => score(a) - score(b));

  await output(`# Stress Test Run - Completed ${new Date().toISOString()}\n`);

  const generalSummary = values.reduce(
    (memo, result) => {
      return {
        totalRuns: memo.totalRuns + result.totalRows,
        totalEqual: memo.totalEqual + result.equalRows
      };
    },
    { totalRuns: 0, totalEqual: 0 }
  );

  await output(`* __Total Tests:__ ${generalSummary.totalRuns}`);
  await output(
    `* __Total Equal %:__ ${((generalSummary.totalEqual * 100) / generalSummary.totalRuns).toFixed(2)}%`
  );
  await output(`* __Number of runs per combo:__ ${options.numRuns}`);
  await output(`* __Test Plans:__\n`);
  for (const plan of testPlans) {
    await output(`  * ${plan}`);
  }
  await output(`\n* __Test Matrix:__\n`);
  for (const entry of testingMatrix) {
    await output(`  * ${entry.workflowId}`);
    for (const browser of entry.browsers) {
      await output(`    * ${browser}`);
    }
  }

  const ats: Map<string, Set<string>> = new Map();
  const browsers: Map<string, Set<string>> = new Map();
  for (const { capabilities } of values) {
    let set = ats.get(capabilities.atName);
    if (!set) {
      set = new Set();
      ats.set(capabilities.atName, set);
    }
    set.add(capabilities.atVersion);
    set = browsers.get(capabilities.browserName);
    if (!set) {
      set = new Set();
      browsers.set(capabilities.browserName, set);
    }
    set.add(capabilities.browserVersion);
  }
  await output(`* __Versions Used:__ \n`);
  for (const pair of ats) {
    await output(`  * __${pair[0]}__: ${[...pair[1]].join(', ')}`);
  }
  for (const pair of browsers) {
    await output(`  * __${pair[0]}__: ${[...pair[1]].join(', ')}`);
  }

  type GenerateBy = (arg0: CompleteTestComboRunResult) => string;
  type Formatter = (arg0: string) => string;
  const generateSummary = async (
    displayTitle: string,
    by: GenerateBy,
    formatter: Formatter = identity => identity
  ) => {
    await output(`\n## Summary by ${displayTitle}\n`);
    await output(
      `| ${displayTitle} | Total Tests | Equal Responses | Equal % |`
    );
    await output('| --- | --- | --- | --- |');
    const allKeys = new Set(values.map(by));
    for (const key of allKeys) {
      const { totalRuns, totalEqual } = values
        .filter(result => by(result) === key)
        .reduce(
          (memo, result) => {
            return {
              totalRuns: memo.totalRuns + result.totalRows,
              totalEqual: memo.totalEqual + result.equalRows
            };
          },
          { totalRuns: 0, totalEqual: 0 }
        );
      await output(
        `| ${formatter(key)} | ${totalRuns} | ${totalEqual} | ${((totalEqual * 100) / totalRuns).toFixed(2)}% |`
      );
    }
  };

  await generateSummary('Test Plan', result => result.workflowTestPlan);
  await generateSummary('AT', result => result.workflowId, workflowIdAsLabel);
  await generateSummary('Browser', result => result.workflowBrowser);

  const generateHeaderTextForCombo = (combo: TestCombination): string =>
    `${combo.workflowTestPlan} ${workflowIdAsLabel(combo.workflowId)} ${combo.workflowBrowser}`;

  const generateHeaderLinkForCombo = (combo: TestCombination): string =>
    '#' +
    generateHeaderTextForCombo(combo)
      .replace(/[^\s\w-]/g, '')
      .replace(/\s+/g, '-')
      .toLowerCase();

  await output(`\n## Summary by All\n`);
  await output(
    `| Test Plan | AT | Browser | Total Tests | Equal Responses | Equal % | Heading Link |`
  );
  await output('| --- | --- | --- | --- | --- | --- | --- |');
  for (const combo of keys) {
    const comboResults = results.get(combo);
    // typescript insists this is possibly undefined
    if (comboResults) {
      await output(
        `| ${comboResults.workflowTestPlan} | ${workflowIdAsLabel(comboResults.workflowId)} | ${comboResults.workflowBrowser} | ${comboResults.totalRows} | ${comboResults.equalRows} | ${((comboResults.equalRows * 100) / comboResults.totalRows).toFixed(2)}% | [#](${generateHeaderLinkForCombo(combo)}) |`
      );
    }
  }

  const formatResponses = (
    responses: Array<string>,
    newlineTab: string = '\n    '
  ): string =>
    responses
      .map((response, index) => {
        const responseWrapped = response
          .split('\n')
          .map(line => wrap(line, { width: 60, newline: newlineTab }))
          .join(newlineTab);
        return `Response ${index + 1}:${newlineTab}${responseWrapped}`;
      })
      .join('\n')
      .replace(/\n(\s*\n)+/g, '\n');

  for (const combo of keys) {
    const comboResults = results.get(combo);
    // typescript insists this is possibly undefined
    if (comboResults) {
      await output(`\n## ${generateHeaderTextForCombo(combo)}\n`);
      await output(
        `AT: ${comboResults.capabilities?.atName} ${comboResults.capabilities?.atVersion}`
      );
      await output(
        `Browser: ${comboResults.capabilities?.browserName} ${comboResults.capabilities?.browserVersion}`
      );
      await output(`Platform: ${comboResults.capabilities.platformName}`);
      await output(`\n### Run Logs\n`);
      let logNumber = 0;
      for (const url of comboResults.logUrls) {
        const runId = url.slice(url.lastIndexOf('/') + 1);
        const { data } = await githubClient.actions.getWorkflowRunUsage({
          owner: options.owner,
          repo: options.repo,
          run_id: parseInt(runId, 10)
        });
        const runTime = data.run_duration_ms ?? 0;

        const {
          data: { run_attempt: attemptNumber = 1 }
        } = await githubClient.actions.getWorkflowRun({
          owner: options.owner,
          repo: options.repo,
          run_id: parseInt(runId, 10)
        });
        const retries = attemptNumber - 1;
        const retriesText = retries > 0 ? ` - ${retries} retries` : '';
        await output(
          `* [Run #${logNumber++}](${url}) - ${formatDuration(runTime)}${retriesText}`
        );
      }
      for (const comparedResult of comboResults.comparedResults) {
        await output(`\n### Test Number: ${comparedResult.testCsvRow}\n`);
        await output(
          `__${combo.workflowTestPlan} ${workflowIdAsLabel(combo.workflowId)} ${combo.workflowBrowser}__`
        );
        await output(`#### Most Common Responses:`);
        await output('```');
        await output(formatResponses(comparedResult.baselineResponses));
        await output('```');
        for (const diverges of comparedResult.differences) {
          await output(
            `#### Divergent responses from [Run ${diverges.runId}](${comboResults.logUrls[diverges.runId]}):`
          );
          await output('```diff');
          await output(
            diff(
              formatResponses(comparedResult.baselineResponses),
              formatResponses(diverges.responses)
            )
          );
          await output('```');
        }
      }
    }
    await output(``);
  }
};

await formatResultsForMD(allResults);

await new Promise((resolve, reject) => {
  outputStream.on('finish', resolve);
  outputStream.on('error', reject);
  outputStream.end();
});
if (fileStream) {
  await new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
    fileStream.end();
  });
}
if (options.mdOutput != '-') {
  console.log(`Wrote markdown report to ${options.mdOutput}`);
}

process.exit(0);
