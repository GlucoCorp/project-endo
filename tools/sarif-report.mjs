#!/usr/bin/env node
// Free stand-in for GitHub code-scanning alerts (repo has no Code Security licence).
// Reads SARIF files from CodeQL, Semgrep and similar tools, then:
//   - prints each finding to the log,
//   - emits `::error file=…,line=…::` workflow commands, which GitHub shows as inline annotations
//     on the PR diff and the checks page,
//   - appends a Markdown table to the job summary ($GITHUB_STEP_SUMMARY),
//   - exits 1 if there is any finding (the scan stays a blocking check).
// Usage: node tools/sarif-report.mjs <title> <file.sarif> [more.sarif …]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const [title = 'Scan', ...files] = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: sarif-report.mjs <title> <file.sarif>…');
  process.exit(2);
}

// Workflow-command values must escape %, CR, LF (and , : in properties).
const esc = (s) => String(s).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const escProp = (s) => esc(s).replaceAll(':', '%3A').replaceAll(',', '%2C');
const cell = (s) => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');

const findings = [];
for (const file of files) {
  if (!existsSync(file)) {
    // The scanner crashed or never ran. Fail loudly: a missing report is not a clean report.
    console.log(`::error title=${escProp(title)}::SARIF report not found: ${esc(file)}`);
    process.exit(2);
  }
  const sarif = JSON.parse(readFileSync(file, 'utf8'));
  for (const run of sarif.runs ?? []) {
    const tool = run.tool?.driver?.name ?? 'scanner';
    for (const r of run.results ?? []) {
      const loc = r.locations?.[0]?.physicalLocation;
      findings.push({
        tool,
        rule: r.ruleId ?? 'unknown-rule',
        file: loc?.artifactLocation?.uri ?? '(unknown file)',
        line: loc?.region?.startLine ?? 1,
        message: (r.message?.text ?? '').split('\n')[0],
      });
    }
  }
}

for (const f of findings) {
  console.log(`${f.tool} ${f.rule}: ${f.file}:${f.line} ${f.message}`);
  console.log(
    `::error file=${escProp(f.file)},line=${f.line},title=${escProp(`${f.tool}: ${f.rule}`)}::${esc(f.message)}`,
  );
}

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const lines = [
    `### ${title}: ${findings.length === 0 ? 'no findings' : `${findings.length} finding(s)`}`,
    '',
  ];
  if (findings.length > 0) {
    lines.push('| Tool | Rule | Location | Message |', '|---|---|---|---|');
    for (const f of findings) {
      lines.push(
        `| ${cell(f.tool)} | \`${cell(f.rule)}\` | \`${cell(f.file)}:${f.line}\` | ${cell(f.message)} |`,
      );
    }
  }
  appendFileSync(summary, `${lines.join('\n')}\n\n`);
}

console.log(`${title}: ${findings.length} finding(s)`);
process.exit(findings.length === 0 ? 0 : 1);
