// Copies the workspace-root documents to a pendrive, or anywhere else.
//
// WHY THIS EXISTS (2026-08-26). Only `platform/` is a git repository. Everything
// at the workspace root — WORK_LOG.md, MASTER_PLAN.md (82 KB), the PRDs,
// SYSTEMS_KNOWLEDGE.md — exists in exactly one copy on one laptop. The owner
// already keeps a pendrive and a copy on the Mac at home, which covers the
// disaster case properly. What it does not cover is drift: the copy is only as
// fresh as the last time somebody remembered, and the work log is written to
// every working day.
//
// So this is not a new backup scheme. It is the copy he already makes, as one
// command, into a dated folder so an older version can still be recovered.
//
// Read-only at the source. It never deletes anything at the destination — a
// backup tool that removes files is a way to lose two copies instead of one.
//
// Run:  node scripts/backup-docs.cjs E:
//       node scripts/backup-docs.cjs "D:/Backups"
//       node scripts/backup-docs.cjs            (lists what would be copied)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');   // the workspace root, above platform/
const FOLDER = 'Scent-Platform-Docs';
const target = process.argv[2];

// Sydney, not UTC. toISOString() stamped the folder with YESTERDAY every
// morning before 10am - the test caught it on the first run. The date has to be
// the one the owner is living in, and the one the work log entry carries.
// en-CA gives YYYY-MM-DD, which is also the order the folders should sort in.
const stamp = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const docs = fs.readdirSync(ROOT)
  .filter((f) => f.toLowerCase().endsWith('.md'))
  .map((f) => ({ name: f, size: fs.statSync(path.join(ROOT, f)).size }))
  .sort((a, b) => b.size - a.size);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const total = docs.reduce((s, d) => s + d.size, 0);

if (!docs.length) {
  console.error('\nNothing to copy — no .md files at the workspace root.\n');
  process.exit(1);
}

if (!target) {
  console.log(`\n${docs.length} document(s) at the workspace root, ${kb(total)} in total:\n`);
  docs.forEach((d) => console.log(`  ${kb(d.size).padStart(9)}  ${d.name}`));
  console.log('\nPlug the pendrive in and give this its drive letter, for example:');
  console.log('  node scripts/backup-docs.cjs E:\n');
  process.exit(0);
}

// A missing drive is the normal mistake — the pendrive is not plugged in. Say
// that, rather than creating the folder on the C: drive and reporting success.
if (!fs.existsSync(target)) {
  console.error(`\n${target} is not there. Is the pendrive plugged in?\n`);
  process.exit(1);
}

const dest = path.join(target, FOLDER, stamp);
fs.mkdirSync(dest, { recursive: true });

console.log(`\nCopying ${docs.length} document(s) to ${dest}\n`);
let copied = 0;
for (const d of docs) {
  fs.copyFileSync(path.join(ROOT, d.name), path.join(dest, d.name));
  // Verified rather than assumed: a full or failing drive can accept the call
  // and write nothing, and a backup that lies is worse than no backup.
  const written = fs.statSync(path.join(dest, d.name)).size;
  const ok = written === d.size;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${kb(d.size).padStart(9)}  ${d.name}${ok ? '' : `  — wrote ${kb(written)}`}`);
  if (ok) copied++;
}

const older = fs.readdirSync(path.join(target, FOLDER))
  .filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f) && f !== stamp).sort();

console.log(`\n${copied} of ${docs.length} copied, ${kb(total)}.`);
if (older.length) {
  console.log(`Earlier copies kept on this drive: ${older.slice(-5).join(', ')}${older.length > 5 ? ` (+${older.length - 5} more)` : ''}`);
}
console.log(copied === docs.length ? '' : '\nSomething did not copy. Do not unplug the drive yet.\n');
process.exit(copied === docs.length ? 0 : 1);
