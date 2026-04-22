import { runTimelineRegressionSuite } from './regressionSuite';

declare const process: { exitCode?: number };

type CaseResult = {
  name: string;
  ok: boolean;
  message?: string;
};

type FamilyRule = {
  key: string;
  title: string;
  minCases: number;
  match: (name: string) => boolean;
};

type FamilyReport = {
  key: string;
  title: string;
  minCases: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  missingCoverage: boolean;
  caseNames: string[];
};

type MatrixReport = {
  generatedAt: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  coveragePassed: boolean;
  qualityPassed: boolean;
  ok: boolean;
  families: FamilyReport[];
  failed: Array<{ name: string; message: string }>;
};

const FAMILY_RULES: FamilyRule[] = [
  {
    key: 'timeline_editing',
    title: 'Timeline Editing',
    minCases: 8,
    match: (name) => (
      name.includes('transaction')
      || name.startsWith('insert_gap_')
      || name.startsWith('timeline_command_')
      || name === 'project_page_switch_event'
    ),
  },
  {
    key: 'export_consistency',
    title: 'Export Consistency',
    minCases: 3,
    match: (name) => name.startsWith('export_'),
  },
  {
    key: 'clock_audio',
    title: 'Clock + Audio',
    minCases: 7,
    match: (name) => (
      name.startsWith('master_clock_')
      || name.startsWith('audio_playback_')
      || name.startsWith('recording_timeline_clock_')
    ),
  },
  {
    key: 'stroke_pipeline',
    title: 'Stroke Pipeline',
    minCases: 4,
    match: (name) => name.startsWith('stroke_'),
  },
  {
    key: 'whiteboard_interaction',
    title: 'Whiteboard Interaction',
    minCases: 8,
    match: (name) => name.startsWith('whiteboard_'),
  },
  {
    key: 'engine_parity',
    title: 'Engine Parity',
    minCases: 3,
    match: (name) => (
      name === 'native_timeline_adapter_parity'
      || name.startsWith('timeline_command_async_')
    ),
  },
];

const createFamilyReport = (rule: FamilyRule, results: CaseResult[]): FamilyReport => {
  const cases = results.filter((item) => rule.match(item.name));
  const passedCases = cases.filter((item) => item.ok).length;
  const failedCases = cases.length - passedCases;
  return {
    key: rule.key,
    title: rule.title,
    minCases: rule.minCases,
    totalCases: cases.length,
    passedCases,
    failedCases,
    missingCoverage: cases.length < rule.minCases,
    caseNames: cases.map((item) => item.name),
  };
};

const main = async () => {
  const results = await runTimelineRegressionSuite();
  const failed = results.filter((item) => !item.ok);
  const families = FAMILY_RULES.map((rule) => createFamilyReport(rule, results));
  const coveragePassed = families.every((family) => !family.missingCoverage);
  const qualityPassed = failed.length === 0;
  const report: MatrixReport = {
    generatedAt: new Date().toISOString(),
    totalCases: results.length,
    passedCases: results.length - failed.length,
    failedCases: failed.length,
    coveragePassed,
    qualityPassed,
    ok: coveragePassed && qualityPassed,
    families,
    failed: failed.map((item) => ({ name: item.name, message: item.message ?? 'unknown error' })),
  };

  console.log(`Stability Matrix: ${report.ok ? 'PASS' : 'FAIL'} (${report.passedCases}/${report.totalCases})`);
  for (const family of families) {
    const coverageStatus = family.missingCoverage ? 'COVERAGE_MISSING' : 'OK';
    const qualityStatus = family.failedCases > 0 ? 'FAILED_CASES' : 'OK';
    console.log(
      `- ${family.title}: ${family.passedCases}/${family.totalCases} `
      + `[coverage=${coverageStatus}] [quality=${qualityStatus}]`,
    );
  }
  console.log(`ReportJSON: ${JSON.stringify(report)}`);

  if (!report.ok) {
    if (failed.length > 0) {
      for (const item of report.failed) {
        console.error(`FAIL ${item.name}: ${item.message}`);
      }
    }
    const coverageMissing = families.filter((item) => item.missingCoverage);
    if (coverageMissing.length > 0) {
      for (const family of coverageMissing) {
        console.error(
          `COVERAGE ${family.title}: expected >= ${family.minCases}, got ${family.totalCases}`,
        );
      }
    }
    process.exitCode = 1;
  }
};

void main();
