#!/usr/bin/env node
// Free stand-in for GitHub code-scanning alerts (repo has no Code Security licence).
// Reads SARIF files from CodeQL, Semgrep and similar tools, then:
//   - prints each finding to the log,
//   - emits `::error file=…,line=…::` workflow commands, which GitHub shows as inline annotations
//     on the PR diff and the checks page,
//   - appends a Markdown table to the job summary ($GITHUB_STEP_SUMMARY),
//   - exits 1 if there is any finding (the scan stays a blocking check), except a finding the
//     team has reviewed and accepted in .github/scan-accepted.json.
//
// An accepted entry names the tool, the rule, the file and the exact (trimmed) source line, with
// a justification and who approved it. It matches only that line's text: if the line changes, the
// finding blocks again. Accepted findings are still printed (as notices). An entry that matches no
// finding fails the run, so the list cannot quietly outlive its reason. Changes to the file are
// reviewed like code (CODEOWNERS covers .github/).
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

const ACCEPTED_FILE = process.env.SCAN_ACCEPTED_FILE ?? '.github/scan-accepted.json';
const FIELDS = ['tool', 'rule', 'file', 'line', 'justification', 'approved_by', 'date'];
const accepted = existsSync(ACCEPTED_FILE) ? JSON.parse(readFileSync(ACCEPTED_FILE, 'utf8')) : [];
if (!Array.isArray(accepted)) {
  console.log(`::error title=${escProp(title)}::${esc(ACCEPTED_FILE)} must be a JSON array`);
  process.exit(2);
}
for (const [i, a] of accepted.entries()) {
  const missing = FIELDS.filter((k) => typeof a?.[k] !== 'string' || a[k].trim() === '');
  if (missing.length > 0) {
    console.log(
      `::error title=${escProp(title)}::${esc(ACCEPTED_FILE)} entry ${i} lacks ${missing.join(', ')}`,
    );
    process.exit(2);
  }
}

/** The trimmed source line a finding points at, or null if it cannot be read. */
const sourceLine = (f) => {
  try {
    return readFileSync(f.file, 'utf8').split(/\r?\n/)[f.line - 1]?.trim() ?? null;
  } catch {
    return null;
  }
};
// Entries are per tool: a run only judges (and requires) entries for the tools it reports.
const tools = new Set(findings.map((f) => f.tool));
const relevant = accepted.filter((a) => tools.has(a.tool) || a.tool === title);
const used = new Set();
const blocking = [];
for (const f of findings) {
  const line = sourceLine(f);
  const match = relevant.findIndex(
    (a) => a.tool === f.tool && a.rule === f.rule && a.file === f.file && a.line.trim() === line,
  );
  if (match >= 0) {
    used.add(match);
    f.accepted = relevant[match];
    console.log(`${f.tool} ${f.rule}: ${f.file}:${f.line} ACCEPTED (${f.accepted.justification})`);
    console.log(
      `::notice file=${escProp(f.file)},line=${f.line},title=${escProp(`${f.tool}: ${f.rule} (accepted)`)}::${esc(f.accepted.justification)}`,
    );
    continue;
  }
  blocking.push(f);
  console.log(`${f.tool} ${f.rule}: ${f.file}:${f.line} ${f.message}`);
  console.log(
    `::error file=${escProp(f.file)},line=${f.line},title=${escProp(`${f.tool}: ${f.rule}`)}::${esc(f.message)}`,
  );
}
const stale = relevant.filter((_, i) => !used.has(i));
for (const a of stale) {
  console.log(
    `::error title=${escProp(title)}::accepted entry matches no finding (remove it): ${esc(`${a.rule} ${a.file}`)}`,
  );
}

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const lines = [
    `### ${title}: ${blocking.length === 0 ? 'no blocking findings' : `${blocking.length} blocking finding(s)`}${findings.length > blocking.length ? `, ${findings.length - blocking.length} accepted` : ''}`,
    '',
  ];
  if (findings.length > 0) {
    lines.push('| Tool | Rule | Location | Message |', '|---|---|---|---|');
    for (const f of findings) {
      const message = f.accepted
        ? `**accepted** (${f.accepted.approved_by}, ${f.accepted.date}): ${f.accepted.justification}`
        : f.message;
      lines.push(
        `| ${cell(f.tool)} | \`${cell(f.rule)}\` | \`${cell(f.file)}:${f.line}\` | ${cell(message)} |`,
      );
    }
  }
  appendFileSync(summary, `${lines.join('\n')}\n\n`);
}

console.log(
  `${title}: ${blocking.length} blocking, ${findings.length - blocking.length} accepted, ${stale.length} stale`,
);
process.exit(blocking.length === 0 && stale.length === 0 ? 0 : 1);
